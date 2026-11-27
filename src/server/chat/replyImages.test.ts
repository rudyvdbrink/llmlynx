// Tests of the images a reply shows in its text (see lib/inlineImages.ts):
// the image files of the sandbox that the chat view gets while the reply
// streams in, the versions the reply's steps keep, and what the reply shows
// when the conversation is opened again. The model is a script of turns; the
// tool servers and scanners are stand-ins.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileCard } from "@/lib/files";
import { prisma } from "@/server/db/prisma";
import { createAuditLog } from "@/server/security/audit";
import { openSecurity } from "@/server/security/engine";
import { resetScanners } from "@/server/security/scan";
import { getToolDefinition } from "@/server/tools/definitions";
import { addMessage, newConversation, newUser } from "@/test/db";
import { fakes } from "@/test/fakes";
import { createAssistantReply } from "./conversation";
import { DISPLAY_MESSAGE_SELECT, sharedIds, shownImageIds, toDisplayMessages } from "./display";
import { runToolLoop, type ModelTurn } from "./toolLoop";

vi.mock("@/server/tools/mcp", () => import("@/test/fakes"));
vi.mock("@/server/security/clamd", () => import("@/test/fakes"));

const runPython = (code: string) => ({ name: "run_code", arguments: { language: "python", code } });

beforeEach(() => {
  fakes.reset();
  resetScanners();
});

/**
 * A chat with an agent that has `toolNames`, in which the user attached
 * panda.jpg, and whose model makes `turns` and then answers `answer`.
 */
async function chat(toolNames: string[], turns: ModelTurn["calls"][], answer: string) {
  const tools = toolNames.map((name) => getToolDefinition(name)!);
  const userId = await newUser();
  const conversationId = await newConversation(userId);
  const messageId = await addMessage(conversationId, { role: "user", content: "Show me" });
  const panda = await prisma.messageAttachment.create({
    data: { messageId, name: "panda.jpg", mimeType: "image/jpeg", data: Buffer.from("jpg"), size: 3 },
    select: { id: true },
  });
  const audit = createAuditLog(userId, conversationId);
  const security = await openSecurity({ userId, conversationId, tools, audit });
  const reply = createAssistantReply({ conversationId, userId, modelKey: "agent:test", model: "ollama:test", setup: {}, showsImages: true });
  const imageLines: FileCard[][] = [];
  let turn = 0;
  await runToolLoop<ModelTurn>({
    tools,
    maxToolCalls: 7,
    toolContext: { userId, textBudget: 5000, conversationId, vision: false, security },
    reply,
    signal: new AbortController().signal,
    isCancelled: () => false,
    sendTool: () => {},
    sendFiles: () => {},
    sendImages: (images) => void imageLines.push(images),
    sendPause: () => {},
    sendError: () => {},
    nextTurn: async () => {
      const calls = turns[turn++] ?? [];
      const content = calls.length ? "" : answer;
      reply.append(content);
      return { content, calls };
    },
    plainTurn: async () => ({ content: "", calls: [] }),
    view: [{ role: "user", content: "Show me" }],
  });
  await reply.persist();
  await audit.flush();
  return { conversationId, pandaId: panda.id, imageLines };
}

/** The reply as the chat view shows it when the conversation is opened again (as GET /api/conversations/:id does). */
async function reopened(conversationId: string) {
  const rows = await prisma.message.findMany({ where: { conversationId }, orderBy: { position: "asc" }, select: DISPLAY_MESSAGE_SELECT });
  const ids = rows.flatMap((r) => [...sharedIds(r.metadata), ...shownImageIds(r.metadata)]);
  const found = await prisma.messageAttachment.findMany({ where: { id: { in: ids }, deleted: false }, select: { id: true, name: true, mimeType: true, size: true } });
  const cards = new Map(found.map((f) => [f.id, { id: f.id, name: f.name!, mimeType: f.mimeType, size: f.size ?? 0 }]));
  return toDisplayMessages(rows, cards)[1];
}

const ANSWER = "Here:\n![A panda](panda.jpg)\n![The chart](sandbox:/mnt/data/chart.png)\n![Gone](missing.png)";

describe("the images of a reply's text", () => {
  it("are matched against the sandbox's image files, which the chat view gets before each request in which they changed", async () => {
    fakes.run = { changed: { "chart.png": "png" } };
    const run = await chat(["run_code", "share_file"], [[runPython("plot")]], ANSWER);
    const chart = await prisma.messageAttachment.findFirstOrThrow({ where: { name: "chart.png", message: { conversationId: run.conversationId } } });

    // Before the first request the user's image; before the second, also the chart the run made
    expect(run.imageLines.map((list) => list.map((f) => f.name))).toEqual([["panda.jpg"], ["panda.jpg", "chart.png"]]);
    expect(run.imageLines[1][1]).toEqual({ id: chart.id, name: "chart.png", mimeType: "image/png", size: chart.size });

    // The answer keeps the files its text shows; a name that matches no file is left out
    const answer = await prisma.message.findFirstOrThrow({ where: { conversationId: run.conversationId, role: "assistant", content: ANSWER } });
    expect(shownImageIds(answer.metadata)).toEqual([run.pandaId, chart.id]);
    const reply = await reopened(run.conversationId);
    expect(reply.imageFiles?.map((f) => f.id)).toEqual([run.pandaId, chart.id]);
  });

  it("keep showing the versions they showed after the files change", async () => {
    fakes.run = { changed: { "chart.png": "png" } };
    const run = await chat(["run_code", "share_file"], [[runPython("plot")]], ANSWER);
    const first = await prisma.messageAttachment.findFirstOrThrow({ where: { name: "chart.png", message: { conversationId: run.conversationId } } });

    // A later run makes a new version of the chart
    const later = await addMessage(run.conversationId, { role: "tool", content: "Ran", toolCallId: "later", toolName: "run_code" });
    const newer = await prisma.messageAttachment.create({
      data: { messageId: later, name: "chart.png", mimeType: "image/png", data: Buffer.from("png2"), size: 4, origin: "code" },
      select: { id: true },
    });
    expect(newer.id).not.toBe(first.id);

    const reply = await reopened(run.conversationId);
    expect(reply.imageFiles?.map((f) => f.id)).toEqual([run.pandaId, first.id]);
  });

  it("are not sent to an agent without tools that work on files", async () => {
    const run = await chat(["web_search"], [], "![A panda](panda.jpg)");
    expect(run.imageLines).toEqual([]);
  });

  it("are not sent again when they did not change", async () => {
    const run = await chat(["run_code", "share_file"], [[runPython("print(1)")]], "No images.");
    expect(run.imageLines.map((list) => list.map((f) => f.name))).toEqual([["panda.jpg"]]);
  });
});
