// Per-user model provider settings (see the ProviderSetting model): the Ollama
// server address and the encrypted OpenAI and OpenRouter API keys.

import { prisma } from "@/server/db/prisma";
import { DEFAULT_OLLAMA_URL, OPENROUTER_URL } from "@/server/config";
import { decryptSecret, encryptSecret } from "@/server/secrets";
import type { KeyProviderId, ProviderId, ProviderSettings } from "@/lib/providers";

export type ApiConfig = { apiKey: string; baseURL?: string };

// undefined keeps the OpenAI SDK default (api.openai.com, or OPENAI_BASE_URL when set).
const API_BASE_URLS: Record<KeyProviderId, string | undefined> = {
  openai: undefined,
  openrouter: OPENROUTER_URL,
};

const MAX_KEY_LENGTH = 512;
const MAX_URL_LENGTH = 2048;
const OLLAMA_PORT = "11434";

// A stored key only decrypts for the user and provider it was saved for.
const keyContext = (userId: string, provider: KeyProviderId) => `${userId}:${provider}`;

function findSetting(userId: string, provider: ProviderId) {
  return prisma.providerSetting.findUnique({ where: { userId_provider: { userId, provider } } });
}

function readApiKey(userId: string, provider: KeyProviderId, encrypted: string | null | undefined): string | null {
  if (!encrypted) return null;
  try {
    return decryptSecret(encrypted, keyContext(userId, provider));
  } catch (err) {
    // A changed SECRETS_KEY makes stored keys unreadable; the user has to save them again.
    console.error(`Cannot decrypt the ${provider} API key of user ${userId}: ${(err as Error).message}`);
    return null;
  }
}

/** The Ollama server for this user: their own address, or the server default. */
export async function getOllamaUrl(userId: string): Promise<string> {
  return (await findSetting(userId, "ollama"))?.baseUrl || DEFAULT_OLLAMA_URL;
}

/** Connection settings for an API key provider, or null when the user has no readable key. */
export async function getApiConfig(userId: string, provider: KeyProviderId): Promise<ApiConfig | null> {
  const apiKey = readApiKey(userId, provider, (await findSetting(userId, provider))?.apiKeyEncrypted);
  return apiKey ? { apiKey, baseURL: API_BASE_URLS[provider] } : null;
}

// Only the end of a key is shown, so the user can tell which key is saved.
function keyHint(apiKey: string | null): string | null {
  return apiKey ? `…${apiKey.slice(-4)}` : null;
}

export async function getProviderSettings(userId: string): Promise<ProviderSettings> {
  const rows = await prisma.providerSetting.findMany({ where: { userId } });
  const row = (provider: ProviderId) => rows.find((r) => r.provider === provider);
  const hint = (provider: KeyProviderId) => keyHint(readApiKey(userId, provider, row(provider)?.apiKeyEncrypted));
  const ollamaUrl = row("ollama")?.baseUrl;
  return {
    ollama: { baseUrl: ollamaUrl || DEFAULT_OLLAMA_URL, custom: !!ollamaUrl },
    openai: { keyHint: hint("openai") },
    openrouter: { keyHint: hint("openrouter") },
  };
}

/** Returns an error message for an unusable (already trimmed) API key, or null. */
export function apiKeyError(apiKey: string): string | null {
  if (!apiKey) return "API key is required";
  if (apiKey.length > MAX_KEY_LENGTH) return `API key too long (max ${MAX_KEY_LENGTH})`;
  if (/\s/.test(apiKey)) return "API key cannot contain spaces";
  return null;
}

export async function saveApiKey(userId: string, provider: KeyProviderId, apiKey: string) {
  const apiKeyEncrypted = encryptSecret(apiKey, keyContext(userId, provider));
  await prisma.providerSetting.upsert({
    where: { userId_provider: { userId, provider } },
    create: { userId, provider, apiKeyEncrypted },
    update: { apiKeyEncrypted },
  });
}

/**
 * Turns user input such as "192.168.1.20", "ollama.lan:8080" or
 * "https://example.com/ollama/" into a base URL, or returns null if it is not
 * one. Without a scheme, http is assumed; without a port as well, Ollama's own.
 */
export function normalizeOllamaUrl(input: string): string | null {
  const text = input.trim();
  if (!text || text.length > MAX_URL_LENGTH) return null;
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(text);
  let url: URL;
  try {
    url = new URL(hasScheme ? text : `http://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // fetch() rejects URLs with credentials, and a query or fragment cannot take a path suffix.
  if (url.username || url.password || url.search || url.hash) return null;
  if (!hasScheme && !/^[^/]*:\d+(\/|$)/.test(text)) url.port = OLLAMA_PORT;
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export async function saveOllamaUrl(userId: string, baseUrl: string) {
  await prisma.providerSetting.upsert({
    where: { userId_provider: { userId, provider: "ollama" } },
    create: { userId, provider: "ollama", baseUrl },
    update: { baseUrl },
  });
}

/** Removes the user's key or Ollama address. Ollama then uses the default server again. */
export async function removeProviderSetting(userId: string, provider: ProviderId) {
  await prisma.providerSetting.deleteMany({ where: { userId, provider } });
}
