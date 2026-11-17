// Building a reply's trace (what the model did before its answer, in order).
// Used by the chat view while a reply streams in, and by the server when a
// conversation is opened again. Updates return a new array, for React state.

import type { ToolStep, TraceItem } from "./types";

/**
 * Adds reasoning to the end of the trace: to the reasoning it ends with, or
 * as a new item after a tool step. With `paragraph`, the text starts a new
 * paragraph instead of continuing the last one (for text of another step).
 */
export function addReasoning(trace: TraceItem[], text: string, paragraph = false): TraceItem[] {
  if (!text) return trace;
  const last = trace[trace.length - 1];
  if (last?.kind !== "reasoning") return [...trace, { kind: "reasoning", text }];
  const joined = paragraph && last.text.trim() ? `${last.text.trimEnd()}\n\n${text}` : last.text + text;
  return [...trace.slice(0, -1), { kind: "reasoning", text: joined }];
}

/**
 * Whether text a model wrote before calling a tool is meant for the user, and
 * so is part of the answer, not the trace. Models such as qwen3.5 first say
 * what they are about to do, in one paragraph that can run to hundreds of
 * characters ("Let me read the rest to confirm…"). Text that goes on past a
 * line break is taken for the answer. Text that starts with such text is too,
 * so text that shows as the answer while it streams in stays there when a
 * tool call follows it.
 */
export const looksLikeAnswer = (text: string) => /\S\s*\n\s*\S/.test(text);

/** Adds the text of another step to an answer, as a new paragraph. */
export const addToAnswer = (answer: string, text: string) => (answer && text ? `${answer}\n\n${text}` : answer || text);

/** Adds a tool step to the trace, or updates the one with the same id. */
export function upsertToolStep(trace: TraceItem[], step: Partial<ToolStep> & { id: string }): TraceItem[] {
  const index = trace.findIndex((item) => item.kind === "tool" && item.step.id === step.id);
  if (index < 0) return [...trace, { kind: "tool", step: step as ToolStep }];
  return trace.map((item, i) => (i === index && item.kind === "tool" ? { kind: "tool", step: { ...item.step, ...step } } : item));
}
