import { OLLAMA_URL } from "@/server/config";
import { createLineSplitter } from "@/lib/ndjson";
import type { ChatMessage } from "@/lib/types";
import type { AssistantReply } from "./conversation";

export type OllamaChatRequest = {
  model: string;
  messages: ChatMessage[];
  options?: unknown; // agent generation settings, passed through as Ollama options
};

/**
 * Starts a streaming chat on Ollama and returns its NDJSON stream. Lines are
 * forwarded unchanged; message text is collected into `reply`, which is saved
 * when Ollama reports done, the stream ends, or the client disconnects.
 * Cancelling the returned stream also cancels the Ollama request.
 *
 * Returns a 502 Response if Ollama cannot be reached or rejects the request.
 */
export async function streamOllamaChat(
  { model, messages, options }: OllamaChatRequest,
  reply: AssistantReply
): Promise<ReadableStream<Uint8Array> | Response> {
  let upstream: Response;
  try {
    upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: true, ...(options ? { options } : {}) }),
    });
  } catch (err) {
    return new Response(`Ollama error: ${err instanceof Error ? err.message : String(err)}`, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    const txt = await upstream.text().catch(() => "");
    return new Response(`Ollama error: ${txt || upstream.status}`, { status: 502 });
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const lines = createLineSplitter();
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const forward = async (line: string) => {
        try {
          const obj = JSON.parse(line);
          if (typeof obj?.message?.content === "string") reply.append(obj.message.content);
          if (obj?.done) await reply.persist();
        } catch {
          // not JSON; forward it untouched
        }
        if (!cancelled) controller.enqueue(encoder.encode(line + "\n"));
      };

      void (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            for (const line of lines.push(decoder.decode(value, { stream: true }))) await forward(line);
          }
          for (const line of [...lines.push(decoder.decode()), ...lines.flush()]) await forward(line);
          await reply.persist();
          if (!cancelled) controller.close();
        } catch (err) {
          await reply.persist();
          if (!cancelled) controller.error(err);
        }
      })();
    },
    async cancel(reason) {
      cancelled = true;
      await reader.cancel(reason).catch(() => {});
      await reply.persist();
    },
  });
}
