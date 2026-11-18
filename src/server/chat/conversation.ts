import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { addFiles, HISTORY_ATTACHMENT_SELECT, type FileHistoryOptions } from "@/server/files/history";
import { takeUploads, type UploadsToSend } from "@/server/files/uploads";
import type { ToolFile, ToolImage } from "@/server/tools/mcp";
import { uniqueName, type FileCard } from "@/lib/files";
import { parseSelection, toSelection } from "@/lib/selection";
import type { ApprovalDecision, ChatMessage, PauseDecision, StepSecurity } from "@/lib/types";
import type { RunRecord } from "@/server/tools/definitions";
import { staleText, staleVersions, WHOLE_TEXT, type ExpectedVersion, type StaleVersion } from "@/server/files/store";
import { addConversationCost, conversationCost } from "./cost";
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

/** The file cards of a message's files, in order. */
export async function messageFiles(messageId: string): Promise<FileCard[]> {
  const rows = await prisma.messageAttachment.findMany({
    where: { messageId, parentId: null, name: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, mimeType: true, size: true },
  });
  return rows.map((r) => ({ id: r.id, name: r.name!, mimeType: r.mimeType, size: r.size ?? 0 }));
}

// Moving the files of a message can take longer than Prisma's 5 seconds, on a small server
const SAVE_TIMEOUT_MS = 60_000;

/**
 * Stores a user message, with the files attached to it: the drafts `uploads`
 * names, which move into the message with their text, so nothing is
 * converted or checked again. Throws UploadRefused when one of
 * them may not be sent (see takeUploads). The first message of a conversation
 * also sets its title. A message with the `requestId` of the conversation's
 * last user message is a re-send of it (see attempts.ts): the message stays,
 * with its files (drafts sent again are dropped), and what the attempt before
 * stored of its reply goes, as this attempt writes the reply again.
 */
export async function saveUserMessage(
  conversationId: string,
  content: string,
  modelKey: string,
  requestId: string | null = null,
  uploads: UploadsToSend | null = null
): Promise<{ messageId: string; resent: boolean }> {
  return prisma.$transaction(
    async (tx) => {
      if (requestId) {
        const last = await tx.message.findFirst({
          where: { conversationId, role: "user" },
          orderBy: { position: "desc" },
          select: { id: true, position: true, metadata: true },
        });
        if ((last?.metadata as { requestId?: unknown } | null)?.requestId === requestId) {
          await tx.message.deleteMany({ where: { conversationId, position: { gt: last!.position } } });
          if (uploads?.ids.length) await tx.upload.deleteMany({ where: { id: { in: uploads.ids }, userId: uploads.userId } });
          return { messageId: last!.id, resent: true };
        }
      }
      const files = uploads?.ids.length ? await takeUploads(tx, uploads) : [];
      const position = await nextPosition(tx, conversationId);
      // Two files of one message with the same name, such as photos, get different names
      const names: string[] = [];
      for (const file of files) names.push(uniqueName(file.name, names));
      const now = Date.now();
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
                  create: files.map((f, i) => ({
                    name: names[i],
                    mimeType: f.mimeType,
                    data: f.data,
                    size: f.data.length,
                    text: f.text,
                    ...(f.info ? { info: f.info } : {}),
                    // In the order they were attached
                    createdAt: new Date(now + i),
                  })),
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
    },
    { timeout: SAVE_TIMEOUT_MS, maxWait: SAVE_TIMEOUT_MS }
  );
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

/** Thrown in the transaction that stores a tool step whose files changed since the tool read them. */
class StaleFiles extends Error {
  constructor(readonly stale: StaleVersion[]) {
    super("The files changed since the tool read them.");
  }
}

/** A tool call as stored in Message.toolCalls. */
export type StoredToolCall = { id: string; name: string; arguments: Record<string, unknown> };

export type ToolResultStep = {
  call: StoredToolCall;
  content: string; // what the model gets back
  label: string; // what the chat view shows
  error: boolean;
  images: ToolImage[]; // what the model sees, such as a screenshot
  files: ToolFile[]; // files the tool made or changed: new versions in the chat's sandbox
  deletions?: string[]; // the paths of the files the tool deleted from the sandbox
  repository?: { path: string; git: string }; // a git repository's new .git folder (a gzipped tar, base64)
  shared?: FileCard[]; // files of the sandbox the tool gives the user (share_file)
  approval?: { decision: ApprovalDecision }; // what the user chose before code ran in a tainted chat
  security?: StepSecurity; // what the security checks found in the result, which the model then did not get
  expect?: ExpectedVersion[]; // the versions its files must still have: else the step is stored as an error, without them
  changeset?: string; // the id of the files an edit_files call changed together
  failedLabel?: (note: string) => string; // the label of the step when its changes could not be stored
};

/**
 * What saveToolResult stored: the ids of the images, and the cards of the
 * files (deletions left out). `failure` is what the model gets instead of the
 * tool's own text when the step's changes could not be stored, such as files
 * that changed after the tool read them; `note` says why, after the label.
 */
export type SavedToolResult = { imageIds: string[]; files: FileCard[]; failure?: { text: string; note: string } };

export type AssistantReply = {
  append(text: string): void;
  appendReasoning(text: string): void;
  /** Stores what streamed so far as a step that calls `calls`; the next text starts a new step. */
  saveToolCalls(calls: StoredToolCall[]): Promise<void>;
  /** Stores a tool's result as a tool step, with its images and files. */
  saveToolResult(step: ToolResultStep): Promise<SavedToolResult>;
  /** Adds what the user chose about a flagged result to the stored step of the call `callId`. */
  saveToolDecision(callId: string, decision: PauseDecision): Promise<void>;
  /** Stores a run of code or an install of packages of the call `callId`, for the sandbox panel. */
  saveSandboxRun(callId: string, run: RunRecord): Promise<void>;
  /** What the conversation cost so far, in US dollars; null when nothing it asked for cost anything. */
  readCost(): Promise<number | null>;
  /** Adds what a request of the reply cost, in US dollars, to what the conversation cost. */
  saveCost(usd: number): Promise<void>;
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

  // The stored tool steps of this reply by their call's id, with what they keep for the chat view
  const toolSteps = new Map<string, { id: string; metadata: Prisma.InputJsonObject }>();

  /**
   * Stores one step of the reply as the conversation's next message, and does
   * `also` in the same transaction. Returns its id and its attachments, in order.
   */
  async function saveStep(
    data: Omit<Prisma.MessageUncheckedCreateInput, "conversationId" | "position">,
    also?: (tx: Prisma.TransactionClient) => Promise<unknown>,
    before?: (tx: Prisma.TransactionClient) => Promise<void>
  ) {
    // A clone can store thousands of files at once
    return prisma.$transaction(async (tx) => {
      // A check that throws stores nothing
      await before?.(tx);
      const position = await nextPosition(tx, conversationId);
      const message = await tx.message.create({
        data: { ...data, conversationId, position },
        select: {
          id: true,
          attachments: {
            select: { id: true, name: true, mimeType: true, size: true, deleted: true },
            orderBy: { createdAt: "asc" },
          },
        },
      });
      await tx.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date(), model: modelKey },
      });
      await also?.(tx);
      return message;
    }, { timeout: SAVE_TIMEOUT_MS, maxWait: SAVE_TIMEOUT_MS });
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
    async saveToolResult({
      call,
      content,
      label,
      error,
      images,
      files,
      deletions,
      repository,
      shared,
      approval,
      security,
      expect,
      changeset,
      failedLabel,
    }) {
      const none: SavedToolResult = { imageIds: [], files: [] };
      if (saved) return none;
      const attachments: Prisma.MessageAttachmentCreateWithoutMessageInput[] = [
        ...images.map((i) => ({ mimeType: i.mimeType, data: Buffer.from(i.data, "base64") })),
        ...files.map((f) => ({
          name: f.name,
          mimeType: f.mimeType,
          data: Buffer.from(f.data, "base64"),
          ...(f.origin ? { origin: f.origin } : {}),
          ...(f.text !== undefined ? { text: f.text } : {}),
          ...(f.info ? { info: f.info as Prisma.InputJsonObject } : {}),
          // Its whole text passed the scan when it arrived: reading it needs no scan (see checkFileRead)
          ...(f.scanned ? { scans: { [WHOLE_TEXT]: { flagged: false, score: 0 } } } : {}),
          ...(f.restoredFrom ? { restoredFrom: f.restoredFrom } : {}),
        })),
        // A deletion holds no data: it marks where the file's history ends
        ...(deletions ?? []).map((name) => ({
          name,
          mimeType: "application/octet-stream",
          data: Buffer.alloc(0),
          deleted: true,
          origin: "code",
        })),
      ].map((a) => ({ ...a, size: (a.data as Buffer).length }));
      const metadata: Prisma.InputJsonObject = {
        label,
        error,
        ...(security ? { security } : {}),
        ...(shared?.length ? { shared: shared.map((f) => f.id) } : {}),
        ...(approval ? { approval } : {}),
        ...(changeset ? { changeset } : {}),
      };
      // The files must still be as the tool read them: checked in the transaction that stores the new versions
      const checkVersions = expect?.length
        ? async (tx: Prisma.TransactionClient) => {
            const stale = await staleVersions(tx, conversationId, expect);
            if (stale.length) throw new StaleFiles(stale);
          }
        : undefined;
      try {
        // A repository's .git folder changes together with its files
        const saveRepository = repository
          ? (tx: Prisma.TransactionClient) => {
              const git = Buffer.from(repository.git, "base64");
              return tx.sandboxRepo.upsert({
                where: { conversationId_path: { conversationId, path: repository.path } },
                create: { conversationId, path: repository.path, git, size: git.length },
                update: { git, size: git.length },
              });
            }
          : undefined;
        const { id, attachments: stored } = await saveStep(
          {
            role: "tool",
            content,
            toolCallId: call.id,
            toolName: call.name,
            metadata,
            attachments: attachments.length ? { create: attachments } : undefined,
          },
          saveRepository,
          checkVersions
        );
        toolSteps.set(call.id, { id, metadata });
        return {
          imageIds: stored.filter((a) => a.name === null).map((a) => a.id),
          files: stored
            .filter((a) => a.name !== null && !a.deleted)
            .map((a) => ({ id: a.id, name: a.name!, mimeType: a.mimeType, size: a.size ?? 0 })),
        };
      } catch (err) {
        const changes = files.length > 0 || !!deletions?.length || !!repository;
        if (!(err instanceof StaleFiles)) console.error(`Storing the result of ${call.name} failed: ${(err as Error)?.message || err}`);
        if (!changes) return none;
        // The model must not take changes that were not stored for done
        const failure =
          err instanceof StaleFiles
            ? { text: staleText(err.stale), note: "files changed meanwhile" }
            : { text: "Error: the result could not be stored, so the sandbox did not change. Try again.", note: "not stored" };
        // The step is stored as the error it became, without its files
        try {
          const errorMeta: Prisma.InputJsonObject = { ...metadata, label: failedLabel?.(failure.note) ?? label, error: true };
          const { id } = await saveStep({ role: "tool", content: failure.text, toolCallId: call.id, toolName: call.name, metadata: errorMeta });
          toolSteps.set(call.id, { id, metadata: errorMeta });
        } catch {
          // As with persist(): the reply goes on even if a step cannot be stored.
        }
        return { ...none, failure };
      }
    },
    async saveSandboxRun(callId, run) {
      try {
        await prisma.sandboxRun.create({
          data: {
            conversationId,
            toolCallId: callId,
            kind: run.kind,
            language: run.language,
            code: run.code,
            output: run.output,
            status: run.status,
            durationMs: run.durationMs,
            ...(run.id ? { id: run.id } : {}),
            ...(run.printedBytes !== undefined ? { printedBytes: run.printedBytes } : {}),
            ...(run.files ? { files: run.files } : {}),
          },
        });
      } catch (err) {
        console.error(`Storing a run failed: ${(err as Error)?.message || err}`);
      }
    },
    readCost: () => conversationCost(conversationId),
    // Also after the reply was stored: what was asked for was paid
    saveCost: (usd) => addConversationCost(conversationId, usd),
    async saveToolDecision(callId, decision) {
      const step = toolSteps.get(callId);
      const security = step?.metadata.security;
      if (!step || !security) return;
      try {
        // Also after the reply was stopped: the choice then was "stop"
        await prisma.message.update({
          where: { id: step.id },
          data: { metadata: { ...step.metadata, security: { ...(security as Prisma.InputJsonObject), decision } } },
        });
      } catch {
        // As with persist(): the reply goes on even if this cannot be stored.
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
