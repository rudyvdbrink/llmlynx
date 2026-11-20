// A chat on OpenAI's Responses API, which agents on reasoning models use: from
// GPT-5.4 on, Chat Completions refuses function tools unless reasoning is off,
// and some newer models cannot call tools there at all. Nothing is stored at
// OpenAI (store: false), so the model's output of each turn is sent back with the
// tool results, reasoning included. The tool calls of earlier replies go back
// without their reasoning, which is not kept.

import { toResponsesTools } from "@/server/tools/definitions";
import type { ToolImage } from "@/server/tools/mcp";
import { isStreamingUnsupported, parseArguments, usageOf, withoutRefusedParams, type ApiChat, type ApiChatContext } from "./openaiShared";
import type { ModelTurn } from "./toolLoop";
import type { ViewMessage } from "./view";

type OutputItem = {
  type?: string;
  status?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type?: string; text?: string; refusal?: string }[];
  summary?: { text?: string }[];
};

type ResponseBody = {
  output?: OutputItem[];
  usage?: unknown;
  incomplete_details?: { reason?: string } | null;
  error?: { code?: string; message?: string } | null;
};

type StreamEvent = {
  type?: string;
  delta?: string;
  item?: OutputItem;
  item_id?: string;
  summary_index?: number;
  response?: ResponseBody;
  code?: string;
  message?: string;
  param?: string;
};

type ResponsesTurn = ModelTurn & { output: OutputItem[] };

// Between the parts of a reasoning summary
const SUMMARY_BREAK = "\n\n";

const imagePart = (image: ToolImage) => ({ type: "input_image", image_url: `data:${image.mimeType};base64,${image.data}` });

/** The system prompt of the view, which the Responses API takes as its instructions. */
const instructionsOf = (view: ViewMessage[]) =>
  view
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

/** The view as the input of a Responses request. */
function toInput(view: ViewMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of view) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const images = (m.images ?? []).map(imagePart);
      out.push({
        type: "function_call_output",
        call_id: m.callId,
        output: images.length ? [...(m.content ? [{ type: "input_text", text: m.content }] : []), ...images] : m.content,
      });
    } else if (m.role === "user" && m.images?.length) {
      // A message's images go in content parts after its text
      out.push({ role: "user", content: [{ type: "input_text", text: m.content }, ...m.images.map(imagePart)] });
    } else if (m.role === "assistant" && Array.isArray(m.extra)) {
      // A step of the reply that is running: the model's own output, reasoning included
      out.push(...m.extra);
    } else if (m.role === "assistant" && m.calls?.length) {
      if (m.content) out.push({ role: "assistant", content: m.content });
      for (const call of m.calls) {
        out.push({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
      }
    } else out.push({ role: m.role, content: m.content });
  }
  return out;
}

export function responsesChat(ctx: ApiChatContext): ApiChat<ResponsesTurn> {
  const { client, model, tools, signal, writeContent, writeThinking, sendDone, cost } = ctx;
  const accepted: Record<string, unknown> = { include: ["reasoning.encrypted_content"], ...ctx.params };

  type TurnRequest = { instructions: string; items: unknown[]; offered: typeof tools; toolChoice?: "none" };

  function request(stream: boolean, { instructions, items, offered, toolChoice }: TurnRequest) {
    cost.startRequest({ instructions, items, tools: toResponsesTools(offered) });
    return withoutRefusedParams(accepted, () =>
      client.responses.create(
        {
          model,
          input: items,
          store: false,
          ...(instructions ? { instructions } : {}),
          ...(offered.length ? { tools: toResponsesTools(offered), ...(toolChoice ? { tool_choice: toolChoice } : {}) } : {}),
          ...(stream ? { stream: true } : {}),
          ...accepted,
        } as never,
        { signal }
      )
    );
  }

  /** Fills in `turn` from the model's finished output. */
  function finish(turn: ResponsesTurn, response: ResponseBody | null, output: OutputItem[]) {
    turn.output = output;
    turn.extra = output;
    turn.usage = usageOf(response?.usage);
    // A call the model did not finish writing cannot be run
    turn.calls = output
      .filter((item) => item.type === "function_call" && item.status !== "incomplete")
      .map((item) => ({ id: item.call_id, name: item.name ?? "", arguments: parseArguments(item.arguments ?? "") }));
    const reason = response?.incomplete_details?.reason;
    if (reason && !turn.content.trim() && turn.calls.length === 0) {
      throw new Error(
        reason === "max_output_tokens"
          ? "The model used up its max output tokens before it answered. Raise Max output tokens in the agent's options."
          : `The model stopped before it answered (${reason}).`
      );
    }
  }

  /** Runs one request, streaming it to the client. Returns what the model wrote and called. */
  async function runTurn(req: TurnRequest): Promise<ResponsesTurn> {
    const turn: ResponsesTurn = { content: "", calls: [], output: [] };
    const addContent = (text: string) => {
      turn.content += text;
      writeContent(text);
    };
    try {
      // First attempt: true streaming
      const events = (await request(true, req)) as unknown as AsyncIterable<StreamEvent>;
      const items: OutputItem[] = [];
      let response: ResponseBody | null = null;
      let summaryPart: string | null = null;
      for await (const event of events) {
        switch (event.type) {
          case "response.output_text.delta":
          case "response.refusal.delta":
            addContent(event.delta ?? "");
            break;
          case "response.reasoning_summary_text.delta": {
            const part = `${event.item_id}:${event.summary_index}`;
            if (summaryPart !== null && part !== summaryPart) writeThinking(SUMMARY_BREAK);
            summaryPart = part;
            writeThinking(event.delta ?? "");
            break;
          }
          // Models that give their reasoning itself, not a summary of it
          case "response.reasoning_text.delta":
            writeThinking(event.delta ?? "");
            break;
          case "response.function_call_arguments.delta":
            cost.addOutput(event.delta ?? "");
            break;
          case "response.output_item.done":
            if (event.item) items.push(event.item);
            break;
          case "response.completed":
          case "response.incomplete":
            response = event.response ?? null;
            break;
          case "response.failed":
            throw event.response?.error ?? new Error("The model could not answer.");
          case "error":
            throw event;
        }
      }
      await cost.endRequest(response?.usage);
      finish(turn, response, response?.output?.length ? response.output : items);
      sendDone();
    } catch (err) {
      if (ctx.isCancelled() || !isStreamingUnsupported(err)) throw err;

      // Fallback: non-streaming request, return as a single message (no fake chunking)
      const response = (await request(false, req)) as unknown as ResponseBody;
      await cost.endRequest(response.usage);
      const output = response.output ?? [];
      const parts = output.flatMap((item) => item.summary?.map((s) => s.text ?? "") ?? []);
      if (parts.length) writeThinking(parts.join(SUMMARY_BREAK));
      for (const item of output) {
        if (item.type !== "message") continue;
        for (const part of item.content ?? []) addContent(part.text ?? part.refusal ?? "");
      }
      finish(turn, response, output);
      sendDone();
    }
    return turn;
  }

  const turnRequest = (view: ViewMessage[]) => ({ instructions: instructionsOf(view), items: toInput(view) });

  return {
    turn: (view, mayCallTools) => runTurn({ ...turnRequest(view), offered: tools, ...(mayCallTools ? {} : { toolChoice: "none" }) }),
    plainTurn: (view) => runTurn({ ...turnRequest(view), offered: [] }),
    async ask(view) {
      const response = (await request(false, { ...turnRequest(view), offered: [] })) as unknown as ResponseBody;
      await cost.endRequest(response.usage);
      return (response.output ?? [])
        .filter((item) => item.type === "message")
        .flatMap((item) => (item.content ?? []).map((part) => part.text ?? ""))
        .join("");
    },
  };
}
