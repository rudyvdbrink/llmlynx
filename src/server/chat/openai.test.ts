// Tests of what a chat on OpenAI or OpenRouter sends: the conversation with
// the tool calls of earlier replies as they happened, the request to cache
// the prompt, and text notes for a model that refuses those calls. The OpenAI
// client is a stand-in that keeps the requests and answers with a short reply.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getToolDefinition } from "@/server/tools/definitions";
import type { AssistantReply } from "./conversation";
import { streamOpenAIChat, type ApiChatRequest } from "./openai";
import type { ViewMessage } from "./view";

type Body = Record<string, unknown> & { messages?: unknown[]; input?: unknown[] };

const sent = vi.hoisted(() => ({ requests: [] as Record<string, unknown>[], refusals: [] as unknown[] }));

vi.mock("openai", () => {
  async function* completion() {
    yield { choices: [{ delta: { content: "The answer." } }] };
    yield { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 100 } };
  }
  async function* response() {
    yield { type: "response.output_text.delta", delta: "The answer." };
    yield {
      type: "response.completed",
      response: { output: [{ type: "message", content: [{ type: "output_text", text: "The answer." }] }], usage: { input_tokens: 900, output_tokens: 100 } },
    };
  }
  const create = (stream: () => AsyncGenerator) => async (body: Record<string, unknown>) => {
    sent.requests.push(body);
    const refusal = sent.refusals.shift();
    if (refusal) throw refusal;
    return stream();
  };
  return {
    default: class {
      chat = { completions: { create: create(completion) } };
      responses = { create: create(response) };
    },
  };
});

const reply = {
  append: () => {},
  appendReasoning: () => {},
  noteUsage: () => {},
  readCost: async () => null,
  saveCost: async () => {},
  persist: async () => {},
} as unknown as AssistantReply;

const tools = [getToolDefinition("web_search")!];

/** A conversation in which an earlier reply searched the web. */
const history = (): ViewMessage[] => [
  { role: "system", content: "You are the llynx." },
  { role: "user", content: "Search for x" },
  { role: "assistant", content: "", calls: [{ id: "c1", name: "web_search", arguments: { query: "x" } }] },
  { role: "tool", callId: "c1", name: "web_search", content: "Results for x." },
  { role: "assistant", content: "I found x." },
  { role: "user", content: "And y?" },
];

async function chat(request: Partial<ApiChatRequest> = {}) {
  const stream = streamOpenAIChat({ provider: "openai", model: "gpt-test", view: history(), tools, ...request }, { apiKey: "test" }, reply);
  const lines = (await new Response(stream).text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { lines, requests: sent.requests as Body[] };
}

beforeEach(() => {
  sent.requests.length = 0;
  sent.refusals.length = 0;
  // The price list is not needed: without it, nothing is estimated
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 503 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a chat on Chat Completions", () => {
  it("sends the tool calls of earlier replies and their results, as they happened", async () => {
    const { lines, requests } = await chat();
    expect(lines.some((line) => line.error)).toBe(false);
    expect(requests[0].messages).toEqual([
      { role: "system", content: "You are the llynx." },
      { role: "user", content: "Search for x" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "web_search", arguments: '{"query":"x"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "Results for x." },
      { role: "assistant", content: "I found x." },
      { role: "user", content: "And y?" },
    ]);
  });

  it("puts the images of a round's results in one user message after them", async () => {
    const image = { mimeType: "image/jpeg", data: "aaaa" };
    const view: ViewMessage[] = [
      { role: "user", content: "Look at two pages" },
      {
        role: "assistant",
        content: "",
        calls: [
          { id: "s1", name: "web_screenshot", arguments: {} },
          { id: "s2", name: "web_screenshot", arguments: {} },
        ],
      },
      { role: "tool", callId: "s1", name: "web_screenshot", content: "", images: [image] },
      { role: "tool", callId: "s2", name: "web_screenshot", content: "", images: [image] },
    ];
    const { requests } = await chat({ view });
    const messages = requests[0].messages as { role: string; content: unknown }[];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "user"]);
    expect(messages[2].content).toBe("The result is the image in the next message.");
    expect((messages[4].content as unknown[]).filter((part) => (part as { type: string }).type === "image_url")).toHaveLength(2);
  });

  it("tells the chat view how full the window is, by what the request took", async () => {
    const { lines } = await chat({ context: { conversationId: "none", tools, security: null, window: 100_000 } });
    expect(lines.filter((line) => line.context)).toEqual([{ context: { used: 1_000, full: 70_000 } }]);
  });

  it("asks OpenRouter to cache the prompt for a model that only caches on request", async () => {
    const claude = await chat({ provider: "openrouter", model: "anthropic/claude-test" });
    expect(claude.requests[0].cache_control).toEqual({ type: "ephemeral" });
    sent.requests.length = 0;
    const other = await chat({ provider: "openrouter", model: "openai/gpt-test" });
    expect(other.requests[0].cache_control).toBeUndefined();
  });

  it("gives a model that refuses the tool calls of earlier replies those replies as text, on the same request and from then on", async () => {
    sent.refusals.push({ status: 400, message: "Invalid request: unexpected tool_calls" });
    const first = await chat({ provider: "openrouter", model: "strict/model" });
    expect(first.lines.some((line) => line.error)).toBe(false);
    expect(first.requests).toHaveLength(2);
    expect(first.requests[1].messages).toEqual([
      { role: "system", content: "You are the llynx." },
      { role: "user", content: "Search for x" },
      {
        role: "assistant",
        content: '[Earlier tool use: web_search {"query":"x"}. Its result follows.]\nResults for x.\n[End of the result of web_search.]\n\nI found x.',
      },
      { role: "user", content: "And y?" },
    ]);

    sent.requests.length = 0;
    const later = await chat({ provider: "openrouter", model: "strict/model" });
    expect(later.requests).toHaveLength(1);
    expect(JSON.stringify(later.requests[0].messages)).not.toContain("tool_calls");
    // Another model is not affected
    sent.requests.length = 0;
    expect(JSON.stringify((await chat({ provider: "openrouter", model: "other/model" })).requests[0].messages)).toContain("tool_calls");
  });

  it("ends with the error when a request is refused that has no earlier tool calls in it", async () => {
    sent.refusals.push({ status: 400, message: "Bad request" });
    const { lines, requests } = await chat({ view: [{ role: "user", content: "Hello" }] });
    expect(requests).toHaveLength(1);
    expect(lines.at(-1)).toEqual({ error: "Bad request" });
  });
});

describe("a chat on the Responses API", () => {
  it("sends the tool calls of earlier replies as function calls with their outputs, and the system prompt as instructions", async () => {
    const { lines, requests } = await chat({ useResponses: true });
    expect(lines.some((line) => line.error)).toBe(false);
    expect(requests[0].instructions).toBe("You are the llynx.");
    expect(requests[0].input).toEqual([
      { role: "user", content: "Search for x" },
      { type: "function_call", call_id: "c1", name: "web_search", arguments: '{"query":"x"}' },
      { type: "function_call_output", call_id: "c1", output: "Results for x." },
      { role: "assistant", content: "I found x." },
      { role: "user", content: "And y?" },
    ]);
  });
});
