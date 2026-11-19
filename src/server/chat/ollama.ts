import { DEFAULT_MAX_TOOL_CALLS } from "@/lib/agentTools";
import { createLineSplitter } from "@/lib/ndjson";
import { withOllamaTag } from "@/lib/providers";
import type { ChatMessage, ReplyStatus } from "@/lib/types";
import { toFunctionTools, type ToolDefinition } from "@/server/tools/definitions";
import type { AssistantReply } from "./conversation";
import { addToLastMessage, runToolLoop, type ChatToolContext, type ModelTurn } from "./toolLoop";

// A message as Ollama's /api/chat takes it.
export type OllamaMessage = {
  role: ChatMessage["role"] | "tool";
  content: string;
  thinking?: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
  tool_call_id?: string;
  images?: string[]; // base64
};

type OllamaToolCall = { id?: string; function: { index?: number; name: string; arguments?: Record<string, unknown> } };

export type OllamaChatRequest = {
  baseUrl: string; // the user's Ollama server
  model: string;
  messages: ChatMessage[];
  options?: unknown; // agent generation settings, passed through as Ollama options
  // The tools the model can call; with none, the chat is a single request
  tools?: ToolDefinition[];
  // Most tool calls per reply (0: no limit), see runToolLoop
  maxToolCalls?: number;
  toolContext?: ChatToolContext;
  // Set when the user chats with an agent, for the error when its model is gone
  forAgent?: boolean;
};

/** A message of the conversation as Ollama takes it: images go in their own field. */
const toOllama = ({ role, content, images }: ChatMessage): OllamaMessage => ({
  role,
  content,
  ...(images?.length ? { images: images.map((i) => i.data) } : {}),
});

// Shape of one entry in Ollama's GET /api/ps response.
type OllamaRunning = { name?: string; model?: string; context_length?: number };

// Ollama's answer when it does not have a model, such as {"error":"model 'x' not found"}
const MODEL_NOT_FOUND = /model ['"].*['"] not found/i;

// Ollama's answer when the model wrote a tool call it cannot read, such as Qwen's
// "XML syntax error on line 4: element <parameter> closed by </function>"
const UNREADABLE_TOOL_CALL = /XML syntax error|tool call/i;

// Added to the last message when the model gets a second try after such a call
const RETRY_NOTE =
  "[Your last reply had a tool call that could not be read. Write it again in the tool call format, " +
  "with every tag closed, such as each parameter before the function.]";

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
      withOllamaTag(m?.name || m?.model || "") === withOllamaTag(model) &&
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
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    let message = text;
    try {
      const error = JSON.parse(text)?.error;
      if (typeof error === "string" && error) message = error;
    } catch {
      // not JSON: the text as it is
    }
    throw new Error(message || String(res.status));
  }
  return res;
}

/**
 * Starts a streaming chat on Ollama and returns its NDJSON stream. Ollama sends
 * nothing until the first token, so the stream starts with { status } lines:
 * "loading" while the model is loaded into memory, then "thinking". Ollama's
 * lines follow unchanged; message text and reasoning are collected into
 * `reply`, which is saved when the stream ends or the client disconnects.
 * Cancelling the returned stream also cancels the Ollama request.
 *
 * With `tools`, the model may call them: each call is announced with a
 * { tool: ToolStep } line (state "running"), run, and announced again with its
 * outcome; then the model continues with the results. Every step is saved.
 * A { pause } line says the reply waits for the user's choice (see runToolLoop).
 *
 * If Ollama cannot be reached, rejects the request or reports an error in its
 * stream, the stream ends with an { error } line. A request that failed on a tool
 * call the model wrote wrong is made once more first, with a note for the model.
 */
export function streamOllamaChat(
  { baseUrl, model, messages, options, tools = [], maxToolCalls = DEFAULT_MAX_TOOL_CALLS, toolContext, forAgent }: OllamaChatRequest,
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

      /**
       * Runs one request to Ollama, streaming it to the client. Returns what the model
       * wrote and called. `onThinking` is called when reasoning streams.
       */
      async function chatTurn(conversation: OllamaMessage[], offered: ToolDefinition[], onThinking?: () => void) {
        const turn = { content: "", thinking: "", toolCalls: [] as OllamaToolCall[], calls: [] as ModelTurn["calls"] };
        // Ollama reports a failure after the stream started, such as a tool call it could not parse, as an
        // { error } line. The turn then fails, without running its tool calls.
        let failure = "";
        const forward = (line: string) => {
          try {
            const obj = JSON.parse(line);
            if (typeof obj?.error === "string") {
              failure ||= obj.error || "the model stopped with an error";
              return;
            }
            const thinking = obj?.message?.thinking;
            const content = obj?.message?.content;
            if (typeof thinking === "string") {
              reply.appendReasoning(thinking);
              turn.thinking += thinking;
              if (thinking) onThinking?.();
            }
            if (typeof content === "string") {
              reply.append(content);
              turn.content += content;
            }
            if (Array.isArray(obj?.message?.tool_calls)) turn.toolCalls.push(...obj.message.tool_calls);
          } catch {
            // not JSON; forward it untouched
          }
          send(line);
        };

        const upstream = await postChat(
          baseUrl,
          {
            model,
            messages: conversation,
            stream: true,
            ...(offered.length ? { tools: toFunctionTools(offered) } : {}),
            ...opts,
          },
          abort.signal
        );
        const reader = upstream.body!.getReader();
        const decoder = new TextDecoder();
        const lines = createLineSplitter();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const line of lines.push(decoder.decode(value, { stream: true }))) forward(line);
        }
        for (const line of [...lines.push(decoder.decode()), ...lines.flush()]) forward(line);
        if (failure) throw new Error(failure);
        turn.calls = turn.toolCalls.map((c) => ({
          id: c.id,
          name: c.function?.name ?? "",
          arguments: c.function?.arguments && typeof c.function.arguments === "object" ? c.function.arguments : {},
        }));
        return turn;
      }

      /**
       * One request with the tools offered. When the model wrote a tool call Ollama
       * cannot read, such as one with a parameter left open, it gets one more try:
       * such a slip is seldom made twice.
       */
      async function toolTurn(conversation: OllamaMessage[]) {
        let streamedThinking = false;
        try {
          return await chatTurn(conversation, tools, () => (streamedThinking = true));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (cancelled || !tools.length || !UNREADABLE_TOOL_CALL.test(message)) throw err;
          console.warn(`${model} wrote a tool call Ollama could not read; asking again: ${message}`);
          // The reasoning of the second try starts a paragraph of its own
          if (streamedThinking) {
            reply.appendReasoning("\n\n");
            send(JSON.stringify({ message: { role: "assistant", content: "", thinking: "\n\n" } }));
          }
          return chatTurn(addToLastMessage(conversation, RETRY_NOTE), tools);
        }
      }

      try {
        if (!(await isLoaded(baseUrl, model, options, abort.signal))) {
          sendStatus("loading");
          // A chat without messages only loads the model. It gets the chat's
          // options, or the chat would load the model again.
          await (await postChat(baseUrl, { model, messages: [], ...opts }, abort.signal)).text();
        }
        sendStatus("thinking");

        const conversation = messages.map(toOllama);
        await runToolLoop({
          tools,
          maxToolCalls,
          toolContext,
          reply,
          signal: abort.signal,
          isCancelled: () => cancelled,
          sendTool: (step) => send(JSON.stringify({ tool: step })),
          sendFiles: (files) => send(JSON.stringify({ files })),
          sendPause: (pause) => send(JSON.stringify({ pause })),
          sendError: (error) => send(JSON.stringify({ error })),
          // The tools stay offered in every round: models such as gpt-oss call
          // them anyway once the conversation has tool calls in it
          nextTurn: () => toolTurn(conversation),
          plainTurn: (note) => chatTurn(addToLastMessage(messages, note).map(toOllama), []),
          addCalls(turn, calls) {
            conversation.push({
              role: "assistant",
              content: turn.content,
              ...(turn.thinking ? { thinking: turn.thinking } : {}),
              tool_calls: turn.toolCalls.map((c, i) => ({ ...c, id: calls[i].id })),
            });
          },
          addResults(results) {
            for (const { call, result } of results) {
              conversation.push({
                role: "tool",
                tool_name: call.name,
                tool_call_id: call.id,
                content: result.text,
                ...(result.images.length ? { images: result.images.map((i) => i.data) } : {}),
              });
            }
          },
        });
        await reply.persist();
        if (!cancelled) controller.close();
      } catch (err) {
        await reply.persist();
        const message = err instanceof Error ? err.message : String(err);
        const hint = forAgent ? "Pick another base model for this agent on the agents page." : "Pick another model.";
        send(
          JSON.stringify({
            error: MODEL_NOT_FOUND.test(message)
              ? `${model} is no longer on your Ollama server. ${hint}`
              : `Ollama error: ${message}`,
          })
        );
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
