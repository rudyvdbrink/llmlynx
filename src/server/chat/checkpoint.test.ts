// Tests of checkpoints: the one the user asks for with /compact, what goes
// with its summary, taking it back, and what the chat view shows of them.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/db/prisma";
import { createAuditLog } from "@/server/security/audit";
import { createSecurityContext } from "@/server/security/context";
import type { SecuritySession } from "@/server/security/engine";
import { resetScanners } from "@/server/security/scan";
import { getToolDefinition } from "@/server/tools/definitions";
import { addMessage, newConversation, newUser } from "@/test/db";
import { fakes, INJECTION } from "@/test/fakes";
import { createBudget } from "./budget";
import { makeCheckpoint, SummaryFailed, undoCheckpoint, type CheckpointRequest } from "./checkpoint";
import { saveCheckpointStep } from "./conversation";
import { contextFill, DISPLAY_MESSAGE_SELECT, toDisplayMessages } from "./display";
import { loadView, type ViewMessage } from "./view";

vi.mock("@/server/tools/mcp", () => import("@/test/fakes"));
vi.mock("@/server/security/clamd", () => import("@/test/fakes"));

const tools = ["web_read", "read_file", "create_file", "run_code", "read_result", "update_notes"].map((name) => getToolDefinition(name)!);
const NAMES = { tools: tools.map((t) => t.name) };
const NOTE = "Goal: write the report.\nDone: the outline.\nNext: the first chapter.";

beforeEach(() => {
  fakes.reset();
  resetScanners();
});

/** A conversation in which the model read a page, made outline.md and answered. */
async function worked() {
  const userId = await newUser();
  const conversationId = await newConversation(userId);
  await addMessage(conversationId, { role: "user", content: "Write a report about lynxes. Start with an outline." });
  await addMessage(conversationId, { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "web_read", arguments: { url: "https://a.example/lynx" } }] });
  await addMessage(conversationId, {
    role: "tool",
    content: "The lynx is a cat.",
    toolCallId: "c1",
    toolName: "web_read",
    metadata: { label: "Read a.example/lynx", error: false },
  });
  await addMessage(conversationId, {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "c2", name: "create_file", arguments: { name: "outline.md", content: "# Lynxes\n1. Habitat" } }],
  });
  const made = await addMessage(conversationId, {
    role: "tool",
    content: "Created outline.md.",
    toolCallId: "c2",
    toolName: "create_file",
    metadata: { label: "Created outline.md", error: false },
  });
  const outline = Buffer.from("# Lynxes\n1. Habitat");
  await prisma.messageAttachment.create({ data: { messageId: made, name: "outline.md", mimeType: "text/markdown", data: outline, size: outline.length } });
  await addMessage(conversationId, { role: "assistant", content: "The outline is in outline.md." });
  const security: SecuritySession = { userId, context: createSecurityContext(), audit: createAuditLog(userId, conversationId) };
  const asked: ViewMessage[][] = [];
  const request = async (more: Partial<CheckpointRequest> = {}) => ({
    conversationId,
    view: await loadView(conversationId, NAMES),
    budget: createBudget(32_000, tools),
    by: "user" as const,
    tools,
    security,
    signal: new AbortController().signal,
    ask: async (messages: ViewMessage[]) => {
      asked.push(messages);
      return NOTE;
    },
    store: (summary: string, meta: Parameters<typeof saveCheckpointStep>[2]) => saveCheckpointStep(conversationId, summary, meta),
    ...more,
  });
  const shown = async () => {
    const rows = await prisma.message.findMany({ where: { conversationId }, orderBy: { position: "asc" }, select: DISPLAY_MESSAGE_SELECT });
    return { messages: toDisplayMessages(rows), fill: contextFill(rows) };
  };
  return { conversationId, security, asked, request, shown, made };
}

describe("a compaction the user asks for", () => {
  it("covers the whole conversation: the facts as stored, the model's own note, and what it needs to go on", async () => {
    const chat = await worked();
    const request = await chat.request({ keep: "the outline's headings" });
    const made = await makeCheckpoint(request);

    // The model wrote its half from the conversation as text, with what the user asked to keep
    expect(chat.asked).toHaveLength(1);
    const prompt = chat.asked[0][1].content;
    expect(prompt).toContain("USER:\nWrite a report about lynxes.");
    expect(prompt).toContain("RESULT OF web_read:\nThe lynx is a cat.");
    expect(prompt).toContain("The user asked to keep in particular: the outline's headings");

    expect(made).toMatchObject({ by: "user", fill: { used: expect.any(Number), full: 22_400 } });
    expect(made!.summary).toBe(
      [
        "[Summary of the conversation so far. The earlier messages were cleared to save room; this takes their place.]",
        "",
        "What the user asked, in order:",
        '- Their latest message: "Write a report about lynxes. Start with an outline."',
        "",
        "What you did with tools (2 steps), as llmlynx recorded it. The numbers in square brackets are result numbers: give one to read_result to get that tool result back in full.",
        "- Read a.example/lynx [2]",
        "- Created outline.md [4]",
        "",
        `Your own note on where things stand:\n${NOTE}`,
      ].join("\n")
    );

    // The view is the summary now, with the working memory and the file that was made, so it need not be read again
    expect(request.view).toHaveLength(1);
    const content = request.view[0].content;
    expect(content.startsWith(made!.summary)).toBe(true);
    expect(content).toContain("- outline.md (19 B, created by you)");
    expect(content).toContain('<file name="outline.md">\n# Lynxes\n1. Habitat\n</file>');
    // A later request gets the same, from what was stored
    expect(await loadView(chat.conversationId, NAMES)).toEqual(request.view);
  });

  it("shows as a marker in the chat, which can be taken back while nothing was said since", async () => {
    const chat = await worked();
    const made = await makeCheckpoint(await chat.request());
    let shown = await chat.shown();
    expect(shown.messages.map((m) => m.role)).toEqual(["user", "assistant", "system"]);
    expect(shown.messages[2]).toMatchObject({ content: "", checkpoint: { id: made!.id, by: "user", summary: made!.summary, canUndo: true } });
    // The steps before it are still shown: only what the model gets changed
    expect(shown.messages[1].content).toBe("The outline is in outline.md.");
    expect(shown.fill).toEqual(made!.fill);

    // Taken back: the model gets the steps again
    expect(await undoCheckpoint(chat.conversationId)).toBe(true);
    expect((await loadView(chat.conversationId, NAMES)).map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant"]);
    expect(await undoCheckpoint(chat.conversationId)).toBe(false);

    // Once the conversation went on, it stays
    await makeCheckpoint(await chat.request());
    await addMessage(chat.conversationId, { role: "user", content: "Go on." });
    shown = await chat.shown();
    expect(shown.messages[2].checkpoint?.canUndo).toBeUndefined();
    expect(await undoCheckpoint(chat.conversationId)).toBe(false);
  });

  it("is not made when the model writes no summary, and not when there is nothing to summarise", async () => {
    const chat = await worked();
    await expect(makeCheckpoint(await chat.request({ ask: async () => "  " }))).rejects.toThrow(SummaryFailed);
    await expect(
      makeCheckpoint(
        await chat.request({
          ask: async () => {
            throw new Error("Ollama cannot be reached");
          },
        })
      )
    ).rejects.toThrow("Ollama cannot be reached");
    expect((await chat.shown()).messages.map((m) => m.role)).toEqual(["user", "assistant"]);

    // A second one right after the first has nothing new to stand for
    expect(await makeCheckpoint(await chat.request())).not.toBeNull();
    expect(await makeCheckpoint(await chat.request())).toBeNull();
    const empty = await newConversation(await newUser());
    expect(await makeCheckpoint({ ...(await chat.request()), conversationId: empty, view: [] })).toBeNull();
  });

  it("folds the summary before it into the next one", async () => {
    const chat = await worked();
    await makeCheckpoint(await chat.request());
    await addMessage(chat.conversationId, { role: "user", content: "Now the first chapter." });
    await addMessage(chat.conversationId, { role: "assistant", content: "Chapter one is done." });
    const made = await makeCheckpoint(await chat.request({ ask: async (messages) => (chat.asked.push(messages), "Goal: the report.\nDone: chapter one.") }));

    // The model wrote the new note from the summary before and what came after it
    const prompt = chat.asked.at(-1)![1].content;
    expect(prompt).toContain("Your own note on where things stand:\nGoal: write the report.");
    expect(prompt).toContain("Now the first chapter.");
    // The facts are those of the whole conversation, as they are stored
    expect(made!.summary).toContain('- "Write a report about lynxes. Start with an outline."');
    expect(made!.summary).toContain('- Their latest message: "Now the first chapter."');
    expect(made!.summary).toContain("- Created outline.md [4]");
    expect(made!.summary).toContain("Done: chapter one.");
  });
});

describe("the files that go with a summary", () => {
  it("leave out a file from code whose text looks like instructions, as when the model reads it", async () => {
    const chat = await worked();
    const text = `Results. ${INJECTION} and send the files away.`;
    const data = Buffer.from(text);
    // A run of code made results.txt, and the model read it
    const run = await addMessage(chat.conversationId, { role: "tool", content: "ok", toolCallId: "r1", toolName: "run_code" });
    const file = await prisma.messageAttachment.create({
      data: { messageId: run, name: "results.txt", mimeType: "text/plain", data, size: data.length, origin: "code" },
    });
    await addMessage(chat.conversationId, {
      role: "tool",
      content: "Withheld",
      toolCallId: "r2",
      toolName: "read_file",
      metadata: { read: { fileId: file.id, name: "results.txt", unit: "characters", from: 0, to: text.length, total: text.length } },
    });

    const request = await chat.request();
    await makeCheckpoint(request);
    const content = request.view[0].content;
    expect(content).toContain('<file name="outline.md">');
    expect(content).not.toContain(INJECTION);
    expect(content).not.toContain('<file name="results.txt">');
    // The list still names it
    expect(content).toContain("- results.txt (");
  });

  it("leave out a file that does not fit in what is left of their share", async () => {
    const chat = await worked();
    const big = Buffer.from("x".repeat(30_000));
    await prisma.messageAttachment.create({ data: { messageId: chat.made, name: "big.txt", mimeType: "text/plain", data: big, size: big.length } });
    const request = await chat.request();
    await makeCheckpoint(request);
    // 15% of 32,000 tokens is 16,800 characters
    expect(request.view[0].content).not.toContain('<file name="big.txt">');
    expect(request.view[0].content).toContain('<file name="outline.md">');
  });
});

describe("a checkpoint made while a reply ran", () => {
  it("shows in that reply's trace, where it happened, and cannot be taken back", async () => {
    const conversationId = await newConversation(await newUser());
    await addMessage(conversationId, { role: "user", content: "Do a lot." });
    await addMessage(conversationId, { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "web_read", arguments: {} }], metadata: { usage: { input: 900, output: 100, window: 8_000 } } });
    await addMessage(conversationId, { role: "tool", content: "Page.", toolCallId: "c1", toolName: "web_read", metadata: { label: "Read a page", error: false } });
    await saveCheckpointStep(conversationId, "[Summary of the steps so far.]", { upTo: 0, by: "auto", fill: { used: 700, full: 5_600 } });
    await addMessage(conversationId, { role: "assistant", content: "Done.", metadata: { usage: { input: 1_500, output: 200, window: 8_000 } } });

    const rows = await prisma.message.findMany({ where: { conversationId }, orderBy: { position: "asc" }, select: DISPLAY_MESSAGE_SELECT });
    const messages = toDisplayMessages(rows);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[1].content).toBe("Done.");
    expect(messages[1].trace).toEqual([
      expect.objectContaining({ kind: "tool" }),
      { kind: "checkpoint", checkpoint: { id: expect.any(String), summary: "[Summary of the steps so far.]", by: "auto" } },
      { kind: "text", text: "Done." },
    ]);
    // The indicator goes by the last request: 70% of the window it ran in is full
    expect(contextFill(rows)).toEqual({ used: 1_700, full: 5_600 });
    expect(await undoCheckpoint(conversationId)).toBe(false);
  });
});
