// What the chats with OpenAI and OpenRouter models cost: each request's cost,
// from the usage its response reports, adds to its conversation's cost. While
// a reply streams, the client is told an estimate (see createCostMeter).

import { prisma } from "@/server/db/prisma";
import type { KeyProviderId } from "@/lib/providers";
import type { TokenPrices } from "./models";

// Chat Completions and OpenRouter name the token counts one way, the Responses API another.
type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number } | null;
  // OpenRouter: what it charged, in US dollars. With the user's own key for the
  // provider behind it (BYOK), that provider charges the rest.
  cost?: number;
  is_byok?: boolean;
  cost_details?: { upstream_inference_cost?: number | null } | null;
};

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** What tokens cost at `prices`, in US dollars. Long prompts can cost more: the override for the most prompt tokens they reach applies. */
function tokenCost(prices: TokenPrices, input: number, cached: number, output: number): number {
  const override = (prices.overrides ?? [])
    .filter((o) => count(o.min_prompt_tokens) <= input)
    .sort((a, b) => count(b.min_prompt_tokens) - count(a.min_prompt_tokens))[0];
  const p = { ...prices, ...override };
  const perToken = (text: string | undefined) => count(Number(text));
  return (
    (input - cached) * perToken(p.prompt) +
    cached * perToken(p.input_cache_read ?? p.prompt) +
    output * perToken(p.completion)
  );
}

/**
 * What a request cost in US dollars, from the `usage` of its response, or null
 * when that is not known. OpenRouter says what it charged; OpenAI only gives the
 * tokens, which `prices` (see getModelPrices) turn into dollars.
 */
export function requestCost(provider: KeyProviderId, usage: unknown, prices: TokenPrices | null): number | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Usage;
  if (provider === "openrouter") {
    if (typeof u.cost !== "number") return null;
    return count(u.cost) + (u.is_byok ? count(u.cost_details?.upstream_inference_cost) : 0);
  }
  if (!prices) return null;
  const input = count(u.prompt_tokens ?? u.input_tokens);
  const cached = Math.min(input, count((u.prompt_tokens_details ?? u.input_tokens_details)?.cached_tokens));
  return tokenCost(prices, input, cached, count(u.completion_tokens ?? u.output_tokens));
}

/** What the conversation cost so far, in US dollars, or null when none of its replies came from OpenAI or OpenRouter. */
export async function conversationCost(conversationId: string): Promise<number | null> {
  const row = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { cost: true } });
  return row?.cost ?? null;
}

/** Adds `usd` to what the conversation cost. Its first cost replaces null. */
export async function addConversationCost(conversationId: string, usd: number): Promise<void> {
  try {
    await prisma.$executeRaw`UPDATE "Conversation" SET "cost" = COALESCE("cost", 0) + ${usd} WHERE "id" = ${conversationId}`;
  } catch (err) {
    console.error(`Storing what a reply cost failed: ${(err as Error)?.message || err}`);
  }
}

// About this many characters of text make a token
const CHARS_PER_TOKEN = 4;
// While a reply streams, the client is told what it cost at most this often
const SEND_INTERVAL_MS = 250;
// Not text the model reads: reasoning it gets back encrypted or signed
const SKIPPED_KEYS = new Set(["encrypted_content", "signature", "data"]);

/** The characters of text in a request, images left out. */
function textLength(value: unknown): number {
  if (typeof value === "string") return value.startsWith("data:") ? 0 : value.length;
  if (Array.isArray(value)) return value.reduce((n: number, item) => n + textLength(item), 0);
  if (!value || typeof value !== "object") return 0;
  return Object.entries(value).reduce((n, [key, item]) => n + (SKIPPED_KEYS.has(key) ? 0 : textLength(item)), 0);
}

/** What the requests of a reply cost as they stream, see createCostMeter. */
export type CostMeter = {
  /** A request is sent: until its usage is known, its text counts as an estimate of its input. */
  startRequest(body: unknown): void;
  /** Text the model streamed: reasoning, its answer or the arguments of a tool call. */
  addOutput(text: string): void;
  /** The request ended: what it cost replaces the estimate, and adds to the conversation's cost. */
  endRequest(usage: unknown): Promise<void>;
};

/**
 * Tells the client (`send`) what the conversation cost so far while a reply
 * streams: what it cost before (`stored`), what the reply's finished requests
 * cost, and an estimate of the request under way, from the text it sends and
 * streams. Reasoning that does not stream (OpenAI's) only counts once its
 * request ends. Without prices nothing is estimated.
 */
export function createCostMeter({
  provider,
  prices,
  stored,
  save,
  send,
}: {
  provider: KeyProviderId;
  prices: TokenPrices | null;
  stored: number | null;
  save: (usd: number) => Promise<void>;
  send: (usd: number) => void;
}): CostMeter {
  // OpenRouter's router (openrouter/auto) has no prices of its own: they are negative
  const estimating = prices && Number(prices.prompt) >= 0 && Number(prices.completion) >= 0 ? prices : null;
  let total = stored ?? 0;
  let known = stored !== null;
  let inputChars = 0;
  let outputChars = 0;
  let sent: number | null = null;
  let sentAt = 0;

  function update(now: boolean) {
    if (!estimating && !known) return;
    if (!now && Date.now() - sentAt < SEND_INTERVAL_MS) return;
    const estimate = estimating
      ? tokenCost(estimating, inputChars / CHARS_PER_TOKEN, 0, outputChars / CHARS_PER_TOKEN)
      : 0;
    if (total + estimate === sent) return;
    sent = total + estimate;
    sentAt = Date.now();
    send(sent);
  }

  return {
    startRequest(body) {
      inputChars = textLength(body);
      outputChars = 0;
      update(true);
    },
    addOutput(text) {
      outputChars += text.length;
      update(false);
    },
    async endRequest(usage) {
      inputChars = 0;
      outputChars = 0;
      const usd = requestCost(provider, usage, prices);
      if (usd !== null) {
        total += usd;
        known = true;
        await save(usd);
      }
      update(true);
    },
  };
}
