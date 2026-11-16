// Tests of how a reopened conversation shows what the security checks did with a tool's result.

import { describe, expect, it } from "vitest";
import { prisma } from "@/server/db/prisma";
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
});
