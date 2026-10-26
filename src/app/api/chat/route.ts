import { NextRequest } from "next/server";
import { prisma } from "@/server/db/prisma";
import { getCurrentUser } from "@/server/auth/session";
import { getDefaultSystemPrompt } from "@/server/config";
import { getApiConfig, getOllamaUrl } from "@/server/providers";
import { createAssistantReply, resolveConversation, saveUserMessage } from "@/server/chat/conversation";
import { streamOllamaChat } from "@/server/chat/ollama";
import { streamOpenAIChat } from "@/server/chat/openai";
import { normalizeSelection, parseSelection, toSelection } from "@/lib/selection";
import { PROVIDER_LABELS, type KeyProviderId } from "@/lib/providers";
import type { ChatMessage, Role } from "@/lib/types";

export const runtime = "nodejs";

// POST /api/chat
// body: { messages: ChatMessage[], model?: string, agentId?: string, conversationId?: string }
// `model` is a selection ("ollama:<name>" | "openai:<name>" | "openrouter:<name>")
// or a plain Ollama model name. Each user's own Ollama server and API keys are used.
// Responds with an NDJSON stream and the conversation id in X-Conversation-Id.

type Target =
  | { kind: "ollama"; modelKey: string; model: string; baseUrl: string; systemPrompt: string; options?: unknown }
  | { kind: KeyProviderId; modelKey: string; model: string };

const ROLES: Role[] = ["user", "assistant", "system"];

function parseMessages(input: unknown): ChatMessage[] | null {
  if (!Array.isArray(input)) return null;
  const valid = input.every(
    (m) => m && typeof m === "object" && ROLES.includes(m.role) && typeof m.content === "string"
  );
  return valid ? input.map((m) => ({ role: m.role, content: m.content })) : null;
}

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

  const messages = parseMessages(body?.messages);
  if (!body || !messages) return new Response("messages array required", { status: 400 });

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

  // Save the just-submitted user message (the last "user" message)
  const lastUser = messages.findLast((m) => m.role === "user");
  if (lastUser) await saveUserMessage(conversationId, lastUser.content, target.modelKey);

  // The system prompt always comes from the server, never from the client.
  // OpenAI and OpenRouter models get no system prompt at all.
  const history = messages.filter((m) => m.role !== "system");
  const reply = createAssistantReply(conversationId, target.modelKey);

  const stream =
    target.kind !== "ollama"
      ? streamOpenAIChat({ model: target.model, messages: history }, apiConfig!, reply)
      : await streamOllamaChat(
          {
            baseUrl: target.baseUrl,
            model: target.model,
            messages: [{ role: "system", content: target.systemPrompt }, ...history],
            options: target.options,
          },
          reply
        );
  if (stream instanceof Response) return stream;

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Conversation-Id": conversationId,
    },
  });
}
