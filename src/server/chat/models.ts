import OpenAI from "openai";
import { OPENROUTER_URL } from "@/server/config";
import { getApiConfig, getOllamaUrl, type ApiConfig } from "@/server/providers";
import { OPTION_KEYS, type AgentSettings } from "@/lib/agentSettings";
import type { KeyProviderId, ProviderId } from "@/lib/providers";

// Fail fast when a provider is unreachable, so the model picker can show an error.
const TIMEOUT_MS = 8000;

// Shape of one entry in Ollama's GET /api/tags response.
type OllamaTag = { name?: string; model?: string };

/** The models a provider offers, and the announced last day (YYYY-MM-DD) of those that have one. */
export type ModelListing = { models: string[]; expiries: Record<string, string> };

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

// Providers keep listing a model after its last day ("YYYY-MM-DD"), but chats with it then fail:
// OpenAI calls that day shutdown_date, OpenRouter expiration_date.
// Some retired models have no shutdown date: all of gpt-3.5 is retired.
type ListedModel = { id: string; shutdown_date?: string | null; expiration_date?: string | null };
const OPENAI_RETIRED = /^gpt-3\.5/;
const lastDayOf = (m: ListedModel) => m.shutdown_date || m.expiration_date || null;
const isShutDown = (m: ListedModel, today: string) => {
  const lastDay = lastDayOf(m);
  return (!!lastDay && lastDay <= today) || OPENAI_RETIRED.test(m.id);
};

/** The chat models available with an OpenAI or OpenRouter API key. */
export async function listApiModels(provider: KeyProviderId, config: ApiConfig): Promise<ModelListing> {
  const client = new OpenAI({ ...config, timeout: TIMEOUT_MS, maxRetries: 0 });
  // OpenRouter lists models without checking the key, so ask about the key first:
  // a wrong key then shows up here rather than in the middle of a chat.
  if (provider === "openrouter") await client.get("/key");
  const today = new Date().toISOString().slice(0, 10);
  const listed: ListedModel[] = (await client.models.list()).data;
  const usable = listed.filter(
    (m) => !isShutDown(m, today) && (provider !== "openai" || (OPENAI_CHAT_MODEL.test(m.id) && !OPENAI_NOT_CHAT.test(m.id)))
  );
  const expiries: Record<string, string> = {};
  for (const m of usable) {
    const lastDay = lastDayOf(m);
    if (lastDay) expiries[m.id] = lastDay;
  }
  return { models: sortNames(usable.map((m) => m.id)), expiries };
}

/**
 * The models `provider` offers the user, or null when it needs an API key they
 * have not saved. Throws when the provider cannot be reached or refuses the key.
 */
export async function listProviderModels(userId: string, provider: ProviderId): Promise<ModelListing | null> {
  if (provider === "ollama") return { models: await listOllamaModels(await getOllamaUrl(userId)), expiries: {} };
  const config = await getApiConfig(userId, provider);
  return config ? listApiModels(provider, config) : null;
}

/** What is known about a model, whichever provider runs it. */
export type ModelInfo = {
  /** What the model can do, such as "tools" and "vision"; null when unknown. */
  capabilities: string[] | null;
  contextLength: number | null;
  /** The most tokens one reply can have; null when unknown. */
  maxOutput: number | null;
  /** The keys of the options it takes (see lib/agentSettings.ts); null when unknown. */
  options: string[] | null;
  /** What its reasoning option can be set to; null when it has no such option. */
  reasoning: string[] | null;
  /** Whether it can reason at all; null when unknown. */
  reasons: boolean | null;
  /** Its own values for its options, as far as they are known. */
  defaults: AgentSettings;
};

const UNKNOWN_MODEL: ModelInfo = {
  capabilities: null,
  contextLength: null,
  maxOutput: null,
  options: null,
  reasoning: null,
  reasons: null,
  defaults: {},
};

// The options OpenAI's Responses API has: it has no seed, stop or penalties.
export const RESPONSES_OPTIONS = ["temperature", "top_p", "max_tokens", "reasoning", "verbosity"];

/**
 * True when an agent on this model runs on OpenAI's Responses API. From GPT-5.4
 * on, Chat Completions refuses function tools unless reasoning is off, so models
 * that reason use Responses, and so do models the catalog does not know, which
 * are likely new. Models known not to reason stay on Chat Completions, for the
 * options only that API has.
 */
export function usesResponsesApi(provider: ProviderId, info: Pick<ModelInfo, "reasons"> | null): boolean {
  return provider === "openai" && info?.reasons !== false;
}

// Shape of one entry in OpenRouter's GET /models response.
type CatalogModel = {
  id?: string;
  canonical_slug?: string | null;
  context_length?: number | null;
  architecture?: { input_modalities?: string[] | null } | null;
  top_provider?: { max_completion_tokens?: number | null } | null;
  supported_parameters?: string[] | null;
  default_parameters?: Record<string, unknown> | null;
  reasoning?: {
    mandatory?: boolean;
    default_enabled?: boolean;
    supported_efforts?: string[] | null;
    default_effort?: string | null;
  } | null;
};

// OpenRouter's name for a parameter, where it differs from the option's key
const CATALOG_OPTION_NAMES: Record<string, string> = {
  max_completion_tokens: "max_tokens",
  reasoning_effort: "reasoning",
};

// Models that take a reasoning effort without saying which levels get these
const COMMON_EFFORTS = ["low", "medium", "high"];

function reasoningChoices(model: CatalogModel, parameters: string[]): string[] | null {
  const efforts = model.reasoning?.supported_efforts;
  if (efforts?.length) return efforts;
  if (parameters.includes("reasoning_effort")) return COMMON_EFFORTS;
  return parameters.includes("reasoning") && !model.reasoning?.mandatory ? ["off", "on"] : null;
}

// A model that reasons only when asked has default_enabled false. Its
// default_effort is then the level it uses once asked, not its default.
function reasoningDefault(model: CatalogModel, choices: string[] | null): string | undefined {
  const { mandatory, default_enabled: enabled, default_effort: effort } = model.reasoning ?? {};
  if (!choices) return undefined;
  if (enabled === false && !mandatory) return choices.find((c) => c === "none" || c === "off") ?? effort ?? undefined;
  return effort ?? (enabled && choices.includes("on") ? "on" : undefined);
}

function toModelInfo(model: CatalogModel): ModelInfo {
  if (!Array.isArray(model.supported_parameters)) return UNKNOWN_MODEL;
  const parameters = model.supported_parameters;
  const reasoning = reasoningChoices(model, parameters);
  const offered = new Set(parameters.map((p) => CATALOG_OPTION_NAMES[p] ?? p));
  const defaults: AgentSettings = {};
  for (const [key, value] of Object.entries(model.default_parameters ?? {})) {
    if (typeof value === "number") defaults[key] = value;
  }
  const defaultReasoning = reasoningDefault(model, reasoning);
  if (defaultReasoning) defaults.reasoning = defaultReasoning;
  return {
    capabilities: [
      ...(parameters.includes("tools") ? ["tools"] : []),
      ...(model.architecture?.input_modalities?.includes("image") ? ["vision"] : []),
    ],
    contextLength: model.context_length ?? null,
    maxOutput: model.top_provider?.max_completion_tokens ?? null,
    options: OPTION_KEYS.api.filter((key) => (key === "reasoning" ? reasoning !== null : offered.has(key))),
    reasoning,
    reasons: !!model.reasoning || parameters.includes("reasoning") || parameters.includes("reasoning_effort"),
    defaults,
  };
}

const CATALOG_CACHE_MS = 60 * 60 * 1000;
const CATALOG_RETRY_MS = 60 * 1000;

let catalog: { at: number; models: Map<string, ModelInfo> } | null = null;
let catalogTriedAt = 0;
let catalogLoad: Promise<void> | null = null;

async function loadCatalog() {
  try {
    const res = await fetch(`${OPENROUTER_URL}/models`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const raw = (await res.json()) as { data?: CatalogModel[] };
    if (!Array.isArray(raw.data)) throw new Error("no model list");
    const models = new Map<string, ModelInfo>();
    for (const model of raw.data) {
      if (!model?.id) continue;
      const info = toModelInfo(model);
      models.set(model.id, info);
      // Providers' dated model names, such as gpt-5-2025-08-07
      if (model.canonical_slug && !models.has(model.canonical_slug)) models.set(model.canonical_slug, info);
    }
    catalog = { at: Date.now(), models };
  } catch (err) {
    console.error(`Cannot load the OpenRouter model catalog: ${(err as Error)?.message || err}`);
  }
}

/**
 * OpenRouter's public model catalog, which needs no key. An old copy is used
 * while a new one loads, and for as long as OpenRouter cannot be reached.
 */
async function getCatalog() {
  const now = Date.now();
  const stale = !catalog || now - catalog.at >= CATALOG_CACHE_MS;
  if (stale && !catalogLoad && now - catalogTriedAt >= CATALOG_RETRY_MS) {
    catalogTriedAt = now;
    catalogLoad = loadCatalog().finally(() => {
      catalogLoad = null;
    });
  }
  if (!catalog && catalogLoad) await catalogLoad;
  return catalog?.models ?? null;
}

// OpenAI does not say what its models can do, so the catalog's copy of them is used.
function openAIModelInfo(models: Map<string, ModelInfo>, model: string): ModelInfo {
  const info = models.get(`openai/${model}`) ?? models.get(`openai/${model.replace(/-\d{4}-\d{2}-\d{2}$/, "")}`);
  if (!info) return UNKNOWN_MODEL;
  // OpenAI only takes reasoning levels, not on and off
  const levelsOnly = info.reasoning?.includes("on") ? null : info.reasoning;
  const options = info.options?.filter((key) => {
    if (key === "reasoning" && !levelsOnly) return false;
    return !usesResponsesApi("openai", info) || RESPONSES_OPTIONS.includes(key);
  });
  return { ...info, options: options ?? null, reasoning: levelsOnly };
}

/** What is known about `model` on `provider`. Never throws: what cannot be found out is reported as unknown. */
export async function getModelInfo(userId: string, provider: ProviderId, model: string): Promise<ModelInfo> {
  if (provider === "ollama") {
    const info = await getOllamaModelInfo(await getOllamaUrl(userId), model);
    return { ...UNKNOWN_MODEL, ...info, options: OPTION_KEYS.ollama };
  }
  const models = await getCatalog();
  if (!models) return UNKNOWN_MODEL;
  return provider === "openai" ? openAIModelInfo(models, model) : (models.get(model) ?? UNKNOWN_MODEL);
}

function sortNames(names: string[]): string[] {
  return [...new Set(names.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
