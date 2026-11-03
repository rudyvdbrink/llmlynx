// Server-side settings read from the environment.

// Ollama server for users who have not set their own on the account page.
export const DEFAULT_OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1";

export function getDefaultSystemPrompt(): string {
  const raw = process.env.SYSTEM_PROMPT || "You are the llynx, a helpful assistant.";
  // Allow multi-line prompts in .env files via escaped newlines.
  return raw.replace(/\\n/g, "\n").trim();
}
