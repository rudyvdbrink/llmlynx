// Ollama generation options stored per agent. Shared by the agents API
// (validation) and the agents page (defaults).

export type AgentSettings = {
  mirostat: number;
  mirostat_eta: number;
  mirostat_tau: number;
  num_ctx: number;
  repeat_last_n: number;
  repeat_penalty: number;
  temperature: number;
  seed: number;
  num_predict: number;
  top_k: number;
  top_p: number;
  min_p: number;
};

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
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
};

type Rule = { integer: boolean; isValid: (v: number) => boolean; message: string };

const inRange = (min: number, max: number) => (v: number) => v >= min && v <= max;

const RULES: Record<keyof AgentSettings, Rule> = {
  mirostat: { integer: true, isValid: inRange(0, 2), message: "mirostat must be 0, 1, or 2" },
  mirostat_eta: { integer: false, isValid: inRange(0, 1), message: "mirostat_eta must be between 0 and 1" },
  mirostat_tau: { integer: false, isValid: inRange(0, 10), message: "mirostat_tau must be between 0 and 10" },
  num_ctx: { integer: true, isValid: (v) => v > 0, message: "num_ctx must be > 0" },
  repeat_last_n: { integer: true, isValid: (v) => v >= -1, message: "repeat_last_n must be >= -1" },
  repeat_penalty: { integer: false, isValid: inRange(0, 3), message: "repeat_penalty must be in [0,3]" },
  temperature: { integer: false, isValid: inRange(0, 2), message: "temperature must be in [0,2]" },
  seed: { integer: true, isValid: Number.isFinite, message: "seed must be a number" },
  num_predict: { integer: true, isValid: (v) => v === -1 || v >= 0, message: "num_predict must be -1 or >= 0" },
  top_k: { integer: true, isValid: inRange(0, 10000), message: "top_k must be in [0,10000]" },
  top_p: { integer: false, isValid: inRange(0, 1), message: "top_p must be in [0,1]" },
  min_p: { integer: false, isValid: inRange(0, 1), message: "min_p must be in [0,1]" },
};

/**
 * Merges `input` over the defaults and validates every field.
 * Unknown keys are dropped so that only known options reach Ollama.
 */
export function validateAgentSettings(
  input: unknown
): { ok: true; value: AgentSettings } | { ok: false; message: string } {
  const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const value = { ...DEFAULT_AGENT_SETTINGS };

  for (const key of Object.keys(RULES) as (keyof AgentSettings)[]) {
    const rule = RULES[key];
    const raw = key in source ? source[key] : DEFAULT_AGENT_SETTINGS[key];
    let n = typeof raw === "number" && Number.isFinite(raw) ? raw : NaN;
    if (rule.integer) n = Math.trunc(n);
    if (!rule.isValid(n)) return { ok: false, message: rule.message };
    value[key] = n;
  }

  return { ok: true, value };
}
