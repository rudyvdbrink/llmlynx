// The back and forth between a model and its tools, for every chat backend:
// the model answers or calls tools, the tools run, and it continues with the results.

import type { ToolStep } from "@/lib/types";
import type { ToolDefinition } from "@/server/tools/definitions";
import { runTool, type ToolResult } from "@/server/tools/run";
import type { AssistantReply, StoredToolCall } from "./conversation";

/** What a model wrote and called in one request. A call without an id gets one here. */
export type ModelTurn = {
  content: string;
  calls: { id?: string; name: string; arguments: Record<string, unknown> }[];
};

export type ToolCallResult = { call: StoredToolCall; result: ToolResult };

const limitResult = (max: number): ToolResult => ({
  text: `Error: not run. This reply has already called tools ${max} times, the most it may. Answer now with what you have, without calling tools.`,
  images: [],
  error: true,
});

/**
 * Runs a chat until the model answers. Calls after `maxToolCalls` are not run:
 * the model is told to answer with what it has, and if it calls a tool again,
 * the reply ends. Each call is announced with `sendTool` (state "running"), run,
 * and announced again with its outcome. Every step is saved to `reply`.
 */
export async function runToolLoop<Turn extends ModelTurn>({
  tools,
  maxToolCalls,
  toolContext,
  reply,
  signal,
  isCancelled,
  sendTool,
  sendError,
  nextTurn,
  addCalls,
  addResults,
}: {
  tools: ToolDefinition[];
  maxToolCalls: number;
  toolContext?: { userId: string; textBudget: number };
  reply: AssistantReply;
  signal: AbortSignal;
  isCancelled: () => boolean;
  sendTool: (step: Partial<ToolStep> & { id: string }) => void;
  sendError: (message: string) => void;
  /** One request to the model, streamed to the client. */
  nextTurn: () => Promise<Turn>;
  /** Adds what the model said and called to the conversation it gets next. */
  addCalls: (turn: Turn, calls: StoredToolCall[]) => void;
  /** Adds the results of those calls to it. */
  addResults: (results: ToolCallResult[]) => void;
}): Promise<void> {
  /** Runs one tool call (unless `overLimit`) and stores its result. Returns what the model gets back. */
  async function callTool(call: StoredToolCall, overLimit: boolean): Promise<ToolResult> {
    const def = tools.find((t) => t.name === call.name);
    const icon = def?.icon ?? "spanner";
    sendTool({ id: call.id, name: call.name, icon, label: def?.label(call.arguments, "running") ?? call.name, state: "running" });

    const result: ToolResult = overLimit
      ? limitResult(maxToolCalls)
      : def
        ? await runTool(def, call.arguments, { ...toolContext!, signal })
        : { text: `Error: there is no tool named ${call.name}.`, images: [], error: true };
    const state = result.error ? "error" : "done";
    const label =
      (def?.label(call.arguments, state) ?? `Could not use ${call.name}`) + (overLimit ? " (tool limit reached)" : "");
    const [attachmentId] = await reply.saveToolResult({
      call,
      content: result.text,
      label,
      error: result.error,
      images: result.images,
    });
    sendTool({ id: call.id, label, state, ...(attachmentId ? { attachmentId } : {}) });
    return result;
  }

  let callsLeft = maxToolCalls;
  // Set once a call was refused; the model was told to answer
  let toldToAnswer = false;
  for (let round = 1; ; round++) {
    const turn = await nextTurn();
    if (turn.calls.length === 0 || isCancelled()) return;
    if (toldToAnswer) {
      if (!turn.content.trim()) sendError(`The agent reached its limit of ${maxToolCalls} tool calls without answering.`);
      return;
    }

    const calls: StoredToolCall[] = turn.calls.map((c, i) => ({
      id: c.id || `call_${round}_${i}`,
      name: c.name,
      arguments: c.arguments,
    }));
    await reply.saveToolCalls(calls);
    addCalls(turn, calls);
    const results: ToolCallResult[] = [];
    // One call at a time: the server may be small
    for (const call of calls) {
      const overLimit = callsLeft <= 0;
      if (overLimit) toldToAnswer = true;
      else callsLeft--;
      results.push({ call, result: await callTool(call, overLimit) });
    }
    addResults(results);
  }
}
