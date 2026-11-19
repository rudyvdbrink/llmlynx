// Tests of how a reply is stored next to the conversation's other messages.

import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/db/prisma";
import { addMessage, newConversation, newUser } from "@/test/db";
import { createAssistantReply, saveUserMessage } from "./conversation";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a reply stopped while it stores a step", () => {
  it("stores that step before the conversation's next message", async () => {
    const userId = await newUser();
    const conversationId = await newConversation(userId);
    await addMessage(conversationId, { role: "user", content: "Run it" });
    const reply = createAssistantReply({ conversationId, userId, modelKey: "agent:test", model: "ollama:test", setup: {} });

    // The step takes a while to store, as one with many files does
    const transaction = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(prisma, "$transaction").mockImplementationOnce((async (...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return transaction(...args);
    }) as typeof prisma.$transaction);
    const step = reply.saveToolResult({
      call: { id: "call_1", name: "run_code", arguments: {} },
      content: "done",
      label: "Ran code",
      error: false,
      images: [],
      files: [],
    });

    // Stopping the reply, as a new message in the conversation does, stores it whole first
    await reply.persist();
    await saveUserMessage(conversationId, "Next question", "agent:test");
    await step;

    const rows = await prisma.message.findMany({ where: { conversationId }, orderBy: { position: "asc" }, select: { role: true } });
    expect(rows.map((r) => r.role)).toEqual(["user", "tool", "user"]);
  });
});
