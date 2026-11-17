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
