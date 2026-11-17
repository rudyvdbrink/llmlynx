// Tests of what a request to OpenAI or OpenRouter costs, and how it adds to its conversation.

import { describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/db/prisma";
import { newConversation, newUser } from "@/test/db";
import { addConversationCost, createCostMeter, requestCost } from "./cost";

// gpt-5.4 as OpenRouter's catalog lists it
const GPT_54 = {
  prompt: "0.0000025",
  completion: "0.000015",
  input_cache_read: "0.00000025",
  overrides: [{ min_prompt_tokens: 272000, prompt: "0.000005", completion: "0.0000225", input_cache_read: "0.0000005" }],
};

describe("what a request costs", () => {
  it("is what OpenRouter charged, plus the provider's charge with the user's own key", () => {
    expect(requestCost("openrouter", { prompt_tokens: 10, completion_tokens: 5, cost: 0.0012 }, null)).toBe(0.0012);
    expect(requestCost("openrouter", { cost: 0.0001, is_byok: true, cost_details: { upstream_inference_cost: 0.002 } }, null)).toBeCloseTo(0.0021, 12);
    expect(requestCost("openrouter", { prompt_tokens: 10, completion_tokens: 5 }, null)).toBeNull();
  });

  it("is OpenAI's tokens at the catalog's prices, cached input at its own price", () => {
    // Chat Completions
    expect(
      requestCost("openai", { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } }, GPT_54)
    ).toBeCloseTo(600 * 0.0000025 + 400 * 0.00000025 + 200 * 0.000015, 12);
    // Responses
    expect(requestCost("openai", { input_tokens: 1000, output_tokens: 200 }, GPT_54)).toBeCloseTo(1000 * 0.0000025 + 200 * 0.000015, 12);
  });

  it("takes the prices for long prompts from the override they reach", () => {
    expect(requestCost("openai", { input_tokens: 300000, output_tokens: 1000 }, GPT_54)).toBeCloseTo(300000 * 0.000005 + 1000 * 0.0000225, 12);
  });

  it("is unknown for an OpenAI model without prices, or without usage", () => {
    expect(requestCost("openai", { input_tokens: 10, output_tokens: 5 }, null)).toBeNull();
    expect(requestCost("openai", null, GPT_54)).toBeNull();
  });
});

describe("the cost the client is told while a reply streams", () => {
  it("adds an estimate of the request under way to what was paid, until its usage replaces it", async () => {
    vi.useFakeTimers();
    try {
      const sent: number[] = [];
      const saved: number[] = [];
      const meter = createCostMeter({
        provider: "openai",
        prices: GPT_54,
        stored: 0.5,
        save: async (usd) => void saved.push(usd),
        send: (usd) => sent.push(usd),
      });
      // Its text ("user" included) as input, its images left out
      meter.startRequest({ messages: [{ role: "user", content: "x".repeat(4000) }, { image_url: { url: "data:image/png;base64,AAAA" } }] });
      expect(sent.at(-1)).toBeCloseTo(0.5 + (4004 / 4) * 0.0000025, 12);
      // Then at most every 250 ms
      meter.addOutput("y".repeat(400));
      expect(sent).toHaveLength(1);
      vi.advanceTimersByTime(300);
      meter.addOutput("y".repeat(400));
      expect(sent.at(-1)).toBeCloseTo(0.5 + (4004 / 4) * 0.0000025 + 200 * 0.000015, 12);
      await meter.endRequest({ input_tokens: 1000, output_tokens: 300 });
      expect(saved).toEqual([expect.closeTo(1000 * 0.0000025 + 300 * 0.000015, 12)]);
      expect(sent.at(-1)).toBeCloseTo(0.5 + saved[0], 12);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing for a model without prices until a request ends", async () => {
    const sent: number[] = [];
    const meter = createCostMeter({ provider: "openrouter", prices: null, stored: null, save: async () => {}, send: (usd) => sent.push(usd) });
    meter.startRequest({ messages: [{ role: "user", content: "hi" }] });
    meter.addOutput("hello");
    expect(sent).toEqual([]);
    await meter.endRequest({ cost: 0.002 });
    expect(sent).toEqual([0.002]);
  });
});

describe("a conversation's cost", () => {
  it("is null until a request costs something, then adds up", async () => {
    const conversationId = await newConversation(await newUser());
    const cost = async () => (await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).cost;
    expect(await cost()).toBeNull();
    await addConversationCost(conversationId, 0);
    expect(await cost()).toBe(0);
    await addConversationCost(conversationId, 0.004);
    await addConversationCost(conversationId, 0.0025);
    expect(await cost()).toBeCloseTo(0.0065, 12);
  });
});
