// The conversation as a model gets it: a view of the stored steps (the
// transcript). The transcript only grows, and holds every step as the model
// was given it; the view is the whole of it while it fits in the model's
// context window, and a reduced one when it does not (see reduce.ts and
// checkpoint.ts). What was reduced is stored with the steps, so the view is
// the same on every request.
//
// A reply that used tools is sent as it happened: the model's tool calls, the
// results it got, then its answer. The chat backends turn these messages into
// what their API takes (see openai.ts, openaiResponses.ts and ollama.ts).

import type { Prisma } from "@prisma/client";
import type { ContextFill } from "@/lib/types";
import { prisma } from "@/server/db/prisma";
import { addFiles, HISTORY_ATTACHMENT_SELECT, type FileHistoryOptions, type HistoryAttachment } from "@/server/files/history";
import type { ReadFact } from "@/server/tools/definitions";
import type { ToolImage } from "@/server/tools/mcp";
import type { StoredToolCall } from "./conversation";

/** A run of code or an install behind a tool step, as its pointer names it. */
export type StepRun = { id: string; kind: string; status: string };

/**
 * What llmlynx knows of a stored tool step besides what the model gets of
 * it. Never sent: it says what the step was, for clearing it and for the
 * pointer that takes its place.
 */
export type StepInfo = {
  rowId: string;
  position: number; // its place in the conversation, which read_result takes as the result's number
  error: boolean;
  chars: number; // the length of its result as the model got it first
  cleared: boolean; // its result is a pointer now
  hash?: string; // of the result's own text, to tell a second copy of it
  sameAs?: string; // the step whose identical result this one refers to, in place of its own text
  read?: ReadFact; // read_file: what it showed of which file
  run?: StepRun;
  files: string[]; // the paths of the files it made or changed
  deleted: string[]; // the paths of the files it deleted
  imageIds: string[]; // its stored images, also those that are no longer sent
};

export type SystemMessage = { role: "system"; content: string };

/** `memory` is the working memory at the end of `content` (see memory.ts); `summary` says it starts with a checkpoint's summary. */
export type UserMessage = {
  role: "user";
  content: string;
  images?: ToolImage[];
  rowId?: string;
  position?: number; // its place in the conversation, as stored
  memory?: string;
  summary?: boolean;
};

/**
 * A step of a reply. `calls` are the tools it called. `extra` is what its
 * provider needs back with a step of the reply that is still running, such as
 * signed reasoning: only the backend that made it reads it.
 */
export type AssistantMessage = {
  role: "assistant";
  content: string;
  calls?: StoredToolCall[];
  extra?: unknown;
  rowId?: string;
  position?: number; // its place in the conversation, as stored
};

/** The result of the call `callId`, as the model gets it: its text, or the pointer to it once it was cleared. */
export type ToolMessage = { role: "tool"; callId: string; name: string; content: string; images?: ToolImage[]; step?: StepInfo };

export type ViewMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

/** A checkpoint as stored: a system step whose text is the summary, and what it covers. */
export type CheckpointMeta = {
  upTo: number; // the position of the last step the summary stands for
  by: "user" | "auto"; // the user asked for it (/compact), or the window was full
  keep?: string; // what the user asked to keep
  memory?: string; // the working memory that went with the summary (see memory.ts)
  attached?: string; // the files that went with the summary: the current text of those used last
  fill?: ContextFill; // how full the model's window was right after it, for the chat view's indicator
};

export type StoredCheckpoint = CheckpointMeta & { id: string; position: number; summary: string };

/** What a model gets in place of the result of a call that never finished: providers refuse a call without one. */
export const STOPPED_RESULT = "Error: not run: the reply was stopped before this call finished.";

// Between a checkpoint's summary and the message that follows it in one user message
const AFTER_SUMMARY = "[End of the summary. The conversation goes on here.]";

/**
 * Puts a checkpoint's `summary` at the start of `messages`, the steps after
 * what it covers: as a user message of its own, or at the start of the user
 * message that follows it, as not all models take two user messages in a row.
 */
export function withSummary(messages: ViewMessage[], summary: string): ViewMessage[] {
  const first = messages[0];
  if (first?.role !== "user") return [{ role: "user", content: summary, summary: true }, ...messages];
  first.content = [summary, AFTER_SUMMARY, first.content].filter(Boolean).join("\n\n");
  first.summary = true;
  return messages;
}

const asText = (value: unknown) => (typeof value === "string" ? value : undefined);

/** The tool calls of a stored assistant step. */
export function storedCalls(value: Prisma.JsonValue | null | undefined): StoredToolCall[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[])
    .filter((c): c is StoredToolCall => !!c && typeof (c as StoredToolCall).id === "string" && typeof (c as StoredToolCall).name === "string")
    .map((c) => ({ id: c.id, name: c.name, arguments: c.arguments && typeof c.arguments === "object" ? c.arguments : {} }));
}

/** The checkpoint a row holds, or null when the row is not one. */
export function checkpointOf(row: { id: string; position: number; content: string; metadata: unknown }): StoredCheckpoint | null {
  const meta = (row.metadata as { checkpoint?: Partial<CheckpointMeta> } | null)?.checkpoint;
  if (!meta || typeof meta.upTo !== "number") return null;
  return {
    id: row.id,
    position: row.position,
    summary: row.content,
    upTo: meta.upTo,
    by: meta.by === "user" ? "user" : "auto",
    ...(asText(meta.keep) ? { keep: meta.keep } : {}),
    ...(asText(meta.memory) ? { memory: meta.memory } : {}),
    ...(asText(meta.attached) ? { attached: meta.attached } : {}),
    ...(typeof meta.fill?.used === "number" && typeof meta.fill.full === "number" ? { fill: { used: meta.fill.used, full: meta.fill.full } } : {}),
  };
}

/** The conversation's newest checkpoint: the model gets its summary in place of the steps it covers. */
export async function lastCheckpoint(conversationId: string): Promise<StoredCheckpoint | null> {
  const rows = await prisma.message.findMany({
    where: { conversationId, role: "system" },
    orderBy: { position: "desc" },
    select: { id: true, position: true, content: true, metadata: true },
  });
  for (const row of rows) {
    const checkpoint = checkpointOf(row);
    if (checkpoint) return checkpoint;
  }
  return null;
}

/** The summary of a checkpoint as the model gets it, with the working memory and the files that went with it. */
export const summaryText = (checkpoint: Pick<StoredCheckpoint, "summary" | "memory" | "attached">) =>
  [checkpoint.summary, checkpoint.memory, checkpoint.attached].filter(Boolean).join("\n\n");

/** A long text argument cut short, for a note about a call: the note is about what was called, not a copy of it. */
function shortArguments(args: Record<string, unknown>): string {
  const short = (value: unknown): unknown =>
    typeof value === "string" && value.length > 300
      ? `${value.slice(0, 200)}… [${value.length} characters]`
      : Array.isArray(value)
        ? value.map(short)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, short(v)]))
          : value;
  return JSON.stringify(short(args));
}

/**
 * The steps of one reply as one assistant message of text: what it wrote,
 * and for each tool call what was called and what came back. For a model that
 * cannot take the calls themselves (see textForm).
 */
function textNotes(group: (AssistantMessage | ToolMessage)[]): AssistantMessage | null {
  const calls = new Map<string, StoredToolCall>();
  const parts: string[] = [];
  for (const message of group) {
    if (message.role === "assistant") {
      for (const call of message.calls ?? []) calls.set(call.id, call);
      if (message.content.trim()) parts.push(message.content.trim());
      continue;
    }
    const call = calls.get(message.callId);
    parts.push(
      `[Earlier tool use: ${message.name} ${shortArguments(call?.arguments ?? {})}. Its result follows.]\n` +
        `${message.content || "(No text.)"}\n[End of the result of ${message.name}.]`
    );
  }
  const first = group.find((m): m is AssistantMessage => m.role === "assistant");
  if (!parts.length) return null;
  return { role: "assistant", content: parts.join("\n\n"), ...(first?.position !== undefined ? { position: first.position } : {}) };
}

/**
 * The view with replies that used tools as text notes, where the model
 * cannot take their tool calls: every such reply (`all`: a plain chat, or a
 * provider that refuses them), or those that called a tool that is not
 * `offered` now. The replies from `keepFrom` on stay as they are: the reply
 * that is running.
 */
export function textForm(messages: ViewMessage[], offered: Set<string>, all: boolean, keepFrom = messages.length): ViewMessage[] {
  const out: ViewMessage[] = [];
  let group: (AssistantMessage | ToolMessage)[] = [];
  const close = () => {
    const usedTools = group.some((m) => m.role === "assistant" && m.calls?.length);
    const unknown = group.some((m) => m.role === "assistant" && m.calls?.some((c) => !offered.has(c.name)));
    if (usedTools && (all || unknown)) {
      const notes = textNotes(group);
      if (notes) out.push(notes);
    } else out.push(...group);
    group = [];
  };
  messages.forEach((message, i) => {
    if (i >= keepFrom) {
      close();
      out.push(message);
    } else if (message.role === "assistant" || message.role === "tool") group.push(message);
    else {
      close();
      out.push(message);
    }
  });
  close();
  return out;
}

/** Where the reply that is running starts in the view: after the last message of the user. */
export function replyStart(messages: ViewMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user" || messages[i].role === "system") return i + 1;
  return 0;
}

/** True when the view has tool calls of replies before the one that is running. */
export const hasEarlierCalls = (messages: ViewMessage[]) =>
  messages.slice(0, replyStart(messages)).some((m) => m.role === "assistant" && !!m.calls?.length);

/** A user message with its working memory: the memory is the end of its text. */
export function withMemory(content: string, memory: string | undefined): string {
  return memory ? (content ? `${content}\n\n${memory}` : memory) : content;
}

/** The message without its working memory, as it is once a newer copy replaced it. */
export function withoutMemory(message: UserMessage): void {
  if (!message.memory) return;
  if (message.content.endsWith(message.memory)) message.content = message.content.slice(0, -message.memory.length).trimEnd();
  delete message.memory;
}

/** What a result that had images says once they are no longer sent. */
export const IMAGES_GONE = "[Its image is no longer shown here, to save room.]";

export type ViewOptions = {
  /** User messages carry their files (see server/files/history.ts); without, only their text. */
  files?: FileHistoryOptions;
  /** The names of the tools the model can call now; none for a plain chat. */
  tools: string[];
};

const STEP_SELECT = {
  id: true,
  position: true,
  role: true,
  content: true,
  toolCalls: true,
  toolCallId: true,
  toolName: true,
  metadata: true,
} satisfies Prisma.MessageSelect;

type StepRow = Prisma.MessageGetPayload<{ select: typeof STEP_SELECT }>;

type ToolMeta = {
  error?: unknown;
  pointer?: unknown;
  args?: unknown; // the call's arguments once they were cut short, see reduce.ts
  hash?: unknown;
  sameAs?: unknown;
  read?: unknown;
  run?: unknown;
  chars?: unknown;
  imagesCleared?: unknown;
};

function readFact(value: unknown): ReadFact | undefined {
  const fact = value as Partial<ReadFact> | null;
  if (!fact || typeof fact.fileId !== "string" || typeof fact.name !== "string") return undefined;
  if (typeof fact.from !== "number" || typeof fact.to !== "number" || typeof fact.total !== "number") return undefined;
  return { fileId: fact.fileId, name: fact.name, unit: fact.unit === "lines" ? "lines" : "characters", from: fact.from, to: fact.to, total: fact.total };
}

function stepRun(value: unknown): StepRun | undefined {
  const run = value as Partial<StepRun> | null;
  return run && typeof run.id === "string" ? { id: run.id, kind: String(run.kind ?? "run"), status: String(run.status ?? "") } : undefined;
}

/**
 * The conversation as the model gets it, read from the database, without its
 * system prompt: the newest checkpoint's summary, when there is one, and
 * every step after what it covers.
 *
 * It is repaired where the stored steps are not what a provider takes: a
 * reply without text and without calls is left out, a call whose result was
 * never stored (the reply was stopped) gets one that says so, and a result
 * without its call is left out.
 */
export async function loadView(conversationId: string, options: ViewOptions): Promise<ViewMessage[]> {
  const checkpoint = await lastCheckpoint(conversationId);
  const after = checkpoint?.upTo ?? -1;
  const rows: StepRow[] = await prisma.message.findMany({
    where: { conversationId, role: { in: ["user", "assistant", "tool"] }, position: { gt: after } },
    orderBy: { position: "asc" },
    select: STEP_SELECT,
  });

  // What the tool steps stored: files (their names only) and images
  const stored = await prisma.messageAttachment.findMany({
    where: { message: { conversationId, role: "tool", position: { gt: after } }, parentId: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, messageId: true, name: true, deleted: true },
  });
  const storedBy = new Map<string, typeof stored>();
  for (const a of stored) storedBy.set(a.messageId, [...(storedBy.get(a.messageId) ?? []), a]);

  const messages: ViewMessage[] = [];
  const users: { message: UserMessage; row: StepRow }[] = [];
  const shownImages = new Map<string, ToolMessage>(); // image id -> the result it belongs to
  // The calls of the last assistant step that still wait for their result
  let open = new Map<string, StoredToolCall>();
  const closeCalls = () => {
    for (const call of open.values()) messages.push({ role: "tool", callId: call.id, name: call.name, content: STOPPED_RESULT });
    open = new Map();
  };

  for (const row of rows) {
    if (row.role === "user") {
      closeCalls();
      const message: UserMessage = { role: "user", content: row.content, rowId: row.id, position: row.position };
      messages.push(message);
      users.push({ message, row });
      continue;
    }
    if (row.role === "assistant") {
      closeCalls();
      const calls = storedCalls(row.toolCalls);
      // Stopped before the model wrote anything
      if (!calls.length && !row.content.trim()) continue;
      messages.push({ role: "assistant", content: row.content, rowId: row.id, position: row.position, ...(calls.length ? { calls } : {}) });
      open = new Map(calls.map((call) => [call.id, call]));
      continue;
    }
    const call = row.toolCallId ? open.get(row.toolCallId) : undefined;
    if (!call) continue;
    open.delete(call.id);
    const meta = (row.metadata ?? {}) as ToolMeta;
    const attachments = storedBy.get(row.id) ?? [];
    const pointer = asText(meta.pointer);
    // A cleared step's long arguments were cut short with it
    if (pointer !== undefined && meta.args && typeof meta.args === "object") call.arguments = meta.args as Record<string, unknown>;
    const imageIds = attachments.filter((a) => !a.name).map((a) => a.id);
    const message: ToolMessage = {
      role: "tool",
      callId: call.id,
      name: row.toolName ?? call.name,
      content: pointer ?? row.content,
      step: {
        rowId: row.id,
        position: row.position,
        error: meta.error === true,
        chars: typeof meta.chars === "number" ? meta.chars : row.content.length,
        cleared: pointer !== undefined,
        ...(asText(meta.hash) ? { hash: meta.hash as string } : {}),
        ...(asText(meta.sameAs) ? { sameAs: meta.sameAs as string } : {}),
        ...(readFact(meta.read) ? { read: readFact(meta.read) } : {}),
        ...(stepRun(meta.run) ? { run: stepRun(meta.run) } : {}),
        files: attachments.filter((a) => a.name && !a.deleted).map((a) => a.name!),
        deleted: attachments.filter((a) => a.name && a.deleted).map((a) => a.name!),
        imageIds,
      },
    };
    if (imageIds.length) {
      // A model that cannot see gets no images; nor does one whose images of this step were cleared
      const shown = !!options.files?.vision && pointer === undefined && meta.imagesCleared !== true;
      if (shown) for (const id of imageIds) shownImages.set(id, message);
      else if (pointer === undefined) message.content = [message.content, IMAGES_GONE].filter(Boolean).join("\n\n");
    }
    messages.push(message);
  }
  closeCalls();

  if (shownImages.size) {
    const data = await prisma.messageAttachment.findMany({
      where: { id: { in: [...shownImages.keys()] } },
      orderBy: { createdAt: "asc" },
      select: { id: true, mimeType: true, data: true },
    });
    for (const image of data) {
      const message = shownImages.get(image.id)!;
      message.images = [...(message.images ?? []), { mimeType: image.mimeType, data: Buffer.from(image.data).toString("base64") }];
    }
  }

  await addUserFiles(users, options.files);
  for (const { message, row } of users) {
    const meta = (row.metadata ?? {}) as { memory?: unknown; memoryCleared?: unknown };
    const memory = meta.memoryCleared === true ? undefined : asText(meta.memory);
    if (!memory) continue;
    message.content = withMemory(message.content, memory);
    message.memory = memory;
  }

  const view = checkpoint ? withSummary(messages, summaryText(checkpoint)) : messages;
  const offered = new Set(options.tools);
  return textForm(view, offered, offered.size === 0);
}

/** Adds their files to the user messages: the text of the files and, for a model that can see, their images. */
async function addUserFiles(users: { message: UserMessage; row: StepRow }[], files: FileHistoryOptions | undefined) {
  if (!users.length) return;
  const ids = users.map(({ row }) => row.id);
  if (!files) {
    // A message of only files still keeps its place between the replies
    const empty = users.filter(({ row }) => !row.content);
    if (!empty.length) return;
    const names = await prisma.messageAttachment.findMany({
      where: { messageId: { in: empty.map(({ row }) => row.id) }, parentId: null, name: { not: null } },
      orderBy: { createdAt: "asc" },
      select: { messageId: true, name: true },
    });
    for (const { message, row } of empty) {
      const own = names.filter((n) => n.messageId === row.id).map((n) => n.name);
      message.content = `[Files you cannot see: ${own.join(", ")}]`;
    }
    return;
  }
  const attachments = await prisma.messageAttachment.findMany({
    where: { messageId: { in: ids }, ...HISTORY_ATTACHMENT_SELECT.where },
    orderBy: HISTORY_ATTACHMENT_SELECT.orderBy,
    select: { messageId: true, ...HISTORY_ATTACHMENT_SELECT.select },
  });
  const byMessage = new Map<string, HistoryAttachment[]>();
  for (const { messageId, ...attachment } of attachments) byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), attachment]);
  const withFiles = await addFiles(
    users.map(({ message }) => ({ role: "user" as const, content: message.content })),
    users.map(({ row }) => byMessage.get(row.id) ?? []),
    files
  );
  users.forEach(({ message }, i) => {
    message.content = withFiles[i].content;
    if (withFiles[i].images?.length) message.images = withFiles[i].images;
  });
}

/** Changes to the metadata of stored steps: each `patch` is merged into what the step has. */
export async function patchMetadata(patches: { id: string; patch: Record<string, unknown> }[]): Promise<void> {
  if (!patches.length) return;
  await prisma.$transaction(async (tx) => {
    for (const { id, patch } of patches) {
      const row = await tx.message.findUnique({ where: { id }, select: { metadata: true } });
      if (!row) continue;
      const metadata = { ...((row.metadata as Record<string, unknown> | null) ?? {}), ...patch };
      await tx.message.update({ where: { id }, data: { metadata: metadata as Prisma.InputJsonObject } });
    }
  });
}
