// What the two OpenAI APIs a chat can run on have in common: see
// streamOpenAIChat in openai.ts (and Chat Completions) and openaiResponses.ts.

import type OpenAI from "openai";
import type { KeyProviderId } from "@/lib/providers";
import type { ToolDefinition } from "@/server/tools/definitions";
import type { Usage } from "./budget";
import type { ModelTurn } from "./toolLoop";
import type { CostMeter } from "./cost";
import type { ViewMessage } from "./view";

/** What a chat backend needs from the stream it writes to, and what it sends the model. */
export type ApiChatContext = {
  client: OpenAI;
  provider: KeyProviderId;
  model: string;
  params: Record<string, unknown>;
  tools: ToolDefinition[];
  signal: AbortSignal;
  isCancelled: () => boolean;
  writeContent: (text: string) => void;
  writeThinking: (text: string) => void;
  sendDone: () => void;
  /** What the requests cost: each is started and ended on it, and the text the model streams is added */
  cost: CostMeter;
};

/** One OpenAI API: how to run a request with the conversation as the model gets it (the view, see view.ts). */
export type ApiChat<Turn extends ModelTurn> = {
  /** One request with the tools offered, streamed to the client. */
  turn: (view: ViewMessage[], mayCallTools: boolean) => Promise<Turn>;
  /** One request without tools, for a view without tool calls, streamed to the client. */
  plainTurn: (view: ViewMessage[]) => Promise<Turn>;
  /** One request without tools whose answer the client does not get: the text the model wrote. */
  ask: (view: ViewMessage[]) => Promise<string>;
};

/** What a request took, from the `usage` of its response: Chat Completions names the counts one way, the Responses API another. */
export function usageOf(usage: unknown): Usage | undefined {
  const u = usage as { prompt_tokens?: unknown; completion_tokens?: unknown; input_tokens?: unknown; output_tokens?: unknown } | null;
  const input = u?.prompt_tokens ?? u?.input_tokens;
  const output = u?.completion_tokens ?? u?.output_tokens;
  return typeof input === "number" && input > 0 ? { input, output: typeof output === "number" ? output : 0 } : undefined;
}

/**
 * True when the API refused the request itself (status 400), rather than a
 * parameter of it or streaming: with tool calls of earlier replies in it,
 * that can be about them (see streamOpenAIChat).
 */
export function isRefusedRequest(err: unknown): boolean {
  const e = err as ApiErrorFields | null;
  return e?.status === 400 && !isStreamingUnsupported(err) && !refusedParam(err);
}

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
