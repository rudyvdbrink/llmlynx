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

/** Adds a tool step to the trace, or updates the one with the same id. */
export function upsertToolStep(trace: TraceItem[], step: Partial<ToolStep> & { id: string }): TraceItem[] {
  const index = trace.findIndex((item) => item.kind === "tool" && item.step.id === step.id);
  if (index < 0) return [...trace, { kind: "tool", step: step as ToolStep }];
  return trace.map((item, i) => (i === index && item.kind === "tool" ? { kind: "tool", step: { ...item.step, ...step } } : item));
}
