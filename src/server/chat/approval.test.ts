// Tests of asking the user before code runs in a tainted chat, and of what a
// reply with sandbox tools sends and stores: the files a run shows in the chat,
// the files the model shares, and the runs for the sandbox panel. The model is
// a script of turns; the code container and the scanners are stand-ins.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileCard } from "@/lib/files";
import type { ToolStep } from "@/lib/types";
import { prisma } from "@/server/db/prisma";
import { createAuditLog } from "@/server/security/audit";
import { markFalsePositive, openSecurity } from "@/server/security/engine";
import { answerPause } from "@/server/security/pause";
import { resetScanners } from "@/server/security/scan";
import { getToolDefinition } from "@/server/tools/definitions";
import { addMessage, eventsOf, newConversation, newUser } from "@/test/db";
import { fakes } from "@/test/fakes";
import { DISPLAY_MESSAGE_SELECT, sharedIds, toDisplayMessages } from "./display";
import { createAssistantReply } from "./conversation";
import { runToolLoop, type ModelTurn } from "./toolLoop";

vi.mock("@/server/tools/mcp", () => import("@/test/fakes"));
vi.mock("@/server/security/clamd", () => import("@/test/fakes"));

const tools = ["run_code", "install_packages", "share_file"].map((name) => getToolDefinition(name)!);
const runPython = (code: string) => ({ name: "run_code", arguments: { language: "python", code } });

/**
 * A chat with a model that makes `turns` and then answers; with `tainted`,
 * flagged text is in it already (`flagId`), which with `falsePositive` the
 * user marked a false positive.
 */
async function chat(turns: ModelTurn["calls"][], { tainted = false, falsePositive = false } = {}) {
  const userId = await newUser();
  const conversationId = await newConversation(userId);
  await addMessage(conversationId, { role: "user", content: "Work on it" });
  let flagId: string | null = null;
  if (tainted) {
    flagId = await addMessage(conversationId, {
      role: "tool",
      content: "Withheld",
      toolCallId: "old",
      toolName: "web_read",
      metadata: { label: "x", error: true, security: { flag: "injection", score: 0.9, ...(falsePositive ? { falsePositive } : {}) } },
    });
  }
  const audit = createAuditLog(userId, conversationId);
  const security = await openSecurity({ userId, conversationId, tools, audit });
  const reply = createAssistantReply({ conversationId, userId, modelKey: "agent:test", model: "ollama:test", setup: {} });
  const lines: (Partial<ToolStep> & { id: string })[] = [];
  const pauses: { id: string; tool: string; source: string; kind?: string }[] = [];
  const files: FileCard[] = [];
  let turn = 0;
  const stopper = new AbortController();
  const done = runToolLoop<ModelTurn>({
    tools,
    maxToolCalls: 7,
    toolContext: { userId, textBudget: 5000, conversationId, vision: false, security },
    reply,
    signal: stopper.signal,
    isCancelled: () => stopper.signal.aborted,
    sendTool: (line) => void lines.push(line),
    sendFiles: (cards) => void files.push(...cards),
    sendPause: (pause) => void pauses.push(pause),
    sendError: () => {},
    nextTurn: async () => {
      const calls = turns[turn++] ?? [];
      const content = calls.length ? "" : "Done.";
      reply.append(content);
      return { content, calls };
    },
    plainTurn: async () => ({ content: "", calls: [] }),
    view: [{ role: "user", content: "Work on it" }],
  })
    .then(() => reply.persist())
    .then(() => audit.flush());
  const paused = () => vi.waitFor(() => expect(pauses.length).toBe(1)).then(() => pauses[0]);
  const rows = () =>
    prisma.message.findMany({ where: { conversationId }, orderBy: { position: "asc" }, select: DISPLAY_MESSAGE_SELECT });
  return { userId, conversationId, flagId, done, stopper, lines, pauses, files, paused, rows };
}

/** The reply of a chat as the chat view shows it after a reload, with the files the model shared. */
async function reloaded(run: { rows: () => Promise<Parameters<typeof toDisplayMessages>[0]> }) {
  const rows = await run.rows();
  const ids = rows.flatMap((r) => sharedIds(r.metadata));
  const shared = await prisma.messageAttachment.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, mimeType: true, size: true } });
  const cards = new Map(shared.map((f) => [f.id, { id: f.id, name: f.name!, mimeType: f.mimeType, size: f.size ?? 0 }]));
  return toDisplayMessages(rows, cards)[1];
}

beforeEach(() => {
  fakes.reset();
  resetScanners();
});

describe("in a tainted chat", () => {
  it("asks before code runs, with the code to look at, and runs it when the user says Run", async () => {
    const run = await chat([[runPython("print(42)")]], { tainted: true });
    const pause = await run.paused();
    expect(pause).toMatchObject({ tool: "call_1_0", kind: "approval" });
    expect(run.lines).toContainEqual({ id: "call_1_0", approval: { detail: "print(42)" } });
    expect(fakes.runs).toEqual([]); // nothing runs before the answer
    // A flagged-content answer does not fit this pause
    expect(answerPause(pause.id, run.userId, "remove")).toBe(false);
    expect(answerPause(pause.id, run.userId, "run")).toBe(true);
    await run.done;
    expect(fakes.runs).toHaveLength(1);
    expect(run.lines.at(-1)).toMatchObject({ state: "done", approval: { decision: "run" } });
    expect(await eventsOf(run.userId)).toContainEqual(
      expect.objectContaining({ tool: "run_code", check: "decision", verdict: "allow", decision: "run" })
    );
  });

  it("goes on without the run when the user says Don't run", async () => {
    const run = await chat([[runPython("print(42)")]], { tainted: true });
    answerPause((await run.paused()).id, run.userId, "skip");
    await run.done;
    expect(fakes.runs).toEqual([]);
    expect(run.lines.at(-1)).toMatchObject({ state: "error", label: "Could not run Python (not run)", approval: { decision: "skip" } });
    const runs = await prisma.sandboxRun.findMany({ where: { conversationId: run.conversationId } });
    expect(runs.map((r) => [r.status, r.code])).toEqual([["skipped", "print(42)"]]);
  });

  it("asks before an install too", async () => {
    const run = await chat([[{ name: "install_packages", arguments: { registry: "pypi", packages: ["tabulate"] } }]], { tainted: true });
    expect((await run.paused()).kind).toBe("approval");
    answerPause(run.pauses[0].id, run.userId, "skip");
    await run.done;
    expect(fakes.installs).toEqual([]);
  });

  it("ends the reply when the chat is stopped while it asks (or nobody answers in time)", async () => {
    const run = await chat([[runPython("x")], [runPython("y")]], { tainted: true });
    const pause = await run.paused();
    // Stop is not an answer the user gives here: it comes from stopping the chat, or the time running out
    expect(answerPause(pause.id, run.userId, "stop")).toBe(false);
    run.stopper.abort();
    await run.done;
    expect(fakes.runs).toEqual([]);
    expect(run.pauses).toHaveLength(1);
  });
});

describe("in a chat whose flag the user marked a false positive", () => {
  it("runs code without asking", async () => {
    const run = await chat([[runPython("print(42)")]], { tainted: true, falsePositive: true });
    await run.done;
    expect(run.pauses).toEqual([]);
    expect(fakes.runs).toHaveLength(1);
  });

  it("stops asking in the reply that asks while the user marks it", async () => {
    const run = await chat([[runPython("x")], [runPython("y")]], { tainted: true });
    const pause = await run.paused();
    expect(await markFalsePositive(run.userId, run.flagId!)).toBe(true);
    answerPause(pause.id, run.userId, "run");
    await run.done;
    // The second run did not ask
    expect(run.pauses).toHaveLength(1);
    expect(fakes.runs).toHaveLength(2);
    expect(await eventsOf(run.userId)).toContainEqual(
      expect.objectContaining({ tool: "web_read", check: "decision", verdict: "allow", reason: "false_positive", conversationId: run.conversationId })
    );
  });

  it("only takes the mark from the chat's own user, for a flagged injection", async () => {
    const run = await chat([], { tainted: true });
    expect(await markFalsePositive(await newUser(), run.flagId!)).toBe(false);
    const plain = await addMessage(run.conversationId, { role: "tool", content: "x", toolCallId: "p", toolName: "web_read", metadata: { error: true, security: { flag: "virus" } } });
    expect(await markFalsePositive(run.userId, plain)).toBe(false);
    expect(await markFalsePositive(run.userId, "no-such-step")).toBe(false);
    await run.done;
  });
});

describe("in a chat that is not tainted", () => {
  it("runs code without asking", async () => {
    const run = await chat([[runPython("print(1)")]]);
    await run.done;
    expect(run.pauses).toEqual([]);
    expect(fakes.runs).toHaveLength(1);
  });
});

describe("what the chat shows of a run", () => {
  it("shows the images, SVG and HTML a run made, and the files the model shared; other files only in the sandbox", async () => {
    fakes.run = { changed: { "plot.png": "png", "page.html": "<p>hi</p>", "logo.svg": "<svg/>", "data.csv": "a" } };
    const run = await chat([[runPython("...")], [{ name: "share_file", arguments: { file: "data.csv" } }]]);
    await run.done;
    expect(run.files.map((f) => f.name)).toEqual(["plot.png", "page.html", "logo.svg", "data.csv"]);

    // After a reload, the same
    const reply = await reloaded(run);
    expect(reply.files?.map((f) => f.name)).toEqual(["plot.png", "page.html", "logo.svg", "data.csv"]);
    const runs = await prisma.sandboxRun.findMany({ where: { conversationId: run.conversationId } });
    expect(runs).toHaveLength(1);
  });

  it("shows a file once, as its newest version, when runs change it and the model shares it", async () => {
    fakes.run = { changed: { "plot.png": "png" } };
    const run = await chat([[runPython("first")], [runPython("again")], [{ name: "share_file", arguments: { file: "plot.png" } }]]);
    await run.done;
    const versions = await prisma.messageAttachment.findMany({
      where: { message: { conversationId: run.conversationId }, name: "plot.png" },
      orderBy: { message: { position: "asc" } },
    });
    expect(versions).toHaveLength(2);
    const reply = await reloaded(run);
    expect(reply.files?.map((f) => f.id)).toEqual([versions[1].id]);
    // The model is told the user sees it
    const [result] = (await run.rows()).filter((r) => r.toolName === "run_code");
    expect(result.content).toContain("The user sees these in the chat below your reply, so do not share them or write links to them: plot.png.");
    expect(result.content).toContain("To show it within your reply's text instead, write ![caption](plot.png).");
  });

  it("shows nothing of a deleted file, nor its deletion", async () => {
    fakes.run = { changed: { "a.png": "png" } };
    const run = await chat([[runPython("make")]]);
    await run.done;
    fakes.run = { deleted: ["a.png"] };
    await prisma.message.create({
      data: {
        conversationId: run.conversationId,
        position: 99,
        role: "tool",
        content: "deleted",
        toolCallId: "z",
        toolName: "run_code",
        attachments: { create: { name: "a.png", mimeType: "application/octet-stream", data: Buffer.alloc(0), deleted: true } },
      },
    });
    const [, reply] = toDisplayMessages(await run.rows());
    expect(reply.files?.map((f) => f.name)).toEqual(["a.png"]); // the version the run made, which the chat showed
    expect(JSON.stringify(reply)).not.toContain('"deleted"');
  });
});
