// Generation options stored per agent, in Agent.settings. Shared by the agents
// API (validation), the chat (what to send) and the agents page (defaults).
//
// Ollama takes the same options for every model. They are stored in full, so an
// agent's values stay the same if llmlynx's defaults change.
// OpenAI and OpenRouter models each take their own options. Only what the user
// set is stored and sent; anything else stays at the model's own default.

import type { ProviderId } from "./providers";

export type OptionValue = number | string;

export type AgentSettings = Record<string, OptionValue>;

export type OptionFamily = "ollama" | "api";

export const optionFamily = (provider: ProviderId): OptionFamily => (provider === "ollama" ? "ollama" : "api");

export const DEFAULT_SETTINGS: Record<OptionFamily, AgentSettings> = {
  ollama: {
    mirostat: 0,
    mirostat_eta: 0.1,
    mirostat_tau: 5.0,
    num_ctx: 2048,
    repeat_last_n: 64,
    repeat_penalty: 1.1,
    temperature: 0.8,
    seed: 0,
    num_predict: -1,
    top_k: 40,
    top_p: 0.9,
    min_p: 0.0,
  },
  api: {},
};

type Rule =
  | { type: "number"; integer: boolean; isValid: (v: number) => boolean; message: string }
  | { type: "text"; isValid: (v: string) => boolean; message: string };

const number = (isValid: (v: number) => boolean, message: string): Rule => ({
  type: "number",
  integer: false,
  isValid,
  message,
});
const integer = (isValid: (v: number) => boolean, message: string): Rule => ({
  type: "number",
  integer: true,
  isValid,
  message,
});
const text = (isValid: (v: string) => boolean, message: string): Rule => ({ type: "text", isValid, message });

const inRange = (min: number, max: number) => (v: number) => v >= min && v <= max;

export const MAX_STOP_SEQUENCES = 4;
const MAX_STOP_LENGTH = 100;

// What the reasoning option can be set to: the effort levels models report,
// and on/off for models that have no levels.
export const REASONING_CHOICES = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "off", "on"];

const RULES: Record<OptionFamily, Record<string, Rule>> = {
  ollama: {
    mirostat: integer(inRange(0, 2), "mirostat must be 0, 1, or 2"),
    mirostat_eta: number(inRange(0, 1), "mirostat_eta must be between 0 and 1"),
    mirostat_tau: number(inRange(0, 10), "mirostat_tau must be between 0 and 10"),
    num_ctx: integer((v) => v > 0, "num_ctx must be > 0"),
    repeat_last_n: integer((v) => v >= -1, "repeat_last_n must be >= -1"),
    repeat_penalty: number(inRange(0, 3), "repeat_penalty must be in [0,3]"),
    temperature: number(inRange(0, 2), "temperature must be in [0,2]"),
    seed: integer(Number.isFinite, "seed must be a number"),
    num_predict: integer((v) => v === -1 || v >= 0, "num_predict must be -1 or >= 0"),
    top_k: integer(inRange(0, 10000), "top_k must be in [0,10000]"),
    top_p: number(inRange(0, 1), "top_p must be in [0,1]"),
    min_p: number(inRange(0, 1), "min_p must be in [0,1]"),
  },
  api: {
    temperature: number(inRange(0, 2), "temperature must be in [0,2]"),
    top_p: number(inRange(0, 1), "top_p must be in [0,1]"),
    top_k: integer(inRange(0, 10000), "top_k must be in [0,10000]"),
    min_p: number(inRange(0, 1), "min_p must be in [0,1]"),
    top_a: number(inRange(0, 1), "top_a must be in [0,1]"),
    frequency_penalty: number(inRange(-2, 2), "frequency_penalty must be in [-2,2]"),
    presence_penalty: number(inRange(-2, 2), "presence_penalty must be in [-2,2]"),
    repetition_penalty: number(inRange(0, 2), "repetition_penalty must be in [0,2]"),
    seed: integer(Number.isFinite, "seed must be a number"),
    max_tokens: integer((v) => v >= 1, "max_tokens must be 1 or more"),
    stop: text((v) => {
      const lines = stopSequences(v);
      return lines.length <= MAX_STOP_SEQUENCES && lines.every((line) => line.length <= MAX_STOP_LENGTH);
    }, `stop can have at most ${MAX_STOP_SEQUENCES} sequences of at most ${MAX_STOP_LENGTH} characters`),
    reasoning: text((v) => REASONING_CHOICES.includes(v), "reasoning is not a known level"),
    verbosity: text((v) => ["low", "medium", "high"].includes(v), "verbosity must be low, medium or high"),
  },
};

/** The option keys of a family, as the model info returns them. */
export const OPTION_KEYS: Record<OptionFamily, string[]> = {
  ollama: Object.keys(RULES.ollama),
  api: Object.keys(RULES.api),
};

/** The stop option holds one sequence per line. */
export function stopSequences(value: string): string[] {
  return value.split("\n").filter((line) => line.trim() !== "");
}

function validValue(rule: Rule, raw: unknown): OptionValue | null {
  if (rule.type === "text") return typeof raw === "string" && rule.isValid(raw) ? raw : null;
  let n = typeof raw === "number" && Number.isFinite(raw) ? raw : NaN;
  if (rule.integer) n = Math.trunc(n);
  return rule.isValid(n) ? n : null;
}

/**
 * The settings to store for an agent on `provider`. Unknown keys are dropped, so
 * that only known options reach the model. For Ollama, `input` is merged over
 * the defaults; for OpenAI and OpenRouter, an empty value means not set.
 */
export function validateAgentSettings(
  provider: ProviderId,
  input: unknown
): { ok: true; value: AgentSettings } | { ok: false; message: string } {
  const family = optionFamily(provider);
  const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const value: AgentSettings = { ...DEFAULT_SETTINGS[family] };

  for (const [key, rule] of Object.entries(RULES[family])) {
    const raw = key in source ? source[key] : DEFAULT_SETTINGS[family][key];
    if (family === "api" && (raw === undefined || raw === null || raw === "")) continue;
    const valid = validValue(rule, raw);
    if (valid === null) return { ok: false, message: rule.message };
    value[key] = valid;
  }

  return { ok: true, value };
}
