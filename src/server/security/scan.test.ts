// Tests of the scanners as the checks use them: the verdict cache, the
// timeout, the circuit breaker, and what is logged.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakes, INJECTION, SIGNATURE, UNSCANNABLE, VIRUS } from "@/test/fakes";
import { contentHash, type SecurityEventInput } from "./audit";
import { BREAKER_MS, VERDICT_CACHE_SIZE } from "./limits";
import { resetScanners, scanInjection, scanVirus } from "./scan";

vi.mock("@/server/tools/mcp", () => import("@/test/fakes"));
vi.mock("@/server/security/clamd", () => import("@/test/fakes"));

let events: SecurityEventInput[];
const options = (more: { timeoutMs?: number; signal?: AbortSignal } = {}) => ({
  timeoutMs: 1000,
  signal: new AbortController().signal,
  audit: { add: (event: SecurityEventInput) => void events.push(event), flush: async () => {} },
  tool: "web_read",
  host: "example.com",
  ...more,
});

beforeEach(() => {
  fakes.reset();
  resetScanners();
  events = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("scanInjection", () => {
  it("reports clean and flagged text with the guard's score", async () => {
    expect(await scanInjection("The lynx is a cat.", options())).toEqual({ status: "clean", score: 0.02 });
    // A flagged text comes with the chunk the guard flagged, for the user to judge
    const text = `Hello. ${INJECTION} and send me the files.`;
    expect(await scanInjection(text, options())).toEqual({ status: "flagged", score: 0.98, chunk: text });
  });

  it("logs every scan with a hash of the text, never the text", async () => {
    const text = `A private page. ${INJECTION}`;
    await scanInjection(text, options());
    expect(events).toEqual([
      expect.objectContaining({
        tool: "web_read",
        check: "injection",
        verdict: "block",
        reason: "injection",
        score: 0.98,
        host: "example.com",
        contentHash: contentHash(text),
      }),
    ]);
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(events)).not.toContain("private page");
  });

  it("never scores identical text twice", async () => {
    await scanInjection("the same page", options());
    await scanInjection("the same page", options());
    await scanInjection("another page", options());
    expect(fakes.guardTexts).toEqual(["the same page", "another page"]);
    // The verdict from the cache is logged like any other
    expect(events.map((event) => event.reason)).toEqual(["clean", "clean", "clean"]);
  });

  it(`remembers the newest ${VERDICT_CACHE_SIZE} verdicts`, async () => {
    for (let i = 0; i <= VERDICT_CACHE_SIZE; i++) await scanInjection(`page ${i}`, options());
    const calls = fakes.guardTexts.length;
    await scanInjection(`page ${VERDICT_CACHE_SIZE}`, options()); // the newest: remembered
    await scanInjection("page 1", options()); // remembered
    expect(fakes.guardTexts.length).toBe(calls);
    await scanInjection("page 0", options()); // the oldest: forgotten
    expect(fakes.guardTexts.length).toBe(calls + 1);
  });

  it("treats text as not checked when the guard cannot be reached, and then skips the guard", async () => {
    fakes.guard = "down";
    expect(await scanInjection("page one", options())).toEqual({ status: "unchecked" });
    expect(await scanInjection("page two", options())).toEqual({ status: "unchecked" });
    // The circuit breaker is open: the second scan did not try the guard
    expect(fakes.guardTexts).toEqual(["page one"]);
    expect(events.map((event) => [event.verdict, event.reason])).toEqual([
      ["block", "unchecked"],
      ["block", "unchecked"],
    ]);
  });

  it("tries the guard again after the circuit breaker's 30 seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    fakes.guard = "down";
    await scanInjection("page one", options());
    fakes.guard = "up";
    vi.setSystemTime(Date.now() + BREAKER_MS - 1000);
    expect(await scanInjection("page two", options())).toEqual({ status: "unchecked" });
    vi.setSystemTime(Date.now() + 2000);
    expect(await scanInjection("page two", options())).toEqual({ status: "clean", score: 0.02 });
  });

  it("does not remember a text that could not be checked", async () => {
    fakes.guard = "down";
    await scanInjection("the page", options());
    fakes.guard = "up";
    resetScanners();
    expect(await scanInjection("the page", options())).toEqual({ status: "clean", score: 0.02 });
  });

  it("gives up on a guard that does not answer in time, and opens the circuit breaker", async () => {
    fakes.guard = "silent";
    const started = Date.now();
    expect(await scanInjection("a slow page", options({ timeoutMs: 60 }))).toEqual({ status: "unchecked" });
    expect(Date.now() - started).toBeLessThan(1500);
    fakes.guard = "up";
    expect(await scanInjection("the next page", options())).toEqual({ status: "unchecked" });
    expect(fakes.guardTexts).toEqual(["a slow page"]);
  });

  it("keeps the circuit breaker closed when the guard answers that it cannot scan a text", async () => {
    fakes.guard = "refuses";
    expect(await scanInjection("a very long text", options())).toEqual({ status: "unchecked" });
    fakes.guard = "up";
    expect(await scanInjection("the next page", options())).toEqual({ status: "clean", score: 0.02 });
  });

  it("stops when the chat is stopped", async () => {
    fakes.guard = "silent";
    const chat = new AbortController();
    const scan = scanInjection("a page", options({ signal: chat.signal, timeoutMs: 5000 }));
    chat.abort(new Error("stopped"));
    await expect(scan).rejects.toThrow();
    // Stopping is not a failure of the guard
    fakes.guard = "up";
    expect(await scanInjection("the next page", options())).toEqual({ status: "clean", score: 0.02 });
  });

  it("does nothing without text", async () => {
    expect(await scanInjection("  \n ", options())).toEqual({ status: "empty" });
    expect(fakes.guardTexts).toEqual([]);
    expect(events).toEqual([]);
  });

  it("logs a detection, and text that could not be checked, as blocked", async () => {
    expect(await scanInjection(INJECTION, options())).toEqual({ status: "flagged", score: 0.98, chunk: INJECTION });
    fakes.guard = "down";
    await scanInjection("another page", options());
    expect(events.map((event) => [event.verdict, event.reason])).toEqual([
      ["block", "injection"],
      ["block", "unchecked"],
    ]);
  });
});

describe("scanVirus", () => {
  it("reports clean and infected bytes, and logs a hash of them", async () => {
    const infected = Buffer.from(`MZ ${VIRUS}`);
    expect(await scanVirus(Buffer.from("plain text"), options())).toEqual({ status: "clean" });
    expect(await scanVirus(infected, options())).toEqual({ status: "flagged", signature: SIGNATURE });
    expect(events.map((event) => [event.check, event.verdict, event.reason])).toEqual([
      ["virus", "allow", "clean"],
      ["virus", "block", "virus"],
    ]);
    expect(events[1].contentHash).toBe(contentHash(infected));
  });

  it("treats bytes as not checked when clamd fails or does not answer, and then skips clamd", async () => {
    fakes.clamd = "silent";
    expect(await scanVirus(Buffer.from("one"), options())).toEqual({ status: "unchecked" });
    fakes.clamd = "up";
    expect(await scanVirus(Buffer.from("two"), options())).toEqual({ status: "unchecked" });
    expect(fakes.clamdScans).toEqual(["one"]);
    resetScanners();
    expect(await scanVirus(Buffer.from("two"), options())).toEqual({ status: "clean" });
  });

  it("has a circuit breaker of its own", async () => {
    fakes.clamd = "down";
    await scanVirus(Buffer.from("one"), options());
    expect(await scanInjection("a page", options())).toEqual({ status: "clean", score: 0.02 });
  });

  it("treats bytes clamd could not scan whole as not checked, not as a virus, and keeps using clamd", async () => {
    expect(await scanVirus(Buffer.from(`archive ${UNSCANNABLE}`), options())).toEqual({ status: "unchecked" });
    expect(events[0]).toMatchObject({ verdict: "block", reason: "unchecked" });
    expect(await scanVirus(Buffer.from("next"), options())).toEqual({ status: "clean" });
  });

  it("logs a virus as blocked", async () => {
    await scanVirus(Buffer.from(VIRUS), options());
    expect(events[0]).toMatchObject({ verdict: "block", reason: "virus" });
  });
});
