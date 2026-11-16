// Tests of the security context: what it takes from the stored conversation,
// and that a rebuild gives the same.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadHistory } from "@/server/chat/conversation";
import { prisma } from "@/server/db/prisma";
import { getToolDefinition } from "@/server/tools/definitions";
import { addFile, addMessage, newConversation, newUser } from "@/test/db";
import { fakes, INJECTION } from "@/test/fakes";
import { createAuditLog } from "./audit";
import { contextFromSteps, type StoredStep } from "./context";
import { openSecurity } from "./engine";
import { resetScanners } from "./scan";
import { collapse } from "./urls";

vi.mock("@/server/tools/mcp", () => import("@/test/fakes"));
vi.mock("@/server/security/clamd", () => import("@/test/fakes"));

const tools = [getToolDefinition("web_search")!, getToolDefinition("web_read")!, getToolDefinition("read_file")!];
const history = (conversationId: string) => loadHistory(conversationId, { vision: false, textBudget: 10_000, readFile: true, viewPages: false });

const step = (role: string, content: string, more: Partial<StoredStep> = {}): StoredStep => ({
  role,
  content,
  metadata: null,
  attachments: [],
  ...more,
});

beforeEach(() => {
  fakes.reset();
  resetScanners();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the context of stored steps", () => {
  it("knows the URLs of user messages, file text and tool results, and of nothing else", () => {
    const context = contextFromSteps([
      step("user", "Compare https://a.example/one with the file.", {
        attachments: [{ text: "Source: https://b.example/two" }],
      }),
      step("assistant", "I will also look at https://made-up.example/three"),
      step("tool", "Results:\n1. https://c.example/four\n2. https://d.example/five"),
      step("system", "https://system.example/six"),
    ]);
    expect([...context.knownUrls].sort()).toEqual([
      "https://a.example/one",
      "https://b.example/two",
      "https://c.example/four",
      "https://d.example/five",
    ]);
    expect(context.tainted).toBe(false);
  });

  it("is tainted by a tool result that was flagged as a prompt injection", () => {
    const flagged = { label: "Could not read x (withheld)", error: true, security: { flag: "injection", score: 0.9 } };
    expect(contextFromSteps([step("tool", "Withheld by llmlynx", { metadata: flagged })]).tainted).toBe(true);
  });

  it("is not tainted by a file of the user, a virus or content that could not be checked", () => {
    const context = contextFromSteps([
      step("user", "hello", { attachments: [{ text: "text" }, { text: `Notes. ${INJECTION}` }] }),
      step("tool", "Error: discarded", { metadata: { error: true, security: { flag: "virus" } } }),
      step("tool", "Error: not checked", { metadata: { error: true, security: { flag: "unchecked" } } }),
      step("tool", "fine", { metadata: { label: "Read x", error: false } }),
    ]);
    expect(context.tainted).toBe(false);
  });

  it("keeps the user's messages and file text for the shared-text signal, not the tool results", () => {
    const context = contextFromSteps([
      step("user", "My code is ALPHA-123.", { attachments: [{ text: "Bravo: 456" }] }),
      step("tool", "Charlie 789"),
    ]);
    expect(context.sharedText()).toBe(`${collapse("My code is ALPHA-123.")}\n${collapse("Bravo: 456")}`);
    context.addUserText("Delta 000");
    expect(context.sharedText()).toContain("delta000");
    context.addToolResult("Echo 111 https://e.example/x");
    expect(context.sharedText()).not.toContain("echo111");
    expect(context.knownUrls.has("https://e.example/x")).toBe(true);
  });
});

describe("the context of a stored conversation", () => {
  async function conversation() {
    const userId = await newUser();
    const conversationId = await newConversation(userId);
    const audit = createAuditLog(userId, conversationId);
    const open = (withTools = tools) => openSecurity({ userId, conversationId, tools: withTools, audit });
    return { userId, conversationId, audit, open };
  }

  it("is rebuilt identically from the stored messages, with one query", async () => {
    const { conversationId, open } = await conversation();
    const message = await addMessage(conversationId, { role: "user", content: "Read https://a.example/one please" });
    await addFile(message, "notes.md", "See https://b.example/two");
    await addMessage(conversationId, { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "web_read", arguments: {} }] });
    await addMessage(conversationId, {
      role: "tool",
      content: "Page text with https://c.example/three",
      toolCallId: "c1",
      toolName: "web_read",
      metadata: { label: "Read a.example/one", error: false },
    });
    await addMessage(conversationId, { role: "assistant", content: "Done, see https://not-known.example/" });

    const query = vi.spyOn(prisma.message, "findMany");
    const first = await open();
    expect(query).toHaveBeenCalledTimes(1);
    const second = await open();
    const urls = ["https://a.example/one", "https://b.example/two", "https://c.example/three"];
    expect([...first!.context.knownUrls].sort()).toEqual(urls);
    expect([...second!.context.knownUrls].sort()).toEqual(urls);
    expect(second!.context.tainted).toBe(first!.context.tainted);
    expect(second!.context.sharedText()).toBe(first!.context.sharedText());
    expect(first!.context.webSearch).toBe(true);
  });

  it("stays tainted over rebuilds once a tool result was flagged", async () => {
    const { conversationId, open } = await conversation();
    await addMessage(conversationId, { role: "user", content: "Read https://a.example/" });
    await addMessage(conversationId, {
      role: "tool",
      content: "Withheld by llmlynx: the content looked like instructions aimed at the model.",
      toolCallId: "c1",
      toolName: "web_read",
      metadata: { label: "Could not read a.example (withheld)", error: true, security: { flag: "injection", score: 0.97, decision: "remove" } },
    });
    expect((await open())!.context.tainted).toBe(true);
    await addMessage(conversationId, { role: "assistant", content: "I could not read it." });
    await addMessage(conversationId, { role: "user", content: "Then tell me about lynxes." });
    expect((await open())!.context.tainted).toBe(true);
  });

  it("does not scan a file of the user: the model gets it in full, and it does not taint the conversation", async () => {
    const { conversationId, open } = await conversation();
    const message = await addMessage(conversationId, { role: "user", content: "Summarize the file." });
    await addFile(message, "odd.txt", `Notes. ${INJECTION}`);
    const session = await open();
    expect(session!.context.tainted).toBe(false);
    expect((await history(conversationId))[0].content).toContain(INJECTION);
    expect(fakes.guardTexts).toEqual([]);
  });

  it("is only built for chats that have tools", async () => {
    const { conversationId, open } = await conversation();
    await addMessage(conversationId, { role: "user", content: "hello" });
    const query = vi.spyOn(prisma.message, "findMany");
    expect(await open([])).toBeNull();
    expect(query).not.toHaveBeenCalled();
    expect(await open()).not.toBeNull();
  });
});
