// Tests of the security context: what it takes from the stored conversation,
// and that a rebuild gives the same.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadView } from "@/server/chat/view";
import { prisma } from "@/server/db/prisma";
import { getToolDefinition } from "@/server/tools/definitions";
import { addFile, addMessage, newConversation, newUser } from "@/test/db";
import { fakes, INJECTION } from "@/test/fakes";
import { createAuditLog } from "./audit";
import { contextFromSteps, type StoredStep } from "./context";
import { openSecurity } from "./engine";
import { resetScanners } from "./scan";

vi.mock("@/server/tools/mcp", () => import("@/test/fakes"));
vi.mock("@/server/security/clamd", () => import("@/test/fakes"));

const tools = [getToolDefinition("web_search")!, getToolDefinition("web_read")!, getToolDefinition("read_file")!];
const history = (conversationId: string) =>
  loadView(conversationId, { files: { vision: false, textBudget: 10_000, readFile: true, viewPages: false }, tools: ["web_search", "web_read", "read_file"] });

const step = (metadata: unknown = null): StoredStep => ({ metadata });

beforeEach(() => {
  fakes.reset();
  resetScanners();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the context of stored steps", () => {
  it("is tainted by a tool result that was flagged as a prompt injection", () => {
    const flagged = { label: "Could not read x (withheld)", error: true, security: { flag: "injection", score: 0.9 } };
    expect(contextFromSteps([step(flagged)]).tainted).toBe(true);
  });

  it("is not tainted by a virus, content that could not be checked, or a plain result", () => {
    const context = contextFromSteps([
      step({ error: true, security: { flag: "virus" } }),
      step({ error: true, security: { flag: "unchecked" } }),
      step({ label: "Read x", error: false }),
      step(),
    ]);
    expect(context.tainted).toBe(false);
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

  it("is rebuilt from the stored messages, with one query", async () => {
    const { conversationId, open } = await conversation();
    await addMessage(conversationId, { role: "user", content: "Read https://a.example/one please" });
    await addMessage(conversationId, { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "web_read", arguments: {} }] });
    await addMessage(conversationId, {
      role: "tool",
      content: "Page text",
      toolCallId: "c1",
      toolName: "web_read",
      metadata: { label: "Read a.example/one", error: false },
    });

    const query = vi.spyOn(prisma.message, "findMany");
    const first = await open();
    expect(query).toHaveBeenCalledTimes(1);
    expect(first!.context.tainted).toBe(false);
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
