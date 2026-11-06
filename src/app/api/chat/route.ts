import { NextRequest } from "next/server";
import { prisma } from "@/server/db/prisma";
import { getCurrentUser } from "@/server/auth/session";
import { getDefaultSystemPrompt } from "@/server/config";
import { getApiConfig, getOllamaUrl } from "@/server/providers";
import { stopAttempt, trackAttempt } from "@/server/chat/attempts";
import { createAssistantReply, loadHistory, resolveConversation, saveUserMessage } from "@/server/chat/conversation";
import { getModelInfo, usesResponsesApi } from "@/server/chat/models";
import { streamOllamaChat } from "@/server/chat/ollama";
import { apiRequestParams, streamOpenAIChat } from "@/server/chat/openai";
import type { RequestSetupInput } from "@/server/chat/setup";
import { textBudget, toFunctionTools } from "@/server/tools/definitions";
import { hasCheckedTools, toolGuidance, toolsFor } from "@/server/tools/policy";
import { normalizeSelection, parseBaseModel, parseSelection, toSelection } from "@/lib/selection";
import { PROVIDER_LABELS, type ProviderId } from "@/lib/providers";
import { DEFAULT_MAX_TOOL_CALLS } from "@/lib/agentTools";

export const runtime = "nodejs";

// POST /api/chat
// body: { message: string, model?: string, agentId?: string, conversationId?: string, requestId?: string }
// `message` is the user's new message; the rest of the conversation is read from
// the database, so the model always gets the conversation as stored.
// `model` is a selection ("ollama:<name>" | "openai:<name>" | "openrouter:<name>")
// or a plain Ollama model name. Each user's own Ollama server and API keys are used.
// `requestId` (32 hex characters) identifies the send: a re-send with the same id
// replaces the attempt before it, see server/chat/attempts.ts.
// Responds with an NDJSON stream, which ends with an { end: true } line, and the
// conversation id in X-Conversation-Id. X-Tools is "1" when the model can call tools.

const REQUEST_ID = /^[0-9a-f]{32}$/;

// For the text budget of an agent's tools, when its provider does not say how long its context is
const UNKNOWN_CONTEXT = 32768;

type Target = {
  kind: ProviderId;
  modelKey: string;
  model: string;
  systemPrompt: string | null; // null: the model gets none (plain OpenAI and OpenRouter models)
  agent: { settings: unknown; tools: unknown; maxToolCalls: number } | null; // set when the user chats with an agent
};

/** Works out which backend and model to use. Returns null if the agent is not the user's. */
async function resolveTarget(userId: string, model: unknown, agentId: unknown): Promise<Target | null> {
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

export async function POST(req: NextRequest) {
  // Require authentication for all chat calls
  const user = await getCurrentUser().catch(() => null);
  if (!user) return new Response("Unauthorized", { status: 401 });

  let body: Record<string, unknown> | null;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!body || !message) return new Response("message required", { status: 400 });

  const target = await resolveTarget(user.id, body.model, body.agentId);
  if (!target) return new Response("Agent not found", { status: 404 });
  if (!target.model) return new Response("No model selected", { status: 400 });

  const apiConfig = target.kind === "ollama" ? null : await getApiConfig(user.id, target.kind);
  if (target.kind !== "ollama" && !apiConfig) {
    return new Response(`No ${PROVIDER_LABELS[target.kind]} API key. Add one on the account page.`, { status: 403 });
  }

  const conversationId = await resolveConversation(
    user.id,
    typeof body.conversationId === "string" ? body.conversationId : undefined,
    target.modelKey
  );
  if (!conversationId) return new Response("Conversation not found", { status: 404 });

  const requestId = typeof body.requestId === "string" && REQUEST_ID.test(body.requestId) ? body.requestId : null;
  const attemptKey = requestId && `${user.id}:${requestId}`;
  if (attemptKey) await stopAttempt(attemptKey);

  await saveUserMessage(conversationId, message, target.modelKey, requestId);
  // The conversation so far, ending with the new message. Like the system
  // prompt, it comes from the server, never from the client.
  const history = await loadHistory(conversationId);
  const { agent } = target;
  // What the model can do decides its tools and, on OpenAI and OpenRouter, which options it gets
  const modelInfo =
    agent && (target.kind !== "ollama" || hasCheckedTools(agent))
      ? await getModelInfo(user.id, target.kind, target.model)
      : null;
  // The tools the model can call: only agents get them, see server/tools/policy.ts
  const tools = toolsFor(agent, modelInfo?.capabilities ?? null);
  const systemPrompt =
    target.systemPrompt !== null && tools.length
      ? `${target.systemPrompt}\n\n${toolGuidance(tools)}`
      : target.systemPrompt;
  const system = systemPrompt !== null ? [{ role: "system" as const, content: systemPrompt }] : [];
  const apiParams =
    agent && target.kind !== "ollama"
      ? apiRequestParams(target.kind, agent.settings, modelInfo)
      : undefined;
  // Everything the model gets besides the conversation, which is stored with the reply
  const setup: RequestSetupInput = {
    ...(systemPrompt !== null ? { systemPrompt } : {}),
    ...(agent ? { options: apiParams ?? agent.settings } : {}),
    ...(tools.length ? { tools: toFunctionTools(tools) } : {}),
  };
  const reply = createAssistantReply({
    conversationId,
    userId: user.id,
    modelKey: target.modelKey,
    model: toSelection(target.kind, target.model),
    setup,
  });

  const toolRun = {
    tools,
    maxToolCalls: agent?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
    forAgent: !!agent,
  };
  const stream =
    target.kind !== "ollama"
      ? streamOpenAIChat(
          {
            ...toolRun,
            provider: target.kind,
            model: target.model,
            messages: [...system, ...history],
            params: apiParams,
            useResponses: !!agent && usesResponsesApi(target.kind, modelInfo),
            toolContext: { userId: user.id, textBudget: textBudget(modelInfo?.contextLength ?? UNKNOWN_CONTEXT) },
          },
          apiConfig!,
          reply
        )
      : streamOllamaChat(
          {
            ...toolRun,
            baseUrl: await getOllamaUrl(user.id),
            model: target.model,
            messages: [...system, ...history],
            options: agent?.settings,
            toolContext: {
              userId: user.id,
              textBudget: textBudget((agent?.settings as { num_ctx?: unknown } | undefined)?.num_ctx),
            },
          },
          reply
        );

  return new Response(trackAttempt(attemptKey, stream, req.signal), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Conversation-Id": conversationId,
      ...(tools.length ? { "X-Tools": "1" } : {}),
    },
  });
}
