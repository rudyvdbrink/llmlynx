import { describe, expect, it } from "vitest";
import { ollamaOptions } from "./agentSettings";

describe("ollamaOptions", () => {
  it("leaves out options Ollama no longer takes, such as mirostat stored with older agents", () => {
    const stored = { mirostat: 0, mirostat_eta: 0.1, mirostat_tau: 5, num_ctx: 8192, temperature: 0.7 };
    expect(ollamaOptions(stored)).toEqual({ num_ctx: 8192, temperature: 0.7 });
  });
});
