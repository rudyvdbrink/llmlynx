import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { addFiles, HISTORY_ATTACHMENT_SELECT, type FileHistoryOptions } from "@/server/files/history";
import type { ToolFile, ToolImage } from "@/server/tools/mcp";
import { uniqueName, type FileCard } from "@/lib/files";
import { parseSelection, toSelection } from "@/lib/selection";
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

// How many conversations to look back through for an agent that still exists
const LAST_USED_LOOKBACK = 20;

/**
 * What the user chatted with last, as a selection, or null if they have not
 * chatted yet. Renaming or pinning a conversation does not change its updatedAt,
 * so that always means sending a message. Agents they have since deleted are skipped.
 */
export async function getLastUsedSelection(userId: string): Promise<string | null> {
  const [recent, agents] = await Promise.all([
    prisma.conversation.findMany({
      where: { userId, model: { not: null }, messages: { some: {} } },
      orderBy: { updatedAt: "desc" },
      take: LAST_USED_LOOKBACK,
      select: { model: true },
    }),
    prisma.agent.findMany({ where: { userId }, select: { id: true } }),
  ]);
  for (const { model } of recent) {
    const { kind, value } = parseSelection(model);
    if (kind !== "agent" || agents.some((agent) => agent.id === value)) return toSelection(kind, value);
  }
  return null;
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

/** A file the user attached to a new message. */
export type NewFile = { name: string; mimeType: string; data: Buffer<ArrayBuffer> };

/** The file cards of a message's files, in order. */
export async function messageFiles(messageId: string): Promise<FileCard[]> {
  const rows = await prisma.messageAttachment.findMany({
    where: { messageId, parentId: null, name: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, mimeType: true, size: true },
  });
  return rows.map((r) => ({ id: r.id, name: r.name!, mimeType: r.mimeType, size: r.size ?? 0 }));
}

/**
 * Stores a user message, with the files attached to it. The first message of a
 * conversation also sets its title. A message with the `requestId` of the
 * conversation's last user message is a re-send of it (see attempts.ts): the
 * message stays, with its files (`files` are not stored again), and what the
 * attempt before stored of its reply goes, as this attempt writes the reply again.
 */
export async function saveUserMessage(
  conversationId: string,
  content: string,
  modelKey: string,
  requestId: string | null = null,
  files: NewFile[] = []
): Promise<{ messageId: string; resent: boolean }> {
  return prisma.$transaction(async (tx) => {
    if (requestId) {
      const last = await tx.message.findFirst({
        where: { conversationId, role: "user" },
        orderBy: { position: "desc" },
        select: { id: true, position: true, metadata: true },
      });
      if ((last?.metadata as { requestId?: unknown } | null)?.requestId === requestId) {
        await tx.message.deleteMany({ where: { conversationId, position: { gt: last!.position } } });
        return { messageId: last!.id, resent: true };
      }
    }
    const position = await nextPosition(tx, conversationId);
    // Two files of one message with the same name, such as photos, get different names
    const names: string[] = [];
    for (const file of files) names.push(uniqueName(file.name, names));
    const message = await tx.message.create({
      data: {
        conversationId,
        position,
        role: "user",
        content,
        ...(requestId ? { metadata: { requestId } } : {}),
        ...(files.length
          ? {
              attachments: {
                create: files.map((f, i) => ({ name: names[i], mimeType: f.mimeType, data: f.data, size: f.data.length })),
              },
            }
          : {}),
      },
      select: { id: true },
    });
    await tx.conversation.update({
      where: { id: conversationId },
      data: {
        updatedAt: new Date(),
        model: modelKey,
        ...(position === 0 ? { title: makeTitleFrom(content || names[0] || "") } : {}),
      },
    });
    return { messageId: message.id, resent: false };
  });
}

/**
 * The conversation as the model gets it, read from the database: the user's
 * messages and the replies in order. Replies without text (stopped before the
 * model wrote any) are left out. Of a reply that used tools, only its answer
 * (the last step) is sent: the tool calls and their results would fill the
 * context, and the answer names its sources, so the model can read them again.
 * With `files`, user messages carry their files (see server/files/history.ts);
 * without, only their text.
 */
export async function loadHistory(conversationId: string, files?: FileHistoryOptions): Promise<ChatMessage[]> {
  const rows = await prisma.message.findMany({
    where: {
      conversationId,
      role: { in: ["user", "assistant"] },
      OR: [{ content: { not: "" } }, { role: "user", attachments: { some: {} } }],
    },
    orderBy: { position: "asc" },
    select: { role: true, content: true, toolCalls: true, attachments: HISTORY_ATTACHMENT_SELECT },
  });
  const kept = rows.filter((m) => m.toolCalls == null);
  if (files) {
    const messages = kept.map((m) => ({ role: m.role as ChatMessage["role"], content: m.content }));
    return addFiles(messages, kept.map((m) => m.attachments), files);
  }
  // A message of only files still keeps its place between the replies
  return kept.map((m) => ({
    role: m.role as ChatMessage["role"],
    content: m.content || `[Files you cannot see: ${m.attachments.map((a) => a.name).join(", ")}]`,
  }));
}

/** A tool call as stored in Message.toolCalls. */
export type StoredToolCall = { id: string; name: string; arguments: Record<string, unknown> };

export type ToolResultStep = {
  call: StoredToolCall;
  content: string; // what the model gets back
  label: string; // what the chat view shows
  error: boolean;
  images: ToolImage[]; // what the model sees, such as a screenshot
  files: ToolFile[]; // files the tool made for the user
};

/** What saveToolResult stored: the ids of the images, and the cards of the files. */
export type SavedToolResult = { imageIds: string[]; files: FileCard[] };

export type AssistantReply = {
  append(text: string): void;
  appendReasoning(text: string): void;
  /** Stores what streamed so far as a step that calls `calls`; the next text starts a new step. */
  saveToolCalls(calls: StoredToolCall[]): Promise<void>;
  /** Stores a tool's result as a tool step, with its images and files. */
  saveToolResult(step: ToolResultStep): Promise<SavedToolResult>;
  /** Stores the final step. Safe to call more than once; only the first call writes. */
  persist(): Promise<void>;
};

/**
 * Collects a reply as it streams in, to store it as assistant messages: one
 * per step when the model calls tools (an assistant step with the calls, a
 * tool step per result, then the answer), otherwise one. Each step is stored
 * as soon as it is complete, so a reply that is stopped keeps its finished steps.
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
  // Every step of the reply shares one setup
  let setupId: string | null = null;

  /** Stores one step of the reply as the conversation's next message. Returns its attachments, in order. */
  async function saveStep(data: Omit<Prisma.MessageUncheckedCreateInput, "conversationId" | "position">) {
    return prisma.$transaction(async (tx) => {
      const position = await nextPosition(tx, conversationId);
      const message = await tx.message.create({
        data: { ...data, conversationId, position },
        select: {
          attachments: { select: { id: true, name: true, mimeType: true, size: true }, orderBy: { createdAt: "asc" } },
        },
      });
      await tx.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date(), model: modelKey },
      });
      return message.attachments;
    });
  }

  async function assistantStep(toolCalls?: StoredToolCall[]) {
    setupId ??= await prisma.$transaction((tx) => saveRequestSetup(tx, userId, setup));
    await saveStep({
      role: "assistant",
      content: text,
      reasoning: reasoning || null,
      model,
      setupId,
      ...(toolCalls ? { toolCalls: toolCalls as Prisma.InputJsonValue } : {}),
    });
    text = "";
    reasoning = "";
  }

  return {
    append(delta) {
      text += delta;
    },
    appendReasoning(delta) {
      reasoning += delta;
    },
    async saveToolCalls(calls) {
      if (saved) return;
      try {
        await assistantStep(calls);
      } catch {
        // As with persist(): the reply goes on even if a step cannot be stored.
      }
    },
    async saveToolResult({ call, content, label, error, images, files }) {
      const none: SavedToolResult = { imageIds: [], files: [] };
      if (saved) return none;
      const attachments = [
        ...images.map((i) => ({ mimeType: i.mimeType, data: Buffer.from(i.data, "base64") })),
        ...files.map((f) => ({ name: f.name, mimeType: f.mimeType, data: Buffer.from(f.data, "base64") })),
      ].map((a) => ({ ...a, size: a.data.length }));
      try {
        const stored = await saveStep({
          role: "tool",
          content,
          toolCallId: call.id,
          toolName: call.name,
          metadata: { label, error },
          attachments: attachments.length ? { create: attachments } : undefined,
        });
        return {
          imageIds: stored.filter((a) => a.name === null).map((a) => a.id),
          files: stored
            .filter((a) => a.name !== null)
            .map((a) => ({ id: a.id, name: a.name!, mimeType: a.mimeType, size: a.size ?? 0 })),
        };
      } catch {
        return none;
      }
    },
    async persist() {
      if (saved) return;
      saved = true;
      try {
        // A reply stopped while the model was still thinking keeps its reasoning
        if (text.trim().length > 0 || reasoning.trim().length > 0) {
          await assistantStep();
        } else {
          await prisma.conversation.update({ where: { id: conversationId }, data: { model: modelKey } });
        }
      } catch {
        // The reply has already been streamed; a failed save must not break the response.
      }
    },
  };
}
