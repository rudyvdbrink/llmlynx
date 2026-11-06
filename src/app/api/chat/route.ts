import { NextRequest } from "next/server";
import { prisma } from "@/server/db/prisma";
import { getCurrentUser } from "@/server/auth/session";
import { getDefaultSystemPrompt } from "@/server/config";
import { getApiConfig, getOllamaUrl } from "@/server/providers";
import { stopAttempt, trackAttempt } from "@/server/chat/attempts";
import { createAssistantReply, loadHistory, resolveConversation, saveUserMessage } from "@/server/chat/conversation";
import { streamOllamaChat, toOllamaTools } from "@/server/chat/ollama";
import { streamOpenAIChat } from "@/server/chat/openai";
import type { RequestSetupInput } from "@/server/chat/setup";
import { textBudget } from "@/server/tools/definitions";
import { toolGuidance, toolsFor } from "@/server/tools/policy";
import { normalizeSelection, parseSelection, toSelection } from "@/lib/selection";
import { PROVIDER_LABELS, type KeyProviderId } from "@/lib/providers";
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

type Target =
  | {
      kind: "ollama";
      modelKey: string;
      model: string;
      baseUrl: string;
      systemPrompt: string;
      options?: unknown;
      agent: { tools: unknown; maxToolCalls: number } | null; // set when the user chats with an agent
    }
  | { kind: KeyProviderId; modelKey: string; model: string };

/** Works out which backend and model to use. Returns null if the agent is not the user's. */
async function resolveTarget(userId: string, model: unknown, agentId: unknown): Promise<Target | null> {
  if (typeof agentId === "string" && agentId) {
    const agent = await prisma.agent.findFirst({ where: { id: agentId, userId } });
    if (!agent) return null;
    return {
      kind: "ollama",
      modelKey: toSelection("agent", agent.id),
      model: parseSelection(agent.baseModel).value,
      baseUrl: await getOllamaUrl(userId),
      systemPrompt: agent.systemPrompt?.trim() || getDefaultSystemPrompt(),
      options: agent.settings,
      agent: { tools: agent.tools, maxToolCalls: agent.maxToolCalls },
    };
  }

  const selection = normalizeSelection(typeof model === "string" ? model : undefined);
  const { kind, value } = parseSelection(selection);
  if (kind === "agent") return null; // agents are chosen with agentId
  if (kind !== "ollama") return { kind, modelKey: selection, model: value };
  return {
    kind: "ollama",
    modelKey: selection,
    model: value,
    baseUrl: await getOllamaUrl(userId),
    systemPrompt: getDefaultSystemPrompt(),
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
  // The tools the model can call: only agents get them, see server/tools/policy.ts
  const tools =
    target.kind === "ollama"
      ? await toolsFor({ agent: target.agent, ollama: { baseUrl: target.baseUrl, model: target.model } })
      : [];
  const systemPrompt =
    target.kind === "ollama" && tools.length ? `${target.systemPrompt}\n\n${toolGuidance(tools)}` : undefined;
  // Everything the model gets besides the conversation, which is stored with the reply
  const setup: RequestSetupInput =
    target.kind === "ollama"
      ? {
          systemPrompt: systemPrompt ?? target.systemPrompt,
          options: target.options,
          ...(tools.length ? { tools: toOllamaTools(tools) } : {}),
        }
      : {};
  const reply = createAssistantReply({
    conversationId,
    userId: user.id,
    modelKey: target.modelKey,
    model: toSelection(target.kind, target.model),
    setup,
  });

  const stream =
    target.kind !== "ollama"
      // OpenAI and OpenRouter models get no system prompt at all
      ? streamOpenAIChat({ model: target.model, messages: history }, apiConfig!, reply)
      : streamOllamaChat(
          {
            baseUrl: target.baseUrl,
            model: target.model,
            messages: [{ role: "system", content: setup.systemPrompt ?? target.systemPrompt }, ...history],
            options: target.options,
            tools,
            maxToolCalls: target.agent?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
            toolContext: {
              userId: user.id,
              textBudget: textBudget((target.options as { num_ctx?: unknown } | undefined)?.num_ctx),
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
