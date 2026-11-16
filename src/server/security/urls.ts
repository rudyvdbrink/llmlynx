// URLs as the security rules see them: the form in which two URLs are
// compared, the URLs in a text, and the signs that a URL carries data out of
// the conversation.

import { BASE64_MIN_CHANGES, ENCODED_MIN_LENGTH, MAX_ENTROPY_BITS, MAX_QUERY_LENGTH, SHARED_RUN_LENGTH } from "./limits";

/**
 * The URL in the form the rules compare: scheme and host in lower case, the
 * host in punycode, no default port, no fragment, and "/" for an empty path.
 * Null when it is not an http or https URL.
 */
export function normalizeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  return url.href;
}

/** The host of a URL, for the audit log and the dialogs; null when it is not a URL. */
export function hostOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    return new URL(raw.trim()).hostname || null;
  } catch {
    return null;
  }
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`\\^{}|]+/gi;
// What often follows a URL in a sentence or in markdown without being part of it
const TRAILING = /[.,;:!?)\]}>*_~]$/;

/**
 * The URLs that appear in `text`, normalized. A URL that ends in punctuation,
 * as in "(see https://example.com/a)." counts with and without it.
 */
export function extractUrls(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    let candidate = match[0];
    for (;;) {
      const url = normalizeUrl(candidate);
      if (url) found.push(url);
      if (!TRAILING.test(candidate)) break;
      candidate = candidate.slice(0, -1);
    }
  }
  return found;
}

/** Lower case, with everything but letters and digits removed: how texts are compared for shared runs. */
export function collapse(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** Bits per character of `text`, by how often each of its characters occurs. */
export function entropy(text: string): number {
  const counts = new Map<string, number>();
  let total = 0;
  for (const char of text) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
    total++;
  }
  let bits = 0;
  for (const count of counts.values()) bits -= (count / total) * Math.log2(count / total);
  return bits;
}

const kindOf = (char: string) => (/[a-z]/.test(char) ? "lower" : /[A-Z]/.test(char) ? "upper" : /[0-9]/.test(char) ? "digit" : null);

/**
 * True for base64 and base64url data. Their alphabet alone would also match a
 * long slug of words, such as a Wikipedia title. What sets encoded data apart
 * is that it goes between lower case, upper case and digits all the time,
 * where words stay in one of them.
 */
function isBase64(part: string): boolean {
  if (!/^[a-z0-9+/_-]+={0,2}$/i.test(part)) return false;
  let pairs = 0;
  let changes = 0;
  for (let i = 1; i < part.length; i++) {
    const [before, after] = [kindOf(part[i - 1]), kindOf(part[i])];
    if (!before || !after) continue;
    pairs++;
    if (before !== after) changes++;
  }
  return pairs > 0 && changes / pairs >= BASE64_MIN_CHANGES;
}

/** True for a path segment or query value that is long and is hex, base64 or random looking. */
function looksEncoded(part: string): boolean {
  if (part.length < ENCODED_MIN_LENGTH) return false;
  return /^[0-9a-f]+$/i.test(part) || isBase64(part) || entropy(part) > MAX_ENTROPY_BITS;
}

export type ExfilSignal = "long_query" | "encoded_value" | "shared_text";

/**
 * The first sign that the URL carries data out of the conversation, or null.
 * It looks at the URL-decoded URL: a long query string, a long path segment
 * or query value that is encoded data or random looking, or a run of letters
 * and digits in its path and query that also occurs in `sharedText`, the
 * user's messages and files in collapsed form (see `collapse`). The host does
 * not count for that run, or every page of a site the user named would match.
 */
export function exfilSignal(rawUrl: string, sharedText: () => string): ExfilSignal | null {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  const query = url.search.slice(1);
  if (decode(query).length > MAX_QUERY_LENGTH) return "long_query";

  const segments = url.pathname.split("/").map(decode);
  // Not URLSearchParams, which turns the + of base64 into a space
  const values = query ? query.split("&").map((pair) => decode(pair.slice(pair.indexOf("=") + 1))) : [];
  if ([...segments, ...values].some(looksEncoded)) return "encoded_value";

  const carried = collapse(decode(url.pathname + url.search));
  if (carried.length >= SHARED_RUN_LENGTH) {
    const shared = sharedText();
    for (let i = 0; shared && i + SHARED_RUN_LENGTH <= carried.length; i++) {
      if (shared.includes(carried.slice(i, i + SHARED_RUN_LENGTH))) return "shared_text";
    }
  }
  return null;
}
