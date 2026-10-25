// A selection identifies what the user chats with, as a prefixed string:
//   "model:<ollama model>" | "agent:<agent id>" | "remote:<remote model>"
// Conversations store the selection in their `model` column. Older rows hold a
// plain model name, which is read as "model:<name>".

export type SelectionKind = "model" | "agent" | "remote";

export const DEFAULT_SELECTION = "model:gpt-oss:20b";

// Shown when the Ollama model list cannot be loaded.
export const FALLBACK_MODELS = ["gpt-oss:20b", "gemma3:1b", "gemma3:12b", "mistral"];

const KINDS: SelectionKind[] = ["model", "agent", "remote"];

export function toSelection(kind: SelectionKind, value: string): string {
  return `${kind}:${value}`;
}

export function normalizeSelection(sel: string | null | undefined, fallback = DEFAULT_SELECTION): string {
  if (!sel) return fallback;
  if (KINDS.some((kind) => sel.startsWith(`${kind}:`))) return sel;
  return toSelection("model", sel);
}

export function parseSelection(sel: string | null | undefined): { kind: SelectionKind; value: string } {
  const normalized = normalizeSelection(sel);
  const sep = normalized.indexOf(":");
  return {
    kind: normalized.slice(0, sep) as SelectionKind,
    value: normalized.slice(sep + 1),
  };
}
