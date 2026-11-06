// What the two OpenAI APIs a chat can run on have in common: see
// streamOpenAIChat in openai.ts (and Chat Completions) and openaiResponses.ts.

import type OpenAI from "openai";
import type { ChatMessage } from "@/lib/types";
import type { ToolDefinition } from "@/server/tools/definitions";
import type { ModelTurn, ToolCallResult } from "./toolLoop";
import type { StoredToolCall } from "./conversation";

/** What a chat backend needs from the stream it writes to, and what it sends the model. */
export type ApiChatContext = {
  client: OpenAI;
  model: string;
  messages: ChatMessage[];
  params: Record<string, unknown>;
  tools: ToolDefinition[];
  signal: AbortSignal;
  isCancelled: () => boolean;
  writeContent: (text: string) => void;
  writeThinking: (text: string) => void;
  sendDone: () => void;
};

/** One OpenAI API: how to run a request, and how to add what happened to the next one. */
export type ApiChat<Turn extends ModelTurn> = {
  nextTurn: (mayCallTools: boolean) => Promise<Turn>;
  plainTurn: (note: string) => Promise<Turn>;
  addCalls: (turn: Turn, calls: StoredToolCall[]) => void;
  addResults: (results: ToolCallResult[]) => void;
};

type ApiErrorFields = {
  code?: string;
  param?: string | null;
  status?: number;
  message?: string;
  error?: { code?: string; param?: string | null; message?: string };
};

// Some accounts are not allowed to stream certain models; detect that error so
// the request can be retried without streaming.
export function isStreamingUnsupported(err: unknown): boolean {
  const e = err as ApiErrorFields | null;
  if (!e) return false;
  const code = e.code ?? e.error?.code;
  const param = e.param ?? e.error?.param;
  if (code === "unsupported_value" && param === "stream") return true;
  return e.status === 400 && /must be verified to stream/i.test(String(e.message || e.error?.message || ""));
}

const REFUSAL_CODES = ["unsupported_parameter", "unsupported_value", "unknown_parameter"];

// The request parameter an error refuses, such as "top_p" or "reasoning.summary", or null.
function refusedParam(err: unknown): string | null {
  const e = err as ApiErrorFields | null;
  if (!REFUSAL_CODES.includes(e?.code ?? e?.error?.code ?? "")) return null;
  const param = e?.param ?? e?.error?.param;
  if (param) return param;
  return /'([\w.]+)'/.exec(String(e?.message ?? e?.error?.message ?? ""))?.[1] ?? null;
}

function dropParam(params: Record<string, unknown>, path: string): boolean {
  const keys = path.replace(/\[\d+\]/g, "").split(".");
  const last = keys.pop()!;
  let holder: unknown = params;
  for (const key of keys) holder = (holder as Record<string, unknown> | undefined)?.[key];
  if (!holder || typeof holder !== "object" || !(last in holder)) return false;
  delete (holder as Record<string, unknown>)[last];
  return true;
}

/**
 * Runs `request`, and runs it again without a parameter of `params` that the API
 * refuses. A parameter that is refused stays out of `params` from then on.
 */
export async function withoutRefusedParams<T>(params: Record<string, unknown>, request: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await request();
    } catch (err) {
      const param = refusedParam(err);
      if (!param || !dropParam(params, param)) throw err;
    }
  }
}

/** A model's tool call arguments as an object. Anything else counts as none: the tool then says what is missing. */
export function parseArguments(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
