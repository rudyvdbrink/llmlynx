// Tests of the security settings: where the scanners are, and what the server warns about when it starts.

import { afterEach, describe, expect, it, vi } from "vitest";
import { clamavServer, guardServer, setupWarnings } from "./config";

afterEach(() => vi.unstubAllEnvs());

describe("the security settings", () => {
  it("finds the scanners in the environment", () => {
    vi.stubEnv("GUARD_MCP_TOKEN", "secret");
    expect(guardServer()).toEqual({ id: "guard", url: "http://guard.test/mcp", token: "secret" });
    expect(clamavServer()).toEqual({ host: "clamd.test", port: 3310 });
    vi.stubEnv("CLAMAV_PORT", "3311");
    expect(clamavServer()).toEqual({ host: "clamd.test", port: 3311 });
  });

  it("looks for the scanners where docker-compose.yml publishes them when no address is set: they are never left out", () => {
    vi.stubEnv("GUARD_MCP_URL", "");
    vi.stubEnv("CLAMAV_HOST", "");
    expect(guardServer()).toEqual({ id: "guard", url: "http://127.0.0.1:8793/mcp", token: "test-token" });
    expect(clamavServer()).toEqual({ host: "127.0.0.1", port: 3310 });
  });

  it("warns when the guard has no token", () => {
    expect(setupWarnings()).toEqual([]);
    vi.stubEnv("GUARD_MCP_TOKEN", "");
    expect(setupWarnings()).toEqual(["GUARD_MCP_TOKEN is not set: the guard refuses the app, so content from the internet is withheld."]);
  });
});
