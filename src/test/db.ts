// Rows for the tests, in the scratch database: users, conversations and
// stored messages. Every test makes its own, so the tests do not see each
// other's data.

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/prisma";

export async function newUser(): Promise<string> {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@test.example`, passwordHash: "-" }, select: { id: true } });
  return user.id;
}

export async function newConversation(userId: string): Promise<string> {
  const conversation = await prisma.conversation.create({ data: { userId, model: "agent:test" }, select: { id: true } });
  return conversation.id;
}

/** Stores a message as the conversation's next step. Returns its id. */
export async function addMessage(
  conversationId: string,
  data: Omit<Prisma.MessageUncheckedCreateInput, "conversationId" | "position">
): Promise<string> {
  const position = await prisma.message.count({ where: { conversationId } });
  const message = await prisma.message.create({ data: { ...data, conversationId, position }, select: { id: true } });
  return message.id;
}

/** The events the security checks logged for a user, oldest first. */
export function eventsOf(userId: string) {
  return prisma.securityEvent.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
}

/** Stores a file with a message, as one that was attached to it, with its text. Returns its id. */
export async function addFile(messageId: string, name: string, text: string | null): Promise<string> {
  const data = Buffer.from(text ?? "bytes");
  const file = await prisma.messageAttachment.create({
    data: { messageId, name, mimeType: "text/plain", data, size: data.length, text },
    select: { id: true },
  });
  return file.id;
}
