import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { OpenAIConfig } from "@/server/config";
import type { ChatMessage } from "@/lib/types";
import type { AssistantReply } from "./conversation";

// Some accounts are not allowed to stream certain models; detect that error so
// the request can be retried without streaming.
function isStreamingUnsupported(err: unknown): boolean {
  const e = err as {
    code?: string;
    param?: string;
    status?: number;
    message?: string;
    error?: { code?: string; param?: string; message?: string };
  } | null;
  if (!e) return false;
  const code = e.code ?? e.error?.code;
  const param = e.param ?? e.error?.param;
  if (code === "unsupported_value" && param === "stream") return true;
  return e.status === 400 && /must be verified to stream/i.test(String(e.message || e.error?.message || ""));
}

/**
 * Starts a chat on OpenAI and returns an NDJSON stream in the same format as
 * Ollama ({ message: { content } } lines, then { done: true }). System
 * messages are not sent. Cancelling the stream aborts the OpenAI request.
 */
export function streamOpenAIChat(
  { model, messages }: { model: string; messages: ChatMessage[] },
  config: OpenAIConfig,
  reply: AssistantReply
): ReadableStream<Uint8Array> {
  const client = new OpenAI(config);
  const openaiMessages: ChatCompletionMessageParam[] = messages.flatMap((m): ChatCompletionMessageParam[] =>
    m.role === "system" ? [] : [{ role: m.role, content: m.content }]
  );
  const abort = new AbortController();
  const encoder = new TextEncoder();
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: object) => {
        if (!cancelled) controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };
      const writeDelta = (text: string) => {
        if (!text) return;
        reply.append(text);
        send({ message: { content: text } });
      };

      try {
        try {
          // First attempt: true streaming
          const completion = await client.chat.completions.create(
            { model, messages: openaiMessages, stream: true },
            { signal: abort.signal }
          );
          for await (const part of completion) {
            const choice = part.choices?.[0];
            writeDelta(choice?.delta?.content ?? "");
            if (choice?.finish_reason) send({ done: true });
          }
        } catch (err) {
          if (cancelled || !isStreamingUnsupported(err)) throw err;

          // Fallback: non-streaming request, return as a single message (no fake chunking)
          const completion = await client.chat.completions.create(
            { model, messages: openaiMessages },
            { signal: abort.signal }
          );
          writeDelta(completion.choices?.[0]?.message?.content ?? "");
          send({ done: true });
        }
        await reply.persist();
        if (!cancelled) controller.close();
      } catch (err) {
        await reply.persist();
        if (!cancelled) controller.error(err);
      }
    },
    async cancel() {
      cancelled = true;
      abort.abort();
      await reply.persist();
    },
  });
}
