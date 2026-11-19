// Tests of the conversation as a model gets it: the stored steps replayed as
// they happened, repaired where a provider would refuse them, as text notes
// for a model that cannot take tool calls, and with what was reduced.

import { describe, expect, it } from "vitest";
import { addMessage, newConversation, newUser } from "@/test/db";
import { saveCheckpointStep, saveMemory } from "./conversation";
import { loadView, patchMetadata, STOPPED_RESULT, type AssistantMessage, type ToolMessage, type ViewMessage } from "./view";

const AGENT = { tools: ["web_read", "read_file"] };
const PLAIN = { tools: [] };
const PAGE = { url: "https://a.example/" };

async function newChat(first = "Read the page.") {
  const conversationId = await newConversation(await newUser());
  const userId = await addMessage(conversationId, { role: "user", content: first });
  return { conversationId, userId };
}

/** A stored reply that read a page and then answered. Returns the ids of its steps. */
async function replyWithPage(conversationId: string, { call = "c1", result = "The page says hello.", answer = "It says hello." } = {}) {
  const calls = await addMessage(conversationId, {
    role: "assistant",
    content: "Let me look.",
    reasoning: "The user wants the page.",
    toolCalls: [{ id: call, name: "web_read", arguments: PAGE }],
  });
  const tool = await addMessage(conversationId, {
    role: "tool",
    content: result,
    toolCallId: call,
    toolName: "web_read",
    metadata: { label: "Read a.example", error: false },
  });
  const final = await addMessage(conversationId, { role: "assistant", content: answer });
  return { calls, tool, final };
}

const roles = (view: ViewMessage[]) => view.map((m) => m.role);
const toolsIn = (view: ViewMessage[]) => view.filter((m): m is ToolMessage => m.role === "tool");

describe("an earlier reply that used tools", () => {
  it("is sent as it happened: the call, its result, then the answer", async () => {
    const { conversationId } = await newChat();
    await replyWithPage(conversationId);
    await addMessage(conversationId, { role: "user", content: "And what else?" });

    const view = await loadView(conversationId, AGENT);
    expect(roles(view)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
    expect(view[1]).toMatchObject({ content: "Let me look.", calls: [{ id: "c1", name: "web_read", arguments: PAGE }] });
    expect(view[2]).toMatchObject({ callId: "c1", name: "web_read", content: "The page says hello." });
    expect(view[3]).toMatchObject({ content: "It says hello." });
    // Its reasoning stays out
    expect(JSON.stringify(view)).not.toContain("The user wants the page");
  });

  it("gets a result for a call that never finished, as providers refuse a call without one", async () => {
    const { conversationId } = await newChat();
    await addMessage(conversationId, {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "c1", name: "web_read", arguments: PAGE },
        { id: "c2", name: "web_read", arguments: { url: "https://b.example/" } },
      ],
    });
    await addMessage(conversationId, { role: "tool", content: "First page.", toolCallId: "c1", toolName: "web_read" });
    await addMessage(conversationId, { role: "user", content: "Go on." });

    const view = await loadView(conversationId, AGENT);
    expect(roles(view)).toEqual(["user", "assistant", "tool", "tool", "user"]);
    expect(toolsIn(view).map((m) => [m.callId, m.content])).toEqual([
      ["c1", "First page."],
      ["c2", STOPPED_RESULT],
    ]);
  });

  it("is left without a result that has no call, and without a step that wrote nothing", async () => {
    const { conversationId } = await newChat();
    await addMessage(conversationId, { role: "tool", content: "Lost.", toolCallId: "gone", toolName: "web_read" });
    await addMessage(conversationId, { role: "assistant", content: "", reasoning: "Stopped while thinking." });
    await addMessage(conversationId, { role: "assistant", content: "An answer." });

    const view = await loadView(conversationId, AGENT);
    expect(view.map((m) => [m.role, m.content])).toEqual([
      ["user", "Read the page."],
      ["assistant", "An answer."],
    ]);
  });
});

describe("a model that cannot take the tool calls", () => {
  it("gets them as text notes in a plain chat: what was called, and what came back", async () => {
    const { conversationId } = await newChat();
    await replyWithPage(conversationId);
    await addMessage(conversationId, { role: "user", content: "And what else?" });

    const view = await loadView(conversationId, PLAIN);
    expect(roles(view)).toEqual(["user", "assistant", "user"]);
    const notes = view[1].content;
    expect(notes).toContain("Let me look.");
    expect(notes).toContain('[Earlier tool use: web_read {"url":"https://a.example/"}. Its result follows.]\nThe page says hello.\n[End of the result of web_read.]');
    expect(notes.endsWith("It says hello.")).toBe(true);
    expect((view[1] as AssistantMessage).calls).toBeUndefined();
  });

  it("gets a reply as text notes when it called a tool that is not offered any more, and the other replies as they are", async () => {
    const { conversationId } = await newChat();
    await replyWithPage(conversationId);
    await addMessage(conversationId, { role: "user", content: "Now run it." });
    await addMessage(conversationId, { role: "assistant", content: "", toolCalls: [{ id: "r1", name: "run_code", arguments: { code: "print(1)" } }] });
    await addMessage(conversationId, { role: "tool", content: "1", toolCallId: "r1", toolName: "run_code" });
    await addMessage(conversationId, { role: "assistant", content: "It printed 1." });

    const view = await loadView(conversationId, AGENT);
    expect(roles(view)).toEqual(["user", "assistant", "tool", "assistant", "user", "assistant"]);
    expect(view[5].content).toContain("[Earlier tool use: run_code");
    expect(view[5].content).toContain("It printed 1.");
  });
});

describe("what was reduced", () => {
  it("stays reduced: a cleared result is its pointer, and its call has its arguments cut short", async () => {
    const { conversationId } = await newChat();
    const { tool } = await replyWithPage(conversationId);
    await patchMetadata([{ id: tool, patch: { pointer: "[Cleared to save room.]", args: { url: "[cut short]" } } }]);

    const view = await loadView(conversationId, AGENT);
    expect(toolsIn(view)[0]).toMatchObject({ content: "[Cleared to save room.]", step: { cleared: true, chars: "The page says hello.".length } });
    expect((view[1] as AssistantMessage).calls?.[0].arguments).toEqual({ url: "[cut short]" });
    // What the chat view shows of the step is still there
    expect(toolsIn(view)[0].step).toMatchObject({ error: false });
  });

  it("keeps the working memory with the message it went out with, until a newer copy replaces it", async () => {
    const { conversationId, userId } = await newChat();
    await saveMemory(userId, "[Working memory: one file.]");
    expect((await loadView(conversationId, AGENT))[0]).toMatchObject({
      content: "Read the page.\n\n[Working memory: one file.]",
      memory: "[Working memory: one file.]",
    });

    await patchMetadata([{ id: userId, patch: { memoryCleared: true } }]);
    const cleared = (await loadView(conversationId, AGENT))[0];
    expect(cleared.content).toBe("Read the page.");
    expect("memory" in cleared).toBe(false);
  });
});

describe("a checkpoint", () => {
  it("puts its summary in place of the steps it covers, with what went with it", async () => {
    const { conversationId } = await newChat();
    await replyWithPage(conversationId);
    // Covers the user's message and the reply: positions 0 to 3
    await saveCheckpointStep(conversationId, "[Summary: the page says hello.]", { upTo: 3, by: "user", memory: "[Working memory.]" });

    expect(await loadView(conversationId, AGENT)).toEqual([{ role: "user", content: "[Summary: the page says hello.]\n\n[Working memory.]", summary: true }]);

    // The next message of the user goes on in the same message: not all models take two in a row
    await addMessage(conversationId, { role: "user", content: "And now?" });
    const view = await loadView(conversationId, AGENT);
    expect(roles(view)).toEqual(["user"]);
    expect(view[0].content).toBe(
      "[Summary: the page says hello.]\n\n[Working memory.]\n\n[End of the summary. The conversation goes on here.]\n\nAnd now?"
    );
  });

  it("keeps the steps after its cut as they are, when it was made in the middle of a reply", async () => {
    const { conversationId } = await newChat();
    await replyWithPage(conversationId);
    await addMessage(conversationId, { role: "user", content: "Read the other page." });
    await addMessage(conversationId, { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "web_read", arguments: PAGE }] });
    await addMessage(conversationId, { role: "tool", content: "The other page.", toolCallId: "c2", toolName: "web_read" });
    // Cut before the step that called c2 (position 5)
    await saveCheckpointStep(conversationId, "[Summary.]", { upTo: 4, by: "auto" });

    const view = await loadView(conversationId, AGENT);
    expect(view.map((m) => [m.role, m.content])).toEqual([
      ["user", "[Summary.]"],
      ["assistant", ""],
      ["tool", "The other page."],
    ]);
  });
});
