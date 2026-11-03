import { createLineSplitter } from "@/lib/ndjson";
import type { ChatMessage, ReplyStatus } from "@/lib/types";
import type { AssistantReply } from "./conversation";

export type OllamaChatRequest = {
  baseUrl: string; // the user's Ollama server
  model: string;
  messages: ChatMessage[];
  options?: unknown; // agent generation settings, passed through as Ollama options
};

// Shape of one entry in Ollama's GET /api/ps response.
type OllamaRunning = { name?: string; model?: string; context_length?: number };

// Ollama lists "llama3" as "llama3:latest".
const withTag = (name: string) => (/:[^/]*$/.test(name) ? name : `${name}:latest`);

/**
 * True when Ollama has `model` in memory, ready for a chat with `options`. A
 * model that is still loading is not listed yet, and one loaded with another
 * num_ctx is loaded again for the chat.
 */
async function isLoaded(baseUrl: string, model: string, options: unknown, signal: AbortSignal): Promise<boolean> {
  const res = await fetch(`${baseUrl}/api/ps`, { cache: "no-store", signal });
  if (!res.ok) return true; // cannot tell; the chat loads it if needed
  const raw = (await res.json().catch(() => ({}))) as { models?: unknown };
  const running: OllamaRunning[] = Array.isArray(raw.models) ? raw.models : [];
  const numCtx = (options as { num_ctx?: unknown } | undefined)?.num_ctx;
  return running.some(
    (m) =>
      withTag(m?.name || m?.model || "") === withTag(model) &&
      (typeof numCtx !== "number" || m.context_length === undefined || m.context_length === numCtx)
  );
}

/** POSTs to Ollama's /api/chat. Throws with Ollama's explanation if it rejects the request. */
async function postChat(baseUrl: string, body: object, signal: AbortSignal): Promise<Response> {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error((await res.text().catch(() => "")) || String(res.status));
  return res;
}

/**
 * Starts a streaming chat on Ollama and returns its NDJSON stream. Ollama sends
 * nothing until the first token, so the stream starts with { status } lines:
 * "loading" while the model is loaded into memory, then "thinking". Ollama's
 * lines follow unchanged; message text and reasoning are collected into
 * `reply`, which is saved when Ollama reports done, the stream ends, or the
 * client disconnects.
 * Cancelling the returned stream also cancels the Ollama request.
 *
 * If Ollama cannot be reached or rejects the request, the stream ends with an
 * { error } line.
 */
export function streamOllamaChat(
  { baseUrl, model, messages, options }: OllamaChatRequest,
  reply: AssistantReply
): ReadableStream<Uint8Array> {
  const abort = new AbortController();
  const encoder = new TextEncoder();
  const opts = options ? { options } : {};
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: string) => {
        if (!cancelled) controller.enqueue(encoder.encode(line + "\n"));
      };
      const sendStatus = (status: ReplyStatus) => send(JSON.stringify({ status }));
      const forward = async (line: string) => {
        try {
          const obj = JSON.parse(line);
          if (typeof obj?.message?.thinking === "string") reply.appendReasoning(obj.message.thinking);
          if (typeof obj?.message?.content === "string") reply.append(obj.message.content);
          if (obj?.done) await reply.persist();
        } catch {
          // not JSON; forward it untouched
        }
        send(line);
      };

      try {
        if (!(await isLoaded(baseUrl, model, options, abort.signal))) {
          sendStatus("loading");
          // A chat without messages only loads the model. It gets the chat's
          // options, or the chat would load the model again.
          await (await postChat(baseUrl, { model, messages: [], ...opts }, abort.signal)).text();
        }
        sendStatus("thinking");

        const upstream = await postChat(baseUrl, { model, messages, stream: true, ...opts }, abort.signal);
        const reader = upstream.body!.getReader();
        const decoder = new TextDecoder();
        const lines = createLineSplitter();
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
        send(JSON.stringify({ error: `Ollama error: ${err instanceof Error ? err.message : String(err)}` }));
        if (!cancelled) controller.close();
      }
    },
    async cancel() {
      cancelled = true;
      abort.abort();
      await reply.persist();
    },
  });
}
