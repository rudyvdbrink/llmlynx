import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import type { ChatMessage } from "@/lib/types";
import { saveRequestSetup, type RequestSetupInput } from "./setup";

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

/** The position the next message of a conversation gets. */
async function nextPosition(tx: Prisma.TransactionClient, conversationId: string): Promise<number> {
  const last = await tx.message.findFirst({
    where: { conversationId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  return last ? last.position + 1 : 0;
}

/** Stores a user message. The first message of a conversation also sets its title. */
export async function saveUserMessage(conversationId: string, content: string, modelKey: string) {
  await prisma.$transaction(async (tx) => {
    const position = await nextPosition(tx, conversationId);
    await tx.message.create({ data: { conversationId, position, role: "user", content } });
    await tx.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date(), model: modelKey, ...(position === 0 ? { title: makeTitleFrom(content) } : {}) },
    });
  });
}

/**
 * The conversation as the model gets it, read from the database: the user's
 * messages and the replies in order. Replies without text (stopped before the
 * model wrote any) are left out.
 */
export async function loadHistory(conversationId: string): Promise<ChatMessage[]> {
  const rows = await prisma.message.findMany({
    where: { conversationId, role: { in: ["user", "assistant"] }, content: { not: "" } },
    orderBy: { position: "asc" },
    select: { role: true, content: true },
  });
  return rows.map((m) => ({ role: m.role as ChatMessage["role"], content: m.content }));
}

export type AssistantReply = {
  append(text: string): void;
  appendReasoning(text: string): void;
  /** Stores the accumulated reply. Safe to call more than once; only the first call writes. */
  persist(): Promise<void>;
};

/**
 * Collects a reply as it streams in, to store it as an assistant message.
 * `modelKey` is the selection the user chats with, which the conversation keeps;
 * `model` is the "<provider>:<model>" that writes the reply (for an agent, its
 * base model), and `setup` is what that model is given besides the conversation.
 */
export function createAssistantReply({
  conversationId,
  userId,
  modelKey,
  model,
  setup,
}: {
  conversationId: string;
  userId: string;
  modelKey: string;
  model: string;
  setup: RequestSetupInput;
}): AssistantReply {
  let text = "";
  let reasoning = "";
  let saved = false;
  return {
    append(delta) {
      text += delta;
    },
    appendReasoning(delta) {
      reasoning += delta;
    },
    async persist() {
      if (saved) return;
      saved = true;
      try {
        // A reply stopped while the model was still thinking keeps its reasoning
        if (text.trim().length > 0 || reasoning.trim().length > 0) {
          await prisma.$transaction(async (tx) => {
            const position = await nextPosition(tx, conversationId);
            const setupId = await saveRequestSetup(tx, userId, setup);
            await tx.message.create({
              data: {
                conversationId,
                position,
                role: "assistant",
                content: text,
                reasoning: reasoning || null,
                model,
                setupId,
              },
            });
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
