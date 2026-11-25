// Turns a conversation's stored steps into the messages the chat view shows.
// The steps of one reply (assistant steps that call tools, the tool results,
// and the answer) become one message: its trace holds the reasoning, the text
// of each step, and the tool calls, in order; its content is all that text,
// and its files those the file tools made, the images, SVG and HTML a
// run of code made, and those the model shared (see shownInChat), each once,
// as its newest version (see withFileCards). A user
// message's files are those the user attached. A checkpoint (see
// checkpoint.ts) is a marker: one the user asked for stands between the
// messages, one made while a reply ran is in that reply's trace.

import type { Prisma } from "@prisma/client";
import { toolIcon } from "@/lib/agentTools";
import { shownInChat, withFileCards, type FileCard } from "@/lib/files";
import { addReasoning, addText, traceText, upsertToolStep } from "@/lib/trace";
import type { Checkpoint, ContextFill, ConversationWithMessages, Role, StepSecurity, ToolStep, TraceItem } from "@/lib/types";
import { toolLabel } from "@/server/tools/definitions";
import { MAX_COUNTED_WINDOW } from "./budget";
import type { StoredToolCall } from "./conversation";
import { checkpointOf } from "./view";

/** What GET /api/conversations/:id selects of each message. */
export const DISPLAY_MESSAGE_SELECT = {
  id: true,
  position: true,
  role: true,
  content: true,
  reasoning: true,
  toolCalls: true,
  toolCallId: true,
  toolName: true,
  metadata: true,
  createdAt: true,
  // Images made for the model from another attachment are not shown, nor what marks a deleted file
  attachments: {
    where: { parentId: null, deleted: false },
    select: { id: true, name: true, mimeType: true, size: true },
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.MessageSelect;

type Row = Prisma.MessageGetPayload<{ select: typeof DISPLAY_MESSAGE_SELECT }>;

type DisplayRow = ConversationWithMessages["messages"][number];

/** The named attachments (files) of a row; a screenshot has no name. */
const filesOf = (row: Row): FileCard[] =>
  row.attachments.flatMap((a) => (a.name ? [{ id: a.id, name: a.name, mimeType: a.mimeType, size: a.size ?? 0 }] : []));

/** What the security checks found in a tool step's result, as stored in its metadata. */
function storedSecurity(value: unknown): StepSecurity | null {
  const { flag, source, decision, chunk, falsePositive } = (value ?? {}) as Record<string, unknown>;
  if (flag !== "injection" && flag !== "virus" && flag !== "unchecked") return null;
  return {
    flag,
    ...(typeof source === "string" ? { source } : {}),
    ...(decision === "remove" || decision === "stop" ? { decision } : {}),
    ...(typeof chunk === "string" && chunk ? { chunk } : {}),
    ...(flag === "injection" && falsePositive === true ? { falsePositive } : {}),
  };
}

/** The user's answer when they were asked before code ran, as stored in a tool step's metadata. */
function storedApproval(value: unknown): ToolStep["approval"] | null {
  if (!value || typeof value !== "object") return null;
  const { decision } = value as { decision?: unknown };
  return decision === "run" || decision === "skip" ? { decision } : {};
}

/** The ids of the files a tool step shared with the user (share_file), from its metadata. */
export function sharedIds(metadata: unknown): string[] {
  const shared = (metadata as { shared?: unknown } | null)?.shared;
  return Array.isArray(shared) ? shared.filter((id): id is string => typeof id === "string") : [];
}

function storedCalls(value: Prisma.JsonValue): StoredToolCall[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter((c): c is StoredToolCall => !!c && typeof (c as StoredToolCall).id === "string")
    : [];
}

/** `shared` holds the cards of the files that tool steps shared, by id (see sharedIds). */
export function toDisplayMessages(rows: Row[], shared: Map<string, FileCard> = new Map()): DisplayRow[] {
  const out: DisplayRow[] = [];
  let reply: (DisplayRow & { trace: TraceItem[] }) | null = null;

  for (const row of rows) {
    if (row.role === "system") {
      const stored = checkpointOf(row);
      // Other system steps are not part of what the chat view shows
      if (!stored) continue;
      const checkpoint: Checkpoint = { id: stored.id, summary: stored.summary, by: stored.by };
      if (stored.by === "user") {
        // It can be taken back while it is the last step: nothing was said since
        reply = null;
        const last = row === rows[rows.length - 1];
        out.push({ id: row.id, role: "system", content: "", checkpoint: { ...checkpoint, ...(last ? { canUndo: true } : {}) }, createdAt: row.createdAt.toISOString() });
        continue;
      }
      // Made while a reply ran: it shows in that reply's trace, where it happened
      if (!reply) {
        reply = { id: row.id, role: "assistant", content: "", trace: [], createdAt: row.createdAt.toISOString() };
        out.push(reply);
      }
      reply.trace = [...reply.trace, { kind: "checkpoint", checkpoint }];
      continue;
    }
    if (row.role === "user") {
      reply = null;
      const files = filesOf(row);
      out.push({
        id: row.id,
        role: row.role as Role,
        content: row.content,
        ...(files.length ? { files } : {}),
        createdAt: row.createdAt.toISOString(),
      });
      continue;
    }
    if (row.role === "assistant") {
      if (!reply) {
        reply = { id: row.id, role: "assistant", content: "", trace: [], createdAt: row.createdAt.toISOString() };
        out.push(reply);
      }
      // Each step's reasoning and text start a new trace item or paragraph
      reply.trace = addReasoning(reply.trace, row.reasoning ?? "", true);
      reply.trace = addText(reply.trace, row.content, true);
      // A call without a stored result was stopped, or its result could not be stored
      for (const call of storedCalls(row.toolCalls)) {
        reply.trace = upsertToolStep(reply.trace, {
          id: call.id,
          name: call.name,
          label: toolLabel(call.name, call.arguments ?? {}, "error"),
          icon: toolIcon(call.name),
          state: "error",
        });
      }
      continue;
    }
    // A tool step: fill in the result of its call
    if (!reply) continue;
    const meta = (row.metadata ?? {}) as { label?: unknown; error?: unknown; security?: unknown; approval?: unknown };
    const security = storedSecurity(meta.security);
    const approval = storedApproval(meta.approval);
    const known = reply.trace.some((item) => item.kind === "tool" && item.step.id === row.toolCallId);
    if (!known || !row.toolCallId) continue;
    const screenshot = row.attachments.find((a) => !a.name);
    reply.trace = upsertToolStep(reply.trace, {
      id: row.toolCallId,
      state: meta.error === true ? "error" : "done",
      ...(typeof meta.label === "string" ? { label: meta.label } : {}),
      ...(screenshot ? { attachmentId: screenshot.id } : {}),
      ...(security ? { security } : {}),
      ...(security?.flag === "injection" ? { rowId: row.id } : {}),
      ...(approval ? { approval } : {}),
    });
    const files = [
      ...shownInChat(row.toolName ?? "", filesOf(row)),
      ...sharedIds(row.metadata).flatMap((id) => shared.get(id) ?? []),
    ];
    if (files.length) reply.files = withFileCards(reply.files ?? [], files);
  }

  for (const message of out) {
    if (message.role === "assistant") message.content = traceText(message.trace ?? []);
    if (message.trace?.length === 0) delete message.trace;
  }
  return out;
}

/**
 * How full the model's context window was after the conversation's last
 * step that says so: a request of a reply (the tokens it took, in the window
 * it ran in), or a checkpoint after it. Null when no step says.
 */
export function contextFill(rows: Pick<Row, "id" | "position" | "role" | "content" | "metadata">[]): ContextFill | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.role === "system") {
      const fill = checkpointOf(row)?.fill;
      if (fill) return fill;
    }
    const usage = row.role === "assistant" ? (row.metadata as { usage?: { input?: unknown; output?: unknown; window?: unknown } } | null)?.usage : null;
    if (usage && typeof usage.input === "number" && typeof usage.window === "number" && usage.window > 0) {
      const output = typeof usage.output === "number" ? usage.output : 0;
      return { used: usage.input + output, full: Math.floor(Math.min(usage.window, MAX_COUNTED_WINDOW) * 0.7) };
    }
  }
  return null;
}
