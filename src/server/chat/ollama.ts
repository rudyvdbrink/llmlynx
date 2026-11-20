import { DEFAULT_MAX_TOOL_CALLS } from "@/lib/agentTools";
import { createLineSplitter } from "@/lib/ndjson";
import { withOllamaTag } from "@/lib/providers";
import type { ChatMessage, ReplyStatus } from "@/lib/types";
import { toFunctionTools, type ToolDefinition } from "@/server/tools/definitions";
import type { Usage } from "./budget";
import { openContext, type ContextConfig, type ContextLine } from "./context";
import type { AssistantReply } from "./conversation";
import { addToLastMessage, runToolLoop, type ChatToolContext, type ModelTurn } from "./toolLoop";
import type { ViewMessage } from "./view";

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
  // The conversation as the model gets it, its system prompt included (see view.ts); the reply's steps are added to it
  view: ViewMessage[];
  // What keeps the view within the model's context window. Its window is the agent's; without one
  // (a plain chat), it is the window Ollama loaded the model with
  context?: ContextConfig | null;
  options?: unknown; // agent generation settings, passed through as Ollama options
  // The tools the model can call; with none, the chat is a single request
  tools?: ToolDefinition[];
  // Most tool calls per reply (0: no limit), see runToolLoop
  maxToolCalls?: number;
  toolContext?: ChatToolContext;
  // Set when the user chats with an agent, for the error when its model is gone
  forAgent?: boolean;
};

/** The view as the messages of a request to Ollama: images go in their own field. */
function toOllama(view: ViewMessage[]): OllamaMessage[] {
  return view.map((m): OllamaMessage => {
    if (m.role === "tool") {
      return {
        role: "tool",
        tool_name: m.name,
        tool_call_id: m.callId,
        content: m.content,
        ...(m.images?.length ? { images: m.images.map((i) => i.data) } : {}),
      };
    }
    if (m.role === "assistant" && m.calls?.length) {
      // The reasoning of a step of the reply that is running goes back with it
      const thinking = (m.extra as { thinking?: string } | undefined)?.thinking;
      return {
        role: "assistant",
        content: m.content,
        ...(thinking ? { thinking } : {}),
        tool_calls: m.calls.map((c) => ({ id: c.id, function: { name: c.name, arguments: c.arguments } })),
      };
    }
    return { role: m.role, content: m.content, ...(m.role === "user" && m.images?.length ? { images: m.images.map((i) => i.data) } : {}) };
  });
}

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
 * Whether Ollama has `model` in memory, ready for a chat with `options`, and
 * the context window it loaded it with, when it says. A model that is still
 * loading is not listed yet, and one loaded with another num_ctx is loaded
 * again for the chat.
 */
async function loadedModel(baseUrl: string, model: string, options: unknown, signal: AbortSignal): Promise<{ loaded: boolean; window?: number }> {
  const res = await fetch(`${baseUrl}/api/ps`, { cache: "no-store", signal });
  if (!res.ok) return { loaded: true }; // cannot tell; the chat loads it if needed
  const raw = (await res.json().catch(() => ({}))) as { models?: unknown };
  const running: OllamaRunning[] = Array.isArray(raw.models) ? raw.models : [];
  const numCtx = (options as { num_ctx?: unknown } | undefined)?.num_ctx;
  const found = running.find(
    (m) =>
      withOllamaTag(m?.name || m?.model || "") === withOllamaTag(model) &&
      (typeof numCtx !== "number" || m.context_length === undefined || m.context_length === numCtx)
  );
  const window = found?.context_length;
  return { loaded: !!found, ...(typeof window === "number" && window > 0 ? { window } : {}) };
}

/**
 * The context window Ollama has `model` loaded with, in tokens; null when it
 * is not loaded, when Ollama does not say (an older server), or when Ollama
 * cannot be reached. A plain chat runs in this window: it sets none itself.
 */
export async function loadedWindow(baseUrl: string, model: string): Promise<number | null> {
  try {
    return (await loadedModel(baseUrl, model, undefined, AbortSignal.timeout(5_000))).window ?? null;
  } catch {
    return null;
  }
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
 * One request to a model on Ollama without tools, not streamed: the text it
 * wrote. `options` are those of the chat, so that Ollama does not load the
 * model again for it.
 */
export async function askOllama(
  { baseUrl, model, options }: Pick<OllamaChatRequest, "baseUrl" | "model" | "options">,
  view: ViewMessage[],
  signal: AbortSignal
): Promise<string> {
  const res = await postChat(baseUrl, { model, messages: toOllama(view), stream: false, ...(options ? { options } : {}) }, signal);
  const body = (await res.json().catch(() => ({}))) as { message?: { content?: unknown }; error?: unknown };
  if (typeof body.error === "string" && body.error) throw new Error(body.error);
  return typeof body.message?.content === "string" ? body.message.content : "";
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
 * With a context, { context } lines say how full the model's window is after
 * each request, and a { checkpoint } line says that older steps were
 * summarised (see context.ts).
 *
 * If Ollama cannot be reached, rejects the request or reports an error in its
 * stream, the stream ends with an { error } line. A request that failed on a tool
 * call the model wrote wrong is made once more first, with a note for the model.
 */
export function streamOllamaChat(
  { baseUrl, model, view, context: contextConfig = null, options, tools = [], maxToolCalls = DEFAULT_MAX_TOOL_CALLS, toolContext, forAgent }: OllamaChatRequest,
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
        const turn = {
          content: "",
          thinking: "",
          toolCalls: [] as OllamaToolCall[],
          calls: [] as ModelTurn["calls"],
          usage: undefined as Usage | undefined,
          extra: undefined as { thinking: string } | undefined,
        };
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
            // The last line says how many tokens the request took
            if (obj?.done === true && typeof obj.prompt_eval_count === "number" && obj.prompt_eval_count > 0) {
              turn.usage = { input: obj.prompt_eval_count, output: typeof obj.eval_count === "number" ? obj.eval_count : 0 };
            }
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
        if (turn.thinking) turn.extra = { thinking: turn.thinking };
        return turn;
      }

      /** One request without tools whose answer the client does not get: the text the model wrote. */
      const ask = (messages: ViewMessage[]) => askOllama({ baseUrl, model, options }, messages, abort.signal);

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
        let running = await loadedModel(baseUrl, model, options, abort.signal);
        if (!running.loaded) {
          sendStatus("loading");
          // A chat without messages only loads the model. It gets the chat's
          // options, or the chat would load the model again.
          await (await postChat(baseUrl, { model, messages: [], ...opts }, abort.signal)).text();
          // A plain chat runs in the window Ollama chose for the model: it says which once the model is loaded
          if (contextConfig && !contextConfig.window) running = await loadedModel(baseUrl, model, options, abort.signal);
        }
        sendStatus("thinking");

        const window = contextConfig?.window ?? running.window;
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
          view,
          context:
            contextConfig && window
              ? openContext({
                  config: contextConfig,
                  window,
                  reply,
                  signal: abort.signal,
                  ask,
                  send: (line: ContextLine) => send(JSON.stringify(line)),
                })
              : null,
          // The tools stay offered in every round: models such as gpt-oss call
          // them anyway once the conversation has tool calls in it
          nextTurn: (all) => toolTurn(toOllama(all)),
          plainTurn: (all) => chatTurn(toOllama(all), []),
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
