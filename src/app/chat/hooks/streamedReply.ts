// What a reply shows while it streams in, built up from the lines of the
// NDJSON stream of /api/chat (see useChat.ts). Free of React, so a recorded
// stream can be replayed through it line by line (see streamedReply.test.ts).

import { withFileCards, type FileCard } from "@/lib/files";
import { addReasoning, addToAnswer, looksLikeAnswer, upsertToolStep } from "@/lib/trace";
import type { ToolStep, TraceItem } from "@/lib/types";

export type StreamedReply = {
  // The text of earlier steps that shows as the answer (see looksLikeAnswer)
  answer: string;
  // The text of the current step: the answer, unless a tool call follows it
  text: string;
  // Whether `text` shows as the answer yet. While the model can call tools,
  // it is held back until it looks like an answer or the reply ends: a model
  // only says it calls a tool after the text before the call. Once shown, it
  // stays in the answer.
  shown: boolean;
  // The reasoning and tool calls so far, in order
  trace: TraceItem[];
  // The files the agent made, each once
  files: FileCard[];
  error?: string;
  // The stream's { end } line came: it was not cut off
  ended: boolean;
};

export const NEW_REPLY: StreamedReply = { answer: "", text: "", shown: false, trace: [], files: [], ended: false };

/** The text that shows as the answer. */
export const shownText = ({ answer, text, shown }: StreamedReply) => (shown ? addToAnswer(answer, text) : answer);

export const isFileList = (value: unknown): value is FileCard[] =>
  Array.isArray(value) && value.every((f) => typeof f?.id === "string" && typeof f?.name === "string");

// A { tool } line: a new step (with all fields), or an update of one (with its id)
export const isToolLine = (value: unknown): value is Partial<ToolStep> & { id: string } =>
  !!value && typeof value === "object" && typeof (value as ToolStep).id === "string";

// A { pause } line: the reply waits for the user's choice about the tool call `tool`
const isPauseLine = (value: unknown): value is { id: string; tool: string } =>
  !!value && typeof (value as { id?: unknown }).id === "string" && typeof (value as { tool?: unknown }).tool === "string";

/** The trace without the pauses that are still open: their reply is over, so there is nothing left to choose. */
const withoutPauses = (trace: TraceItem[]): TraceItem[] =>
  trace.map((item) => (item.kind === "tool" && item.step.pauseId ? { kind: "tool", step: { ...item.step, pauseId: undefined } } : item));

/**
 * The reply after one line of the stream; the same object when the line does
 * not change it. `mayCallTools` says the model can call tools (X-Tools).
 */
export function readReplyLine(reply: StreamedReply, value: unknown, mayCallTools: boolean): StreamedReply {
  const line = value as {
    message?: { content?: unknown; thinking?: unknown };
    tool?: unknown;
    pause?: unknown;
    files?: unknown;
    error?: unknown;
    end?: unknown;
  } | null;
  let next = reply;
  if (line?.end === true) next = { ...next, ended: true };
  // Files the agent made show below its answer, each once
  if (isFileList(line?.files)) next = { ...next, files: withFileCards(next.files, line.files) };
  if (isToolLine(line?.tool)) {
    // Text before a tool call that has not shown as the answer is not the answer: it moves into the trace
    const { answer, text, shown, trace } = next;
    next = {
      ...next,
      answer: shown ? addToAnswer(answer, text) : answer,
      text: "",
      shown: false,
      trace: upsertToolStep(shown ? trace : addReasoning(trace, text, true), line.tool),
    };
  }
  // The reply waits: the tool line of that call offers the choice
  if (isPauseLine(line?.pause)) {
    next = { ...next, trace: upsertToolStep(next.trace, { id: line.pause.tool, pauseId: line.pause.id }) };
  }
  const thought = line?.message?.thinking;
  if (typeof thought === "string" && thought) next = { ...next, trace: addReasoning(next.trace, thought) };
  const delta = line?.message?.content;
  if (typeof delta === "string" && delta) {
    const text = next.text + delta;
    next = { ...next, text, shown: next.shown || (!!text.trim() && (!mayCallTools || looksLikeAnswer(text))) };
  }
  // Ollama and the OpenAI-compatible providers report a failed chat as an { error } line, which ends the reply
  if (typeof line?.error === "string" && line.error) next = { ...next, shown: true, error: line.error };
  return next;
}

/** The reply once its stream is over: text still held back is the answer, as no tool call followed it. */
export const endReply = (reply: StreamedReply): StreamedReply => ({ ...reply, shown: true, trace: withoutPauses(reply.trace) });
