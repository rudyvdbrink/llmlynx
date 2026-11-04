import OpenAI from "openai";
import type { ApiConfig } from "@/server/providers";
import type { KeyProviderId } from "@/lib/providers";

// Fail fast when a provider is unreachable, so the model picker can show an error.
const TIMEOUT_MS = 8000;

// Shape of one entry in Ollama's GET /api/tags response.
type OllamaTag = { name?: string; model?: string };

/** Names of the models installed on the Ollama server at `baseUrl`. Throws if it cannot be reached. */
export async function listOllamaModels(baseUrl: string): Promise<string[]> {
  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl}/api/tags`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error(`Cannot reach Ollama at ${baseUrl}`);
  }
  if (!upstream.ok) throw new Error(`Ollama at ${baseUrl} answered with status ${upstream.status}`);

  const raw: unknown = await upstream.json().catch(() => ({}));
  const list: OllamaTag[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { models?: unknown })?.models)
      ? (raw as { models: OllamaTag[] }).models
      : [];
  return sortNames(list.map((m) => m?.name || m?.model || ""));
}

/** What Ollama's POST /api/show says about a model. */
export type OllamaModelInfo = {
  /** What the model can do, such as "tools" and "vision"; null when Ollama does not say. */
  capabilities: string[] | null;
  /** The longest context the model was trained for, in tokens; null when Ollama does not say. */
  contextLength: number | null;
};

// Kept for a while, since every chat with an agent asks
const INFO_CACHE_MS = 10 * 60 * 1000;
const INFO_TIMEOUT_MS = 5000;

const infoCache = new Map<string, { at: number; info: OllamaModelInfo }>();

/** What the Ollama server at `baseUrl` says about `model`, or null when it cannot be reached or does not have it. */
export async function getOllamaModelInfo(baseUrl: string, model: string): Promise<OllamaModelInfo | null> {
  const key = `${baseUrl}\n${model}`;
  const hit = infoCache.get(key);
  if (hit && Date.now() - hit.at < INFO_CACHE_MS) return hit.info;

  try {
    const res = await fetch(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
      cache: "no-store",
      signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const raw = (await res.json().catch(() => ({}))) as { capabilities?: unknown; model_info?: unknown };
    const info: OllamaModelInfo = {
      capabilities: Array.isArray(raw.capabilities)
        ? raw.capabilities.filter((c): c is string => typeof c === "string")
        : null,
      contextLength: contextLengthOf(raw.model_info),
    };
    infoCache.set(key, { at: Date.now(), info });
    return info;
  } catch {
    return null;
  }
}

// model_info names the field after the model's architecture, such as "qwen35.context_length"
function contextLengthOf(modelInfo: unknown): number | null {
  if (!modelInfo || typeof modelInfo !== "object") return null;
  const fields = modelInfo as Record<string, unknown>;
  const n = fields[`${fields["general.architecture"]}.context_length`];
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

// OpenAI also lists models for embeddings, images, audio, and models that only
// work with the Responses API. Keep the ones that can chat.
const OPENAI_CHAT_MODEL = /^(gpt-|chatgpt-|o\d)/;
const OPENAI_NOT_CHAT = /embedding|image|audio|realtime|transcribe|tts|search|moderation|codex|deep-research|-pro\b|instruct|live/;

// OpenAI keeps listing a model after its shutdown date ("YYYY-MM-DD"), but chats with it then fail.
// Some retired models have no shutdown date: all of gpt-3.5 is retired.
type ListedModel = { id: string; shutdown_date?: string | null };
const OPENAI_RETIRED = /^gpt-3\.5/;
const isShutDown = (m: ListedModel, today: string) =>
  (!!m.shutdown_date && m.shutdown_date <= today) || OPENAI_RETIRED.test(m.id);

/** Ids of the chat models available with an OpenAI or OpenRouter API key. */
export async function listApiModels(provider: KeyProviderId, config: ApiConfig): Promise<string[]> {
  const client = new OpenAI({ ...config, timeout: TIMEOUT_MS, maxRetries: 0 });
  // OpenRouter lists models without checking the key, so ask about the key first:
  // a wrong key then shows up here rather than in the middle of a chat.
  if (provider === "openrouter") await client.get("/key");
  const today = new Date().toISOString().slice(0, 10);
  const models: ListedModel[] = (await client.models.list()).data;
  const ids = models.filter((m) => !isShutDown(m, today)).map((m) => m.id);
  return sortNames(
    provider === "openai" ? ids.filter((id) => OPENAI_CHAT_MODEL.test(id) && !OPENAI_NOT_CHAT.test(id)) : ids
  );
}

function sortNames(names: string[]): string[] {
  return [...new Set(names.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
