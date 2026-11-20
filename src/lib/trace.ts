// Building a reply's trace (everything the model did, in order, its text
// included). Used by the chat view while a reply streams in, and by the server
// when a conversation is opened again. Updates return a new array, for React state.

import type { ToolStep, TraceItem } from "./types";

/**
 * Adds reasoning or text to the end of the trace: to the item of that kind it
 * ends with, or as a new item. A new item does not start with white space, so
 * white space alone starts none. With `paragraph`, the words start a new
 * paragraph instead of continuing the last one (for those of another step).
 */
function addWords(trace: TraceItem[], kind: "reasoning" | "text", words: string, paragraph: boolean): TraceItem[] {
  const last = trace[trace.length - 1];
  if (last?.kind !== kind) {
    const text = words.trimStart();
    return text ? [...trace, { kind, text }] : trace;
  }
  if (!words) return trace;
  const joined = paragraph && last.text.trim() ? `${last.text.trimEnd()}\n\n${words}` : last.text + words;
  return [...trace.slice(0, -1), { kind, text: joined }];
}

/** Adds reasoning to the end of the trace (see addWords). */
export const addReasoning = (trace: TraceItem[], text: string, paragraph = false) => addWords(trace, "reasoning", text, paragraph);

/** Adds text the model wrote to the user to the end of the trace (see addWords). */
export const addText = (trace: TraceItem[], text: string, paragraph = false) => addWords(trace, "text", text, paragraph);

/** The text of a reply in one piece, each part a paragraph. */
export const traceText = (trace: TraceItem[]) =>
  trace.flatMap((item) => (item.kind === "text" && item.text.trim() ? [item.text.trim()] : [])).join("\n\n");

/** Adds a tool step to the trace, or updates the one with the same id. */
export function upsertToolStep(trace: TraceItem[], step: Partial<ToolStep> & { id: string }): TraceItem[] {
  const index = trace.findIndex((item) => item.kind === "tool" && item.step.id === step.id);
  if (index < 0) return [...trace, { kind: "tool", step: step as ToolStep }];
  return trace.map((item, i) => (i === index && item.kind === "tool" ? { kind: "tool", step: { ...item.step, ...step } } : item));
}
