import { prisma } from "@/server/db/prisma";

// Helper to make a short title from the first user message
export function makeTitleFrom(content: string, maxWords = 8, maxChars = 80) {
  const words = content.trim().split(/\s+/).slice(0, maxWords);
  let title = words.join(" ");
  if (title.length > maxChars) title = title.slice(0, maxChars - 1) + "…";
  return title || "New chat";
}

/**
 * Returns the id of the user's conversation `conversationId`, or creates a new
 * conversation when no id is given. Returns null if the id is not the user's.
 */
export async function resolveConversation(
  userId: string,
  conversationId: string | undefined,
  modelKey: string
): Promise<string | null> {
  if (conversationId) {
    const convo = await prisma.conversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });
    return convo?.id ?? null;
  }
  const convo = await prisma.conversation.create({
    data: { userId, model: modelKey },
    select: { id: true },
  });
  return convo.id;
}

/** Stores a user message. The first message of a conversation also sets its title. */
export async function saveUserMessage(conversationId: string, content: string, modelKey: string) {
  await prisma.$transaction(async (tx) => {
    const isFirst = !(await tx.message.findFirst({ where: { conversationId }, select: { id: true } }));
    await tx.message.create({ data: { conversationId, role: "user", content } });
    await tx.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date(), model: modelKey, ...(isFirst ? { title: makeTitleFrom(content) } : {}) },
    });
  });
}

export type AssistantReply = {
  append(text: string): void;
  /** Stores the accumulated reply. Safe to call more than once; only the first call writes. */
  persist(): Promise<void>;
};

export function createAssistantReply(conversationId: string, modelKey: string): AssistantReply {
  let text = "";
  let saved = false;
  return {
    append(delta) {
      text += delta;
    },
    async persist() {
      if (saved) return;
      saved = true;
      try {
        if (text.trim().length > 0) {
          await prisma.$transaction(async (tx) => {
            await tx.message.create({ data: { conversationId, role: "assistant", content: text } });
            await tx.conversation.update({
              where: { id: conversationId },
              data: { updatedAt: new Date(), model: modelKey },
            });
          });
        } else {
          await prisma.conversation.update({ where: { id: conversationId }, data: { model: modelKey } });
        }
      } catch {
        // The reply has already been streamed; a failed save must not break the response.
      }
    },
  };
}
