// What a reply shows while it streams in, built up from the lines of the
// NDJSON stream of /api/chat (see useChat.ts). Free of React, so a recorded
// stream can be replayed through it line by line (see streamedReply.test.ts).

import { withFileCards, type FileCard } from "@/lib/files";
import { addReasoning, addText, upsertToolStep } from "@/lib/trace";
import type { Checkpoint, ToolStep, TraceItem } from "@/lib/types";

export type StreamedReply = {
  // Everything the reply did so far, in order: reasoning, text, tool calls and checkpoints
  trace: TraceItem[];
  // The files the agent made, each once
  files: FileCard[];
  // The sandbox's image files, which the names in the reply's text are matched against (see lib/inlineImages.ts)
  imageFiles: FileCard[];
  error?: string;
  // The stream's { end } line came: it was not cut off
  ended: boolean;
};

export const NEW_REPLY: StreamedReply = { trace: [], files: [], imageFiles: [], ended: false };

export const isFileList = (value: unknown): value is FileCard[] =>
  Array.isArray(value) && value.every((f) => typeof f?.id === "string" && typeof f?.name === "string");

// A { tool } line: a new step (with all fields), or an update of one (with its id)
export const isToolLine = (value: unknown): value is Partial<ToolStep> & { id: string } =>
  !!value && typeof value === "object" && typeof (value as ToolStep).id === "string";

// A { pause } line: the reply waits for the user's choice about the tool call `tool`
const isPauseLine = (value: unknown): value is { id: string; tool: string } =>
  !!value && typeof (value as { id?: unknown }).id === "string" && typeof (value as { tool?: unknown }).tool === "string";

// A { checkpoint } line: older steps were summarised for the model, as its context window was full
const isCheckpointLine = (value: unknown): value is Checkpoint =>
  !!value && typeof (value as Checkpoint).id === "string" && typeof (value as Checkpoint).summary === "string";

/** The trace without the pauses that are still open: their reply is over, so there is nothing left to choose. */
const withoutPauses = (trace: TraceItem[]): TraceItem[] =>
  trace.map((item) => (item.kind === "tool" && item.step.pauseId ? { kind: "tool", step: { ...item.step, pauseId: undefined } } : item));

// White space that would start a text or reasoning item does not change the trace
const withTrace = (reply: StreamedReply, trace: TraceItem[]): StreamedReply => (trace === reply.trace ? reply : { ...reply, trace });

/** The reply after one line of the stream; the same object when the line does not change it. */
export function readReplyLine(reply: StreamedReply, value: unknown): StreamedReply {
  const line = value as {
    message?: { content?: unknown; thinking?: unknown };
    tool?: unknown;
    pause?: unknown;
    checkpoint?: unknown;
    files?: unknown;
    images?: unknown;
    error?: unknown;
    end?: unknown;
  } | null;
  let next = reply;
  if (line?.end === true) next = { ...next, ended: true };
  // Files the agent made show below its answer, each once
  if (isFileList(line?.files)) next = { ...next, files: withFileCards(next.files, line.files) };
  // Sent before a request of the model, when they changed: the list in full
  if (isFileList(line?.images)) next = { ...next, imageFiles: line.images };
  if (isToolLine(line?.tool)) next = { ...next, trace: upsertToolStep(next.trace, line.tool) };
  // The reply waits: the tool line of that call offers the choice
  if (isPauseLine(line?.pause)) {
    next = { ...next, trace: upsertToolStep(next.trace, { id: line.pause.tool, pauseId: line.pause.id }) };
  }
  // It shows in the trace, where it happened
  if (isCheckpointLine(line?.checkpoint)) {
    const { id, summary } = line.checkpoint;
    next = { ...next, trace: [...next.trace, { kind: "checkpoint", checkpoint: { id, summary, by: "auto" } }] };
  }
  const thought = line?.message?.thinking;
  if (typeof thought === "string" && thought) next = withTrace(next, addReasoning(next.trace, thought));
  const delta = line?.message?.content;
  if (typeof delta === "string" && delta) next = withTrace(next, addText(next.trace, delta));
  // Ollama and the OpenAI-compatible providers report a failed chat as an { error } line, which ends the reply
  if (typeof line?.error === "string" && line.error) next = { ...next, error: line.error };
  return next;
}

/** The reply once its stream is over. */
export const endReply = (reply: StreamedReply): StreamedReply => ({ ...reply, trace: withoutPauses(reply.trace) });
