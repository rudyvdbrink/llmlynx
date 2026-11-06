// A chat on OpenAI's Responses API, which agents on reasoning models use: from
// GPT-5.4 on, Chat Completions refuses function tools unless reasoning is off,
// and some newer models cannot call tools there at all. Nothing is stored at
// OpenAI (store: false), so the model's output of each turn is sent back with the
// tool results, reasoning included.

import { toResponsesTools } from "@/server/tools/definitions";
import { isStreamingUnsupported, parseArguments, withoutRefusedParams, type ApiChat, type ApiChatContext } from "./openaiShared";
import { addToLastMessage, type ModelTurn } from "./toolLoop";

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

export function responsesChat(ctx: ApiChatContext): ApiChat<ResponsesTurn> {
  const { client, model, messages, tools, signal, writeContent, writeThinking, sendDone } = ctx;
  const instructions = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const toInput = (list: typeof messages): unknown[] =>
    list.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
  const input = toInput(messages);
  const accepted: Record<string, unknown> = { include: ["reasoning.encrypted_content"], ...ctx.params };

  type TurnRequest = { items: unknown[]; offered: typeof tools; toolChoice?: "none" };

  function request(stream: boolean, { items, offered, toolChoice }: TurnRequest) {
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
      finish(turn, response, response?.output?.length ? response.output : items);
      sendDone();
    } catch (err) {
      if (ctx.isCancelled() || !isStreamingUnsupported(err)) throw err;

      // Fallback: non-streaming request, return as a single message (no fake chunking)
      const response = (await request(false, req)) as unknown as ResponseBody;
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

  return {
    nextTurn: (mayCallTools) => runTurn({ items: input, offered: tools, ...(mayCallTools ? {} : { toolChoice: "none" }) }),
    plainTurn: (note) => runTurn({ items: toInput(addToLastMessage(messages, note)), offered: [] }),
    addCalls(turn) {
      input.push(...turn.output);
    },
    addResults(results) {
      for (const { call, result } of results) {
        const images = result.images.map((image) => ({
          type: "input_image",
          image_url: `data:${image.mimeType};base64,${image.data}`,
        }));
        input.push({
          type: "function_call_output",
          call_id: call.id,
          output: images.length ? [...(result.text ? [{ type: "input_text", text: result.text }] : []), ...images] : result.text,
        });
      }
    },
  };
}
