// Field rules shared by the agent create and update routes.

import { parseBaseModel, toSelection } from "@/lib/selection";
import type { ProviderId } from "@/lib/providers";

export const AGENT_SELECT = {
  id: true,
  name: true,
  baseModel: true,
  systemPrompt: true,
  settings: true,
  tools: true,
  maxToolCalls: true,
  createdAt: true,
  updatedAt: true,
} as const;

const MAX_NAME_LENGTH = 80;

/** Returns an error message for an invalid (already trimmed) agent name, or null. */
export function agentNameError(name: string): string | null {
  if (name.length > MAX_NAME_LENGTH) return `Name too long (max ${MAX_NAME_LENGTH})`;
  return null;
}

export const DUPLICATE_NAME_MESSAGE = "You already have an agent with this name";

/** The base model to store: a selection of a provider's model. Null when `input` is not one. */
export function storedBaseModel(input: string): { value: string; provider: ProviderId } | null {
  const base = parseBaseModel(input);
  return base ? { value: toSelection(base.provider, base.model), provider: base.provider } : null;
}
