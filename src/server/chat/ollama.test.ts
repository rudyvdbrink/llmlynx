// Tests of the Ollama chat stream against a stand-in for Ollama's HTTP API.

import { afterEach, describe, expect, it, vi } from "vitest";
import { getToolDefinition } from "@/server/tools/definitions";
import type { AssistantReply } from "./conversation";
import { streamOllamaChat, type OllamaChatRequest, type OllamaMessage } from "./ollama";
import type { ViewMessage } from "./view";

/** A reply that keeps nothing: these tests read the stream only. */
const reply = {
  append: () => {},
  appendReasoning: () => {},
  noteUsage: () => {},
  persist: async () => {},
  saveToolCalls: async () => {
    throw new Error("no tool call may be stored");
  },
} as unknown as AssistantReply;

const UNREADABLE = "XML syntax error on line 4: element <parameter> closed by </function>";
const thinking = { message: { role: "assistant", content: "", thinking: "Let me look." } };
const answer = { message: { role: "assistant", content: "The answer." }, done: true };
const call = { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "web_search", arguments: { query: "x" } } }] } };

type Answer = object[] | { status: number; body: object };

/**
 * Runs a chat with the web_search tool on a stand-in Ollama that gives `answers`
 * in turn: the lines of a stream, or a refusal. Returns the lines the client got
 * and the messages of each chat request.
 */
async function chat(...answers: Answer[]) {
  const requests: OllamaMessage[][] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/ps")) return Response.json({ models: [{ name: "test:latest" }] });
    requests.push(JSON.parse(String(init?.body)).messages);
    const next = answers[requests.length - 1] ?? [answer];
    if (!Array.isArray(next)) return Response.json(next.body, { status: next.status });
    return new Response(next.map((line) => JSON.stringify(line) + "\n").join(""));
  });
  const stream = streamOllamaChat(
    {
      baseUrl: "http://ollama.test",
      model: "test",
      view: [{ role: "user", content: "Search for x" }],
      tools: [getToolDefinition("web_search")!],
    },
    reply
  );
  const text = await new Response(stream).text();
  const lines = text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { lines, requests };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a tool call Ollama cannot read", () => {
  it("is asked for once more, with a note, and the reply goes on", async () => {
    const { lines, requests } = await chat([thinking, { error: UNREADABLE }], [thinking, answer]);

    expect(requests).toHaveLength(2);
    expect(requests[0].at(-1)?.content).toBe("Search for x");
    expect(requests[1].at(-1)?.content).toMatch(/^Search for x\n\n\[Your last reply had a tool call that could not be read/);
    expect(lines.some((line) => line.error)).toBe(false);
    // The reasoning of the second try starts a paragraph of its own
    expect(lines.filter((line) => line.message?.thinking).map((line) => line.message.thinking)).toEqual(["Let me look.", "\n\n", "Let me look."]);
  });

  it("is asked for once more also when Ollama refuses the request outright", async () => {
    const { lines, requests } = await chat({ status: 500, body: { error: UNREADABLE } }, [answer]);

    expect(requests).toHaveLength(2);
    expect(lines.some((line) => line.error)).toBe(false);
  });

  it("ends the reply with the error when the second try fails too, and runs no tool call made before it", async () => {
    const { lines, requests } = await chat([call, { error: UNREADABLE }], [call, { error: UNREADABLE }]);

    expect(requests).toHaveLength(2);
    expect(lines.some((line) => line.tool)).toBe(false);
    expect(lines.filter((line) => line.error)).toEqual([{ error: `Ollama error: ${UNREADABLE}` }]);
  });
});

describe("another error in Ollama's stream", () => {
  it("ends the reply at once", async () => {
    const { lines, requests } = await chat([thinking, { error: "model runner has unexpectedly stopped" }]);

    expect(requests).toHaveLength(1);
    expect(lines.at(-1)).toEqual({ error: "Ollama error: model runner has unexpectedly stopped" });
  });
});

/** Runs a chat on a stand-in Ollama that answers at once. Returns the lines the client got, and what Ollama was sent. */
async function plainChat(request: Partial<OllamaChatRequest> & { view: ViewMessage[] }, running: object[] = [{ name: "test:latest" }]) {
  const requests: { messages: OllamaMessage[]; options?: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/ps")) return Response.json({ models: running });
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ...answer, prompt_eval_count: 1000, eval_count: 200 }) + "\n");
  });
  const stream = streamOllamaChat({ baseUrl: "http://ollama.test", model: "test", ...request }, reply);
  const lines = (await new Response(stream).text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { lines, requests };
}

describe("the conversation Ollama gets", () => {
  it("has the tool calls of earlier replies and their results, as they happened", async () => {
    const view: ViewMessage[] = [
      { role: "system", content: "You are the llynx." },
      { role: "user", content: "Search for x" },
      { role: "assistant", content: "Let me search.", calls: [{ id: "c1", name: "web_search", arguments: { query: "x" } }] },
      { role: "tool", callId: "c1", name: "web_search", content: "Results for x." },
      { role: "assistant", content: "I found x." },
      { role: "user", content: "And y?" },
    ];
    const { requests } = await plainChat({ view, tools: [getToolDefinition("web_search")!] });
    expect(requests[0].messages).toEqual([
      { role: "system", content: "You are the llynx." },
      { role: "user", content: "Search for x" },
      { role: "assistant", content: "Let me search.", tool_calls: [{ id: "c1", function: { name: "web_search", arguments: { query: "x" } } }] },
      { role: "tool", tool_name: "web_search", tool_call_id: "c1", content: "Results for x." },
      { role: "assistant", content: "I found x." },
      { role: "user", content: "And y?" },
    ]);
  });
});

describe("how full the context window is", () => {
  const view: ViewMessage[] = [{ role: "user", content: "Hello" }];
  const config = { conversationId: "none", tools: [], security: null };

  it("is told after each request, by what Ollama says the request took, in the agent's window", async () => {
    const { lines } = await plainChat({ view: [...view], context: { ...config, window: 8_000 } });
    expect(lines.filter((line) => line.context)).toEqual([{ context: { used: 1_200, full: 5_600 } }]);
  });

  it("goes by the window Ollama loaded the model with in a plain chat", async () => {
    const { lines } = await plainChat({ view: [...view], context: { ...config, window: null } }, [{ name: "test:latest", context_length: 4_096 }]);
    expect(lines.filter((line) => line.context)).toEqual([{ context: { used: 1_200, full: 2_867 } }]);
  });

  it("is not told when the window is not known: an older Ollama does not say it", async () => {
    const { lines } = await plainChat({ view: [...view], context: { ...config, window: null } });
    expect(lines.some((line) => line.context)).toBe(false);
    expect(lines.some((line) => line.error)).toBe(false);
  });
});
