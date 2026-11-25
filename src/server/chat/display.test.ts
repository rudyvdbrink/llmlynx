// Tests of how a reopened conversation shows what the security checks did with a tool's result.

import { describe, expect, it } from "vitest";
import { prisma } from "@/server/db/prisma";
import { markFalsePositive } from "@/server/security/engine";
import { addMessage, newConversation, newUser } from "@/test/db";
import { DISPLAY_MESSAGE_SELECT, toDisplayMessages } from "./display";

describe("a reopened conversation", () => {
  it("shows a withheld result with the user's choice, and without an open pause", async () => {
    const conversationId = await newConversation(await newUser());
    await addMessage(conversationId, { role: "user", content: "Read https://a.example/" });
    await addMessage(conversationId, {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "c1", name: "web_read", arguments: { url: "https://a.example/" } },
        { id: "c2", name: "web_read", arguments: { url: "https://b.example/" } },
      ],
    });
    await addMessage(conversationId, {
      role: "tool",
      content: "Withheld by llmlynx: the content looked like instructions aimed at the model.",
      toolCallId: "c1",
      toolName: "web_read",
      metadata: {
        label: "Could not read a.example (withheld)",
        error: true,
        security: { flag: "injection", score: 0.97, source: "a.example", decision: "stop" },
      },
    });

    const rows = await prisma.message.findMany({ where: { conversationId }, orderBy: { position: "asc" }, select: DISPLAY_MESSAGE_SELECT });
    const [, reply] = toDisplayMessages(rows);
    const steps = reply.trace!.flatMap((item) => (item.kind === "tool" ? [item.step] : []));
    expect(steps[0]).toMatchObject({
      id: "c1",
      state: "error",
      label: "Could not read a.example (withheld)",
      security: { flag: "injection", source: "a.example", decision: "stop" },
    });
    expect(steps[0].pauseId).toBeUndefined();
    // The call that never ran after Stop shows as not done
    expect(steps[1]).toMatchObject({ id: "c2", state: "error" });
    expect(steps[1].security).toBeUndefined();
  });

  it("shows a flag the user marked a false positive as marked, with its stored step", async () => {
    const userId = await newUser();
    const conversationId = await newConversation(userId);
    await addMessage(conversationId, { role: "user", content: "Read https://a.example/" });
    await addMessage(conversationId, { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "web_read", arguments: {} }] });
    const flagId = await addMessage(conversationId, {
      role: "tool",
      content: "Withheld",
      toolCallId: "c1",
      toolName: "web_read",
      metadata: { label: "Could not read a.example (withheld)", error: true, security: { flag: "injection", chunk: "Hello", decision: "remove" } },
    });
    const step = async () => {
      const rows = await prisma.message.findMany({ where: { conversationId }, orderBy: { position: "asc" }, select: DISPLAY_MESSAGE_SELECT });
      const [, reply] = toDisplayMessages(rows);
      return reply.trace!.flatMap((item) => (item.kind === "tool" ? [item.step] : []))[0];
    };
    expect(await step()).toMatchObject({ rowId: flagId, security: { flag: "injection", chunk: "Hello" } });
    expect((await step()).security?.falsePositive).toBeUndefined();
    await markFalsePositive(userId, flagId);
    expect((await step()).security).toEqual({ flag: "injection", chunk: "Hello", decision: "remove", falsePositive: true });
  });
});
