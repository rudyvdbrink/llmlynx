import { NextRequest } from "next/server";
import { prisma } from "../../../lib/prisma";
import { getCurrentUser } from "../../../lib/session";

export const runtime = "nodejs";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

function getDefaultSystemPrompt(): string {
  const raw = process.env.SYSTEM_PROMPT || "You are the llynx, a helpful assistant.";
  return raw.replace(/\\n/g, "\n").trim();
}

// Helper to make a short title from the first user message
function makeTitleFrom(content: string, maxWords = 8, maxChars = 80) {
  const words = content.trim().split(/\s+/).slice(0, maxWords);
  let title = words.join(" ");
  if (title.length > maxChars) title = title.slice(0, maxChars - 1) + "…";
  return title || "New chat";
}

export async function POST(req: NextRequest) {
  let body: {
    messages: ChatMessage[];
    model?: string;           // raw model tag when not using agents
    agentId?: string;         // selected agent id
    conversationId?: string;
  } | null = null;

  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  if (!body?.messages || !Array.isArray(body.messages)) {
    return new Response("messages array required", { status: 400 });
  }

  const user = await getCurrentUser().catch(() => null);
  const isAuthed = !!user;

  // Resolve agent if provided
  let upstreamModel = body.model || "gemma3:1b";
  let systemPrompt = getDefaultSystemPrompt();
  let modelIdent: string | null = null;
  let options: Record<string, any> | undefined = undefined;

  if (body.agentId) {
    // Must be authenticated to use an agent (since we need to load it from DB)
    if (!isAuthed) {
      return new Response("Unauthorized", { status: 401 });
    }
    const agent = await prisma.agent.findUnique({ where: { id: body.agentId } });
    if (!agent || agent.userId !== user!.id) {
      return new Response("Agent not found", { status: 404 });
    }
    upstreamModel = agent.baseModel || upstreamModel;
    systemPrompt = (agent.systemPrompt?.trim() || systemPrompt);
    options = agent.settings as any;
    modelIdent = `agent:${agent.id}`;
  } else {
    // If client is sending a prefixed value via conversations API, unify storage key
    modelIdent = body.model ? (body.model.startsWith("model:") || body.model.startsWith("agent:") ? body.model : `model:${body.model}`) : "model:gemma3:1b";
  }

  // Always inject system prompt at the front unless one already exists
  const hasSystem = body.messages.some((m) => m.role === "system");
  const finalMessages = hasSystem
    ? body.messages
    : [{ role: "system", content: systemPrompt } as ChatMessage, ...body.messages];

  // Resolve or create a conversation (ONLY if authenticated)
  let conversationId: string | null = null;
  if (isAuthed) {
    conversationId = body.conversationId || null;

    if (conversationId) {
      const convo = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { id: true, userId: true, title: true },
      });
      if (!convo || convo.userId !== user!.id) {
        return new Response("Conversation not found", { status: 404 });
      }
    } else {
      const convo = await prisma.conversation.create({
        data: { userId: user!.id, model: modelIdent },
        select: { id: true },
      });
      conversationId = convo.id;
    }

    // Save the just-submitted user message (the last "user" message)
    const last = [...body.messages].reverse().find((m) => m.role === "user");
    if (last) {
      const hasAnyMessage = await prisma.message.findFirst({
        where: { conversationId: conversationId! },
        select: { id: true },
      });

      await prisma.$transaction(async (tx) => {
        if (!hasAnyMessage) {
          await tx.conversation.update({
            where: { id: conversationId! },
            data: { title: makeTitleFrom(last.content) },
          });
        }
        await tx.message.create({
          data: {
            conversationId: conversationId!,
            role: "user",
            content: last.content,
          },
        });
        await tx.conversation.update({
          where: { id: conversationId! },
          data: { updatedAt: new Date(), model: modelIdent },
        });
      });
    }
  }
  // Guest mode: no DB writes; still call model.

  // Call upstream model and stream back, while accumulating assistant content to save at the end (only if authed)
  const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: upstreamModel,
      messages: finalMessages,
      stream: true,
      ...(options ? { options } : {}),
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const txt = await upstream.text().catch(() => "");
    return new Response(`Ollama error: ${txt || upstream.status}`, { status: 502 });
  }

  let assistantAccum = "";
  let saved = false;

  const stream = new ReadableStream({
    start(controller) {
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = "";

      const persistAssistant = async () => {
        if (saved || !isAuthed || !conversationId) return;
        saved = true;
        try {
          if (assistantAccum.trim().length > 0) {
            await prisma.$transaction(async (tx) => {
              await tx.message.create({
                data: {
                  conversationId: conversationId!,
                  role: "assistant",
                  content: assistantAccum,
                },
              });
              await tx.conversation.update({
                where: { id: conversationId! },
                data: { updatedAt: new Date(), model: modelIdent },
              });
            });
          } else {
            await prisma.conversation.update({
              where: { id: conversationId! },
              data: { model: modelIdent },
            });
          }
        } catch {
          // swallow
        }
      };

      const pump = () => {
        reader
          .read()
          .then(async ({ value, done }) => {
            if (done) {
              await persistAssistant();
              controller.close();
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;

              try {
                const obj = JSON.parse(trimmed);
                if (obj?.message?.content) {
                  assistantAccum += obj.message.content;
                }
                if (obj?.done) {
                  await persistAssistant();
                }
              } catch {
                // ignore
              }

              controller.enqueue(encoder.encode(trimmed + "\n"));
            }

            pump();
          })
          .catch(async (err) => {
            try {
              await persistAssistant();
            } finally {
              controller.error(err);
            }
          });
      };
      pump();
    },
  });

  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
  };
  if (isAuthed && conversationId) {
    headers["X-Conversation-Id"] = conversationId;
  }

  return new Response(stream, { headers });
}