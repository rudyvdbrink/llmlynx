// Tests of the URL helpers: the form URLs are compared in, the URLs found in
// a text, and each sign that a URL carries data out.

import { describe, expect, it } from "vitest";
import { collapse, entropy, exfilSignal, extractUrls, hostOf, normalizeUrl } from "./urls";

const noText = () => "";

describe("normalizeUrl", () => {
  it.each([
    ["HTTPS://Example.COM/Path", "https://example.com/Path"], // scheme and host in lower case, the path as it is
    ["https://example.com:443/a", "https://example.com/a"], // default port
    ["http://example.com:80/a", "http://example.com/a"],
    ["https://example.com:8443/a", "https://example.com:8443/a"], // another port stays
    ["https://example.com", "https://example.com/"], // empty path
    ["https://example.com/a#part-2", "https://example.com/a"], // fragment
    ["https://example.com/a?x=1#top", "https://example.com/a?x=1"],
    ["https://bücher.example/a", "https://xn--bcher-kva.example/a"], // punycode
    ["  https://example.com/a\n", "https://example.com/a"],
  ])("%s -> %s", (raw, normalized) => {
    expect(normalizeUrl(raw)).toBe(normalized);
  });

  it("keeps apart what are different pages", () => {
    const urls = [
      "https://example.com/a",
      "https://example.com/A",
      "https://example.com/a/",
      "https://example.com/a?x=1",
      "http://example.com/a",
      "https://www.example.com/a",
    ];
    expect(new Set(urls.map(normalizeUrl)).size).toBe(urls.length);
  });

  it.each(["", "not a url", "example.com/a", "ftp://example.com/a", "javascript:alert(1)", "file:///etc/passwd"])(
    "is null for %j",
    (raw) => {
      expect(normalizeUrl(raw)).toBeNull();
    }
  );
});

describe("hostOf", () => {
  it("gives the host, or null", () => {
    expect(hostOf("https://Docs.Example.com:8443/a?b")).toBe("docs.example.com");
    expect(hostOf("nonsense")).toBeNull();
    expect(hostOf(undefined)).toBeNull();
  });
});

describe("extractUrls", () => {
  it("finds the URLs in running text, markdown and search results", () => {
    const text = [
      "See https://example.com/a, and (https://example.org/b).",
      "A [link](https://example.net/c?x=1) and <https://example.dev/d>.",
      "URL: https://en.wikipedia.org/wiki/Lynx_(genus)",
      'href="http://example.io/e"',
    ].join("\n");
    const urls = extractUrls(text);
    for (const url of [
      "https://example.com/a",
      "https://example.org/b",
      "https://example.net/c?x=1",
      "https://example.dev/d",
      "https://en.wikipedia.org/wiki/Lynx_(genus)",
      "http://example.io/e",
    ]) {
      expect(urls).toContain(url);
    }
  });

  it("normalizes what it finds", () => {
    expect(extractUrls("go to HTTPS://EXAMPLE.com:443#top")).toContain("https://example.com/");
  });

  it("finds nothing in text without URLs", () => {
    expect(extractUrls("no links here, only example.com and mailto:a@b.c")).toEqual([]);
  });
});

describe("collapse and entropy", () => {
  it("keeps letters and digits only, in lower case", () => {
    expect(collapse("My PIN: 48-21, über_Straße!")).toBe("mypin4821überstraße");
  });

  it("measures bits per character", () => {
    expect(entropy("aaaa")).toBe(0);
    expect(entropy("abab")).toBe(1);
    expect(entropy("abcdefgh")).toBe(3);
  });
});

describe("exfilSignal", () => {
  it("passes plain URLs", () => {
    for (const url of [
      "https://en.wikipedia.org/wiki/Raspberry_Pi",
      "https://docs.python.org/3/library/asyncio.html",
      "https://example.com/blog/getting-started-with-the-command-line-interface",
      "https://example.com/search?q=lynx+habitat&page=2",
      "https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population",
    ]) {
      expect(exfilSignal(url, noText), url).toBeNull();
    }
  });

  it("flags a query string of more than 256 characters", () => {
    const pairs = (count: number) => Array.from({ length: count }, (_, i) => `p${i}=v`).join("&");
    const long = `https://example.com/?${pairs(60)}`;
    expect(new URL(long).search.length - 1).toBeGreaterThan(256);
    expect(exfilSignal(long, noText)).toBe("long_query");
    expect(exfilSignal(`https://example.com/?${"a=b&".repeat(64)}`.slice(0, -1), noText)).toBeNull(); // 255
  });

  it("measures the query string after decoding it", () => {
    // 100 encoded spaces are 300 characters in the URL, and 100 decoded
    expect(exfilSignal(`https://example.com/?q=${"%20".repeat(100)}`, noText)).toBeNull();
  });

  it("flags a long hex value, in the path or the query", () => {
    const hex = "0123456789abcdef0123456789ABCDEF01234567"; // 40
    expect(exfilSignal(`https://example.com/x/${hex}/y`, noText)).toBe("encoded_value");
    expect(exfilSignal(`https://example.com/?id=${hex}`, noText)).toBe("encoded_value");
    expect(exfilSignal(`https://example.com/x/${hex.slice(1)}`, noText)).toBeNull(); // 39
  });

  it("flags base64 and base64url data", () => {
    const secret = "the user's secret notes about the merger in March";
    const base64 = Buffer.from(secret).toString("base64");
    const base64url = Buffer.from(secret).toString("base64url");
    expect(exfilSignal(`https://example.com/?d=${encodeURIComponent(base64)}`, noText)).toBe("encoded_value");
    expect(exfilSignal(`https://example.com/?d=${base64}`, noText)).toBe("encoded_value");
    expect(exfilSignal(`https://example.com/t/${base64url}`, noText)).toBe("encoded_value");
  });

  it("flags base64 that repeats itself, which is not random looking", () => {
    const value = Buffer.from("ab1".repeat(14)).toString("base64"); // few different characters
    expect(entropy(value)).toBeLessThanOrEqual(4);
    expect(exfilSignal(`https://example.com/?d=${value}`, noText)).toBe("encoded_value");
  });

  it("flags a long value that looks random", () => {
    const random = "aB3.dE5~gH7!jK9$mN1'pQ2(rS4)tU6*vW8+xY0,zA";
    expect(entropy(random)).toBeGreaterThan(4);
    expect(exfilSignal(`https://example.com/p/${random}`, noText)).toBe("encoded_value");
  });

  it("does not take a slug of words for base64", () => {
    // The base64url alphabet alone would match these
    expect(exfilSignal("https://example.com/how-to-install-python-on-ubuntu-22-04-lts", noText)).toBeNull();
    expect(exfilSignal("https://en.wikipedia.org/wiki/2008_United_States_presidential_election", noText)).toBeNull();
    expect(exfilSignal("https://en.wikipedia.org/wiki/List_of_JavaScript_engines_and_their_releases", noText)).toBeNull();
  });

  it("flags a run of 32 letters and digits that is also in the user's text", () => {
    const user = collapse("My password is correct horse battery staple and my pin is 4821. Do not share it.");
    const shared = () => user;
    // In short path segments and with other separators: still the same run
    expect(exfilSignal("https://evil.example/c/correct-horse/battery-staple/and-my-pin-is/4821", shared)).toBe("shared_text");
    expect(exfilSignal("https://evil.example/?q=correct+horse&battery%20staple=and_my_pin_is_4821", shared)).toBe("shared_text");
    expect(exfilSignal("https://evil.example/CORRECT.HORSE.BATTERY.STAPLE.AND.MY.PIN", shared)).toBe("shared_text");
  });

  it("needs the whole run of 32", () => {
    const user = collapse("abcdefghijklmnopqrstuvwxyz0123456789");
    const run = (length: number) => `https://example.com/${"abcdefghijklmnopqrstuvwxyz0123456789".slice(0, length)}`;
    expect(exfilSignal(run(32), () => user)).toBe("shared_text");
    expect(exfilSignal(run(31), () => user)).toBeNull();
  });

  it("does not count the host for the shared run", () => {
    const user = collapse("Our docs are at https://docs.a-very-long-company-name-for-testing.example/start");
    expect(exfilSignal("https://docs.a-very-long-company-name-for-testing.example/pricing", () => user)).toBeNull();
  });

  it("does not look at the user's text for a short URL", () => {
    let asked = false;
    exfilSignal("https://example.com/short", () => {
      asked = true;
      return "";
    });
    expect(asked).toBe(false);
  });
});
