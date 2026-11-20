// Tests of what the agents page says about a context window that is small for an agent's tools.

import { describe, expect, it } from "vitest";
import { contextWindowHint } from "./agentTools";

describe("the hint about an agent's context window", () => {
  it("is none without tools, and none when the window is large enough for them", () => {
    expect(contextWindowHint([], 2048)).toBeNull();
    expect(contextWindowHint(["web_search", "web_read"], 8192)).toBeNull();
    expect(contextWindowHint(["run_code"], 16384)).toBeNull();
    expect(contextWindowHint(["read_file", "edit_file", "git"], 32768)).toBeNull();
  });

  it("asks for room for web pages below 8,192 tokens", () => {
    expect(contextWindowHint(["web_search"], 4096)).toMatch(/^Web pages need room: set the context window to 16384 tokens or more/);
    expect(contextWindowHint(["read_file", "create_file"], 8191)).toMatch(/^Web pages need room/);
  });

  it("asks for more room below 16,384 tokens when the agent works in the sandbox, in place of the other hint", () => {
    for (const tool of ["run_code", "edit_file", "git"] as const) {
      expect(contextWindowHint(["web_search", tool], 8192)).toMatch(/^Work in the sandbox needs room: set the context window to 32768 tokens or more/);
      expect(contextWindowHint([tool], 4096)).toMatch(/^Work in the sandbox needs room/);
    }
    // Downloading and reading files alone is not work in the sandbox
    expect(contextWindowHint(["web_fetch", "read_file"], 8192)).toBeNull();
  });
});
