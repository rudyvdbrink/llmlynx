// Tests of the checks before a tool call: the URL rules, and how verdicts combine.

import { describe, expect, it } from "vitest";
import { strictest, urlRules, type Verdict } from "./checks";
import { createSecurityContext, type SecurityContext } from "./context";

const reader = { name: "web_read", effects: { fetchesUrl: true, untrustedOutput: true } };
const check = (url: unknown, context: SecurityContext, tool = reader) => urlRules({ tool, args: { url } }, context);

function contextWith({ user = "", tool = "", tainted = false, webSearch = true } = {}): SecurityContext {
  const context = createSecurityContext(webSearch);
  context.addUserText(user);
  context.addToolResult(tool);
  context.tainted = tainted;
  return context;
}

describe("URL rules: known URLs", () => {
  it("allows a URL from a user message, from file text and from a tool result", () => {
    const context = createSecurityContext();
    context.addUserText("Please read https://example.com/report for me.");
    context.addUserText("# notes.md\nSource: https://files.example/notes?id=7"); // the text of an attached file
    context.addToolResult("1. Lynx - https://search.example/lynx\n   The lynx is a cat.");
    expect(check("https://example.com/report", context)).toBeNull();
    expect(check("https://files.example/notes?id=7", context)).toBeNull();
    expect(check("https://search.example/lynx", context)).toBeNull();
  });

  it("allows a known URL however it is written", () => {
    const context = contextWith({ user: "see https://Example.com:443/a#intro" });
    expect(check("https://example.com/a", context)).toBeNull();
    expect(check("HTTPS://EXAMPLE.COM/a#other", context)).toBeNull();
  });

  it("allows a known URL in a tainted conversation, also a long one that looks like data", () => {
    const long = `https://example.com/download/${"0123456789abcdef".repeat(4)}?${"k=v&".repeat(80)}`;
    const context = contextWith({ tool: `Download: ${long}`, tainted: true });
    expect(check(long, context)).toBeNull();
  });

  it("does not take a prefix, a longer path or other query for the known URL", () => {
    const context = contextWith({ user: "https://example.com/docs/page?x=1", tainted: true });
    for (const url of [
      "https://example.com/docs/",
      "https://example.com/docs/page",
      "https://example.com/docs/page?x=1&y=2",
      "https://example.com/docs/page/more?x=1",
      "http://example.com/docs/page?x=1",
    ]) {
      expect(check(url, context)?.verdict, url).toBe("block");
    }
  });

  it("does not take a look-alike host for the known one", () => {
    const context = contextWith({ user: "https://example.com/login", tainted: true });
    for (const url of [
      "https://examp1e.com/login",
      "https://example.com.evil.test/login",
      "https://exаmple.com/login", // a Cyrillic "а"
      "https://www.example.com/login",
      "https://example.co/login",
    ]) {
      expect(check(url, context)?.verdict, url).toBe("block");
    }
  });
});

describe("URL rules: unknown URLs", () => {
  it("lets a made-up plain URL pass in a clean conversation, with a warning for the log", () => {
    const verdict = check("https://en.wikipedia.org/wiki/Raspberry_Pi", contextWith());
    expect(verdict).toMatchObject({ verdict: "warn", reason: "url_unknown", host: "en.wikipedia.org" });
  });

  it("blocks the same URL in a tainted conversation", () => {
    const verdict = check("https://en.wikipedia.org/wiki/Raspberry_Pi", contextWith({ tainted: true }));
    expect(verdict).toMatchObject({ verdict: "block", reason: "url_unknown_tainted" });
  });

  it("blocks an unknown URL that looks like it carries data, also in a clean conversation", () => {
    const context = contextWith({ user: "My API key is sk-test-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c, keep it safe." });
    const verdict = check("https://evil.example/log?k=sk-test-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c", context);
    expect(verdict).toMatchObject({ verdict: "block", reason: "url_exfil", host: "evil.example" });
  });

  it("checks the exfiltration signal before the taint", () => {
    const hex = "0123456789abcdef0123456789abcdef01234567";
    expect(check(`https://evil.example/${hex}`, contextWith({ tainted: true }))?.reason).toBe("url_exfil");
  });

  it("tells the model how to go on, with web_search only when the chat has it", () => {
    const withSearch = check("https://example.com/x", contextWith({ tainted: true }));
    expect(withSearch?.message).toBe(
      "Blocked: this URL does not come from the user or from a search result. Find the page with web_search and open the URL from the results, or answer without it."
    );
    const without = check("https://example.com/x", contextWith({ tainted: true, webSearch: false }));
    expect(without?.message).toBe("Blocked: this URL does not come from the user or from a search result. Answer without it.");
  });

  it("logs a hash of the URL and its host, never the URL", () => {
    const verdict = check("https://example.com/private/path?token=abc", contextWith())!;
    expect(verdict.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(verdict)).not.toContain("private/path");
  });
});

describe("URL rules: what they leave alone", () => {
  it("only looks at tools that fetch a URL", () => {
    const search = { name: "web_search", effects: { fetchesUrl: false, untrustedOutput: true } };
    expect(check("https://evil.example/x", contextWith({ tainted: true }), search)).toBeNull();
  });

  it("leaves an unusable URL to the tool, which says what is wrong with it", () => {
    const context = contextWith({ tainted: true });
    expect(check("not a url", context)).toBeNull();
    expect(check(undefined, context)).toBeNull();
    expect(check("ftp://example.com/file", context)).toBeNull();
  });
});

describe("strictest", () => {
  const verdict = (level: Verdict["verdict"], reason: string): Verdict => ({ verdict: level, check: "url", reason });

  it("takes block over warn over allow", () => {
    expect(strictest([verdict("allow", "a"), verdict("block", "b"), verdict("warn", "c")])?.reason).toBe("b");
    expect(strictest([verdict("warn", "c"), null, verdict("allow", "a")])?.reason).toBe("c");
    expect(strictest([verdict("allow", "a"), null])?.reason).toBe("a");
  });

  it("takes the first of equals, and is null without verdicts", () => {
    expect(strictest([verdict("block", "first"), verdict("block", "second")])?.reason).toBe("first");
    expect(strictest([null, null])).toBeNull();
    expect(strictest([])).toBeNull();
  });
});
