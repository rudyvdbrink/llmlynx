// Field rules shared by the agent create and update routes.

export const AGENT_SELECT = {
  id: true,
  name: true,
  baseModel: true,
  systemPrompt: true,
  settings: true,
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
