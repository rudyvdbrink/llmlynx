// Model providers a user can connect on the account page. Shared by the
// provider API routes, the account page and the model picker.

export const PROVIDERS = ["ollama", "openai", "openrouter"] as const;

export type ProviderId = (typeof PROVIDERS)[number];

// Providers that are reached with an API key (OpenAI-compatible APIs).
export type KeyProviderId = Exclude<ProviderId, "ollama">;

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  ollama: "Ollama",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

// Model chosen when the user switches to a provider they have not picked a model for yet.
export const DEFAULT_MODELS: Record<ProviderId, string> = {
  ollama: "gpt-oss:20b",
  openai: "gpt-5",
  openrouter: "openrouter/auto",
};

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

export function isKeyProvider(provider: ProviderId): provider is KeyProviderId {
  return provider !== "ollama";
}

/** What the current user has set up, as returned by GET /api/providers. Never contains a key. */
export type ProviderSettings = {
  ollama: { baseUrl: string; custom: boolean };
  openai: { keyHint: string | null };
  openrouter: { keyHint: string | null };
};

/** True when the provider can be used: Ollama always (it has a default server), others need a key. */
export function isProviderReady(settings: ProviderSettings, provider: ProviderId): boolean {
  return provider === "ollama" || settings[provider].keyHint !== null;
}
