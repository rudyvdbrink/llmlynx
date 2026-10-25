// Server-side settings read from the environment.

export const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

export function getDefaultSystemPrompt(): string {
  const raw = process.env.SYSTEM_PROMPT || "You are the llynx, a helpful assistant.";
  // Allow multi-line prompts in .env files via escaped newlines.
  return raw.replace(/\\n/g, "\n").trim();
}

export type OpenAIConfig = { apiKey: string; organization?: string; project?: string };

/** Returns the OpenAI settings, or null when no API key is configured. */
export function getOpenAIConfig(): OpenAIConfig | null {
  const apiKey = process.env.API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    organization: process.env.OPENAI_ORG || process.env.OPENAI_ORG_ID || undefined,
    project: process.env.OPENAI_PROJECT || undefined,
  };
}
