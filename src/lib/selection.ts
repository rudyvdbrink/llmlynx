// A selection identifies what the user chats with, as a prefixed string:
//   "ollama:<model>" | "openai:<model>" | "openrouter:<model>" | "agent:<agent id>"
// Conversations store the selection in their `model` column. Older rows hold
// "model:<name>" (Ollama), "remote:<name>" (OpenAI) or a plain Ollama model
// name; these are read as the matching new selection.

import { DEFAULT_MODELS, PROVIDER_LABELS, PROVIDERS, type ProviderId } from "./providers";

export type SelectionKind = ProviderId | "agent";

export const DEFAULT_SELECTION = `ollama:${DEFAULT_MODELS.ollama}`;

// Shown when the Ollama model list cannot be loaded.
export const FALLBACK_MODELS = ["gpt-oss:20b", "gemma3:1b", "gemma3:12b", "mistral"];

const KINDS: SelectionKind[] = [...PROVIDERS, "agent"];

const LEGACY_KINDS: Record<string, SelectionKind> = { model: "ollama", remote: "openai" };

export function toSelection(kind: SelectionKind, value: string): string {
  return `${kind}:${value}`;
}

export function normalizeSelection(sel: string | null | undefined, fallback = DEFAULT_SELECTION): string {
  if (!sel) return fallback;
  if (KINDS.some((kind) => sel.startsWith(`${kind}:`))) return sel;
  for (const [legacy, kind] of Object.entries(LEGACY_KINDS)) {
    if (sel.startsWith(`${legacy}:`)) return toSelection(kind, sel.slice(legacy.length + 1));
  }
  return toSelection("ollama", sel);
}

export function parseSelection(sel: string | null | undefined): { kind: SelectionKind; value: string } {
  const normalized = normalizeSelection(sel);
  const sep = normalized.indexOf(":");
  return {
    kind: normalized.slice(0, sep) as SelectionKind,
    value: normalized.slice(sep + 1),
  };
}

/** The provider and model of an agent's base model. Stored as a selection; older agents hold a plain Ollama name. */
export function parseBaseModel(baseModel: string | null | undefined): { provider: ProviderId; model: string } | null {
  const { kind, value } = parseSelection(baseModel);
  return kind === "agent" || !value ? null : { provider: kind, model: value };
}

/** An agent's base model as the UI shows it: the name, with the provider unless it is Ollama. */
export function baseModelLabel(baseModel: string | null | undefined): string {
  const base = parseBaseModel(baseModel);
  if (!base) return "";
  return base.provider === "ollama" ? base.model : `${PROVIDER_LABELS[base.provider]}: ${base.model}`;
}
