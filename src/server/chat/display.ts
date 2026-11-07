// Turns a conversation's stored steps into the messages the chat view shows.
// The steps of one reply (assistant steps that call tools, the tool results,
// and the answer) become one message: its trace holds the reasoning, any text
// written before a tool call, and the tool calls, in order; its content is the
// answer, and its files those the file tools made. A user message's files are
// those the user attached.

import type { Prisma } from "@prisma/client";
import { toolIcon } from "@/lib/agentTools";
import type { FileCard } from "@/lib/files";
import { addReasoning, upsertToolStep } from "@/lib/trace";
import type { ConversationWithMessages, Role, TraceItem } from "@/lib/types";
import { toolLabel } from "@/server/tools/definitions";
import type { StoredToolCall } from "./conversation";

/** What GET /api/conversations/:id selects of each message. */
export const DISPLAY_MESSAGE_SELECT = {
  id: true,
  role: true,
  content: true,
  reasoning: true,
  toolCalls: true,
  toolCallId: true,
  metadata: true,
  createdAt: true,
  // Images made for the model from another attachment are not shown
  attachments: {
    where: { parentId: null },
    select: { id: true, name: true, mimeType: true, size: true },
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.MessageSelect;

type Row = Prisma.MessageGetPayload<{ select: typeof DISPLAY_MESSAGE_SELECT }>;

type DisplayRow = ConversationWithMessages["messages"][number];

/** The named attachments (files) of a row; a screenshot has no name. */
const filesOf = (row: Row): FileCard[] =>
  row.attachments.flatMap((a) => (a.name ? [{ id: a.id, name: a.name, mimeType: a.mimeType, size: a.size ?? 0 }] : []));

function storedCalls(value: Prisma.JsonValue): StoredToolCall[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter((c): c is StoredToolCall => !!c && typeof (c as StoredToolCall).id === "string")
    : [];
}

export function toDisplayMessages(rows: Row[]): DisplayRow[] {
  const out: DisplayRow[] = [];
  let reply: (DisplayRow & { trace: TraceItem[] }) | null = null;

  for (const row of rows) {
    if (row.role === "user" || row.role === "system") {
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
      // Each step's reasoning starts a new trace item or paragraph
      reply.trace = addReasoning(reply.trace, row.reasoning ?? "", true);
      const calls = storedCalls(row.toolCalls);
      if (calls.length === 0) {
        reply.content = reply.content && row.content ? `${reply.content}\n\n${row.content}` : reply.content || row.content;
        continue;
      }
      // Text written before calling tools is part of the trace, not the answer
      reply.trace = addReasoning(reply.trace, row.content, true);
      // A call without a stored result was stopped, or its result could not be stored
      for (const call of calls) {
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
    const meta = (row.metadata ?? {}) as { label?: unknown; error?: unknown };
    const known = reply.trace.some((item) => item.kind === "tool" && item.step.id === row.toolCallId);
    if (!known || !row.toolCallId) continue;
    const screenshot = row.attachments.find((a) => !a.name);
    reply.trace = upsertToolStep(reply.trace, {
      id: row.toolCallId,
      state: meta.error === true ? "error" : "done",
      ...(typeof meta.label === "string" ? { label: meta.label } : {}),
      ...(screenshot ? { attachmentId: screenshot.id } : {}),
    });
    const files = filesOf(row);
    if (files.length) reply.files = [...(reply.files ?? []), ...files];
  }

  for (const message of out) {
    if (message.trace?.length === 0) delete message.trace;
  }
  return out;
}
