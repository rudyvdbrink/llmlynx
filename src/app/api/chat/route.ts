import { NextRequest } from "next/server";

export const runtime = "nodejs";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

function getSystemPrompt(): string {
  const raw = process.env.SYSTEM_PROMPT || "You are the llynx, a helpful assistant.";
  // Allow escaped \n sequences in .env to become real newlines
  return raw.replace(/\\n/g, "\n").trim();
}

export async function POST(req: NextRequest) {
  let body: { messages: ChatMessage[]; model?: string } | null = null;

  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  if (!body?.messages || !Array.isArray(body.messages)) {
    return new Response("messages array required", { status: 400 });
  }

  const model = body.model || "gemma3:1b";
  const systemPrompt = getSystemPrompt();

  // Always inject system prompt at the front unless one already exists
  const hasSystem = body.messages.some(m => m.role === "system");
  const finalMessages = hasSystem
    ? body.messages
    : [{ role: "system", content: systemPrompt } as ChatMessage, ...body.messages];

  const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: finalMessages,
      stream: true,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const txt = await upstream.text().catch(() => "");
    return new Response(`Ollama error: ${txt || upstream.status}`, { status: 502 });
  }

  // Stream passthrough (newline-delimited JSON objects)
  const stream = new ReadableStream({
    start(controller) {
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = "";

      const pump = () => {
        reader.read().then(({ value, done }) => {
          if (done) {
            controller.close();
            return;
          }
          buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              controller.enqueue(encoder.encode(trimmed + "\n"));
            }
            pump();
        }).catch(err => controller.error(err));
      };
      pump();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}