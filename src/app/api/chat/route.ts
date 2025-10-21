import { NextRequest } from "next/server";
import { prisma } from "../../../server/db/prisma";
import { getCurrentUser } from "../../../server/auth/session";
import OpenAI from "openai";

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
    model?: string;           // selection string: "model:<name>" | "remote:<name>" | legacy raw model
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

  // Detect selection type
  const selection = body.model || "";
  const isRemote = typeof selection === "string" && selection.startsWith("remote:");
  const remoteModelName = isRemote ? selection.slice("remote:".length) : null;

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
  } else if (isRemote) {
    // For remote models, keep storage key as "remote:<name>"
    modelIdent = `remote:${remoteModelName}`;
  } else {
    // If client is sending a prefixed value via conversations API, unify storage key
    modelIdent =
      body.model
        ? body.model.startsWith("model:") || body.model.startsWith("agent:") || body.model.startsWith("remote:")
          ? body.model
          : `model:${body.model}`
        : "model:gemma3:1b";
  }

  // Prepare messages
  // For OpenAI remote models: do NOT include system prompts; only pass user/assistant messages.
  // For local models (Ollama): inject default/agent system prompt if no system message exists.
  let finalMessages: ChatMessage[];
  if (isRemote) {
    finalMessages = body.messages.filter((m) => m.role === "user" || m.role === "assistant");
  } else {
    const hasSystem = body.messages.some((m) => m.role === "system");
    finalMessages = hasSystem
      ? body.messages
      : [{ role: "system", content: systemPrompt } as ChatMessage, ...body.messages];
  }

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

  // Build streaming response machinery shared by both paths
  let assistantAccum = "";
  let saved = false;

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

  // Remote (OpenAI) path
  if (isRemote) {
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
      return new Response("OpenAI API key not configured", { status: 403 });
    }

    const organization = process.env.OPENAI_ORG || process.env.OPENAI_ORG_ID || undefined;
    const project = process.env.OPENAI_PROJECT || undefined;

    // Map to OpenAI chat messages (exclude system by design above)
    const openaiMessages = finalMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const client = new OpenAI({ apiKey, ...(organization ? { organization } : {}), ...(project ? { project } : {}) });

    const isUnsupportedStream = (err: any) =>
      (err && (err.code === "unsupported_value" || err?.error?.code === "unsupported_value") &&
        (err.param === "stream" || err?.error?.param === "stream")) ||
      (err?.status === 400 && /must be verified to stream/i.test(String(err?.message || err?.error?.message || "")));

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const writeDelta = (text: string) => {
          if (!text) return;
          assistantAccum += text;
          controller.enqueue(encoder.encode(JSON.stringify({ message: { content: text } }) + "\n"));
        };
        const writeDone = () => {
          controller.enqueue(encoder.encode(JSON.stringify({ done: true }) + "\n"));
        };

        try {
          try {
            // First attempt: true streaming
            const completion = await client.chat.completions.create({
              model: remoteModelName || "gpt-5",
              messages: openaiMessages as any,
              stream: true,
            });

            // @ts-ignore async iterable
            for await (const part of completion) {
              const choice = part?.choices?.[0];
              const deltaText = choice?.delta?.content ?? "";
              if (deltaText) writeDelta(deltaText);
              const finish = choice?.finish_reason;
              if (finish) {
                writeDone();
              }
            }
          } catch (err: any) {
            if (!isUnsupportedStream(err)) throw err;

            // Fallback: non-streaming request, return as a single message (no fake chunking)
            const completion = await client.chat.completions.create({
              model: remoteModelName || "gpt-5",
              messages: openaiMessages as any,
              // no stream
            });
            const full = completion?.choices?.[0]?.message?.content ?? "";
            if (full) {
              writeDelta(full);
            }
            writeDone();
          }
        } catch (err) {
          try {
            await persistAssistant();
          } finally {
            controller.error(err as any);
          }
          return;
        }

        try {
          await persistAssistant();
        } finally {
          controller.close();
        }
      },
      async cancel() {
        try {
          await persistAssistant();
        } catch {
          // ignore
        }
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

  // Local (Ollama) path
  const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: upstreamModel.startsWith("model:") ? upstreamModel.slice("model:".length) : upstreamModel,
      messages: finalMessages,
      stream: true,
      ...(options ? { options } : {}),
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const txt = await upstream.text().catch(() => "");
    return new Response(`Ollama error: ${txt || upstream.status}`, { status: 502 });
  }

  const stream = new ReadableStream({
    start(controller) {
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = "";

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