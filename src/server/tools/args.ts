// Checks of the arguments models send to tools, and labels made from them.

const MAX_LABEL_LENGTH = 60;

export function shorten(text: string, max = MAX_LABEL_LENGTH): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Models sometimes send numbers as strings. Returns undefined when `raw` is absent. */
export function toInteger(raw: unknown): number | undefined | null {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "string" ? Number(raw.trim()) : raw;
  return typeof n === "number" && Number.isInteger(n) ? n : null;
}

export function checkStart(raw: unknown): { start: number } | { error: string } {
  const start = toInteger(raw);
  if (start === null || (start !== undefined && start < 0)) return { error: "start must be a whole number, 0 or more." };
  return { start: start ?? 0 };
}

/**
 * A list the model sent: a list; or as models also send one, JSON text of a
 * list (also without its closing "]"), or one object for a list of one.
 * undefined when it is absent, null when it is none of these.
 */
export function toList(raw: unknown): unknown[] | null | undefined {
  if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) return undefined;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    for (const candidate of [text, `${text}]`, `${text}}]`]) {
      try {
        const value: unknown = JSON.parse(candidate);
        if (Array.isArray(value)) return value;
        if (value && typeof value === "object") return [value];
      } catch {
        // the next candidate
      }
    }
    return null;
  }
  return typeof raw === "object" ? [raw] : null;
}

/** Why `raw` is not the list `name` must be, for the model: what it should send, and what it sent. */
export function listError(name: string, raw: unknown, example: string): string {
  const sent =
    typeof raw === "string" ? "text that is not a JSON list" : Array.isArray(raw) ? "an empty list" : raw === null ? "null" : `a ${typeof raw}`;
  return `${name} must be a list, such as ${example}; you sent ${sent}.`;
}

/** "https://www.example.com/a/b?c" -> "example.com/a/b", for labels. */
export function shortUrl(raw: unknown): string {
  if (typeof raw !== "string") return "a page";
  try {
    const url = new URL(raw);
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    return shorten(url.hostname.replace(/^www\./, "") + path, 48);
  } catch {
    return shorten(raw, 48);
  }
}

/** The URL to give a tool, or an error text. The MCP servers block private addresses themselves. */
export function checkUrl(raw: unknown): { url: string } | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { error: "url is required." };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { error: `Not a valid URL: ${raw}. Use a full URL that starts with https://.` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "Only http and https URLs can be opened." };
  if (url.username || url.password) return { error: "URLs with a user name or password cannot be opened." };
  return { url: url.href };
}

export const urlParameter = { type: "string", description: "The full URL, starting with https:// or http://" };
