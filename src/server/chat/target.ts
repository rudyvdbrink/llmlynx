// What a request to a chat's model is made with: which backend and model the
// user chats with (a plain model, or an agent's base model), and everything
// that follows from it: its tools, its system prompt, its options and its
// context window. Worked out on the server, for a reply (POST /api/chat) and
// for a compaction (POST /api/conversations/:id/compact).

import { prisma } from "@/server/db/prisma";
import { getDefaultSystemPrompt } from "@/server/config";
import { getApiConfig, getOllamaUrl, type ApiConfig } from "@/server/providers";
import { fileTextBudget } from "@/server/files/history";
import { toFunctionTools, type ToolDefinition } from "@/server/tools/definitions";
import { toolGuidance, toolsFor } from "@/server/tools/policy";
import { ollamaOptions } from "@/lib/agentSettings";
import { DEFAULT_MAX_TOOL_CALLS } from "@/lib/agentTools";
import { PROVIDER_LABELS, type ProviderId } from "@/lib/providers";
import { normalizeSelection, parseBaseModel, parseSelection, toSelection } from "@/lib/selection";
import { UNKNOWN_WINDOW } from "./budget";
import { getModelInfo, usesResponsesApi, type ModelInfo } from "./models";
import { askOllama, loadedWindow } from "./ollama";
import { apiRequestParams, askApiModel } from "./openai";
import type { RequestSetupInput } from "./setup";
import { loadView, type ViewMessage } from "./view";

export type Target = {
  kind: ProviderId;
  modelKey: string;
  model: string;
  systemPrompt: string | null; // null: the model gets none (plain OpenAI and OpenRouter models)
  agent: { settings: unknown; tools: unknown; maxToolCalls: number } | null; // set when the user chats with an agent
};

/** Works out which backend and model to use. Returns null if the agent is not the user's. */
export async function resolveTarget(userId: string, model: unknown, agentId: unknown): Promise<Target | null> {
  if (typeof agentId === "string" && agentId) {
    const agent = await prisma.agent.findFirst({ where: { id: agentId, userId } });
    const base = parseBaseModel(agent?.baseModel);
    if (!agent || !base) return null;
    return {
      kind: base.provider,
      modelKey: toSelection("agent", agent.id),
      model: base.model,
      systemPrompt: agent.systemPrompt?.trim() || getDefaultSystemPrompt(),
      agent: { settings: agent.settings, tools: agent.tools, maxToolCalls: agent.maxToolCalls },
    };
  }

  const selection = normalizeSelection(typeof model === "string" ? model : undefined);
  const { kind, value } = parseSelection(selection);
  if (kind === "agent") return null; // agents are chosen with agentId
  return {
    kind,
    modelKey: selection,
    model: value,
    systemPrompt: kind === "ollama" ? getDefaultSystemPrompt() : null,
    agent: null,
  };
}

/** Everything a request to the target's model is made with. */
export type ChatSetup = {
  target: Target;
  apiConfig: ApiConfig | null; // OpenAI and OpenRouter: the user's key
  baseUrl: string; // Ollama: the user's server
  modelInfo: ModelInfo | null;
  capabilities: string[] | null; // what an agent's base model can do; null when unknown, and for a plain chat
  tools: ToolDefinition[]; // the tools the model can call: only agents get them, see server/tools/policy.ts
  vision: boolean;
  maxToolCalls: number;
  systemPrompt: string | null;
  apiParams: Record<string, unknown> | undefined;
  ollamaParams: ReturnType<typeof ollamaOptions> | undefined;
  useResponses: boolean;
  // What the tools' text budgets go by: the agent's num_ctx on Ollama, else how long the model's context is
  contextTokens: unknown;
  // The model's context window, for the budget of the conversation (see budget.ts); null for a chat on
  // Ollama without a num_ctx, which runs in the window Ollama loads the model with
  window: number | null;
  // Everything the model gets besides the conversation, which is stored with a reply
  stored: RequestSetupInput;
};

/** The setup of a chat with `target`, or why there cannot be one: the user has no key for its provider. */
export async function chatSetup(userId: string, target: Target): Promise<ChatSetup | { error: string; status: number }> {
  const { agent, kind } = target;
  const apiConfig = kind === "ollama" ? null : await getApiConfig(userId, kind);
  if (kind !== "ollama" && !apiConfig) {
    return { error: `No ${PROVIDER_LABELS[kind]} API key. Add one on the account page.`, status: 403 };
  }

  // What the model can do decides its tools, the files it takes and, on OpenAI and OpenRouter, which options
  // it gets. A plain chat on OpenAI or OpenRouter only needs how long the model's context is
  const modelInfo = agent || kind !== "ollama" ? await getModelInfo(userId, kind, target.model) : null;
  const capabilities = agent ? (modelInfo?.capabilities ?? null) : null;
  const tools = toolsFor(agent, capabilities);
  const contextTokens =
    kind === "ollama" ? (agent?.settings as { num_ctx?: unknown } | undefined)?.num_ctx : (modelInfo?.contextLength ?? UNKNOWN_WINDOW);
  const maxToolCalls = agent?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const systemPrompt =
    target.systemPrompt !== null && tools.length ? `${target.systemPrompt}\n\n${toolGuidance(tools, maxToolCalls)}` : target.systemPrompt;
  const apiParams = agent && kind !== "ollama" ? apiRequestParams(kind, agent.settings, modelInfo) : undefined;
  const ollamaParams = agent && kind === "ollama" ? ollamaOptions(agent.settings) : undefined;
  return {
    target,
    apiConfig,
    baseUrl: kind === "ollama" ? await getOllamaUrl(userId) : "",
    modelInfo,
    capabilities,
    tools,
    vision: !!capabilities?.includes("vision"),
    maxToolCalls,
    systemPrompt,
    apiParams,
    ollamaParams,
    useResponses: !!agent && usesResponsesApi(kind, modelInfo),
    contextTokens,
    window: typeof contextTokens === "number" && contextTokens > 0 ? contextTokens : null,
    stored: {
      ...(systemPrompt !== null ? { systemPrompt } : {}),
      ...(agent ? { options: apiParams ?? ollamaParams } : {}),
      ...(tools.length ? { tools: toFunctionTools(tools) } : {}),
    },
  };
}

/**
 * The conversation as the model of `setup` gets it, read from the database,
 * with its system prompt. Like the system prompt, it comes from the server,
 * never from the client.
 */
export async function chatView(conversationId: string, setup: ChatSetup): Promise<ViewMessage[]> {
  const { tools, vision, contextTokens, systemPrompt } = setup;
  const has = (name: string) => tools.some((t) => t.name === name);
  const history = await loadView(conversationId, {
    files: setup.target.agent
      ? { vision, textBudget: fileTextBudget(contextTokens), readFile: has("read_file"), viewPages: has("view_pdf_pages") }
      : undefined,
    tools: tools.map((t) => t.name),
  });
  return [...(systemPrompt !== null ? [{ role: "system" as const, content: systemPrompt }] : []), ...history];
}

/**
 * The context window of the chat's model, outside a reply: the one of
 * `setup`, or for a chat on Ollama without one, the window Ollama has the
 * model loaded with. Null when it is not known.
 */
export async function chatWindow(setup: ChatSetup): Promise<number | null> {
  if (setup.window) return setup.window;
  return setup.target.kind === "ollama" ? loadedWindow(setup.baseUrl, setup.target.model) : null;
}

/**
 * One request to the model of `setup` outside a reply, without tools: the
 * text it wrote. On OpenAI and OpenRouter, `saveCost` gets what it cost.
 */
export function askModel(setup: ChatSetup, view: ViewMessage[], signal: AbortSignal, saveCost: (usd: number) => Promise<void>): Promise<string> {
  const { kind, model } = setup.target;
  if (kind === "ollama") return askOllama({ baseUrl: setup.baseUrl, model, options: setup.ollamaParams }, view, signal);
  return askApiModel(
    { provider: kind, model, params: setup.apiParams, useResponses: setup.useResponses },
    setup.apiConfig!,
    view,
    { signal, saveCost }
  );
}
