// What the guard scans of a file's text: only what can carry instructions to
// the model. Of JSON: its strings, keys included, without the numbers, true,
// false, null and the brackets and commas between them. Of HTML and XML: the
// text, attribute values, comments and scripts, the names of tags and
// attributes once, and of styles only their comments and strings. Each
// distinct piece is scanned once, in the order it first comes, one per line,
// so an injection split over pieces next to each other still reads as one.
// The readers also take a part of a file, cut anywhere: what they cannot
// place they keep, as text.

import { extensionOf } from "@/lib/files";

export type TextFormat = "json" | "markup" | "text";

const JSON_EXTENSIONS = ["json", "jsonl", "ndjson", "geojson"];
const MARKUP_EXTENSIONS = ["html", "htm", "xhtml", "xml", "svg", "rss", "atom"];

// A piece without a letter cannot instruct anything
const LETTER = /\p{L}/u;
const JSON_LITERAL = /^(?:-?\d[\d.eE+-]*|true|false|null)$/;
const JSON_STRUCTURE = new Set(["{", "}", "[", "]", ",", ":"]);
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** True when `text` is one JSON value, or one per line (JSON Lines). */
function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {}
  const lines = text.split("\n").filter((line) => line.trim());
  if (lines.length < 2) return false;
  try {
    for (const line of lines) JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

/**
 * The format of a file's text, by its name, and by `text` when it is the
 * whole text: then JSON only when it parses as JSON, also without a .json name.
 */
export function formatOf(name: string, text?: string): TextFormat {
  const ext = extensionOf(name);
  if (text === undefined) return JSON_EXTENSIONS.includes(ext) ? "json" : MARKUP_EXTENSIONS.includes(ext) ? "markup" : "text";
  const start = text.trimStart();
  if ((JSON_EXTENSIONS.includes(ext) || /^[[{]/.test(start)) && parsesAsJson(text)) return "json";
  if (MARKUP_EXTENSIONS.includes(ext) || /^<(?:!doctype|html|\?xml|svg|rss|feed)\b/i.test(start)) return "markup";
  return "text";
}

/** The pieces of `text` (or a part of it) read as JSON: its strings, and what is not JSON. */
function jsonPieces(text: string): string[] {
  const pieces: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      const token = text.slice(i, end + 1);
      try {
        pieces.push(JSON.parse(token) as string);
      } catch {
        pieces.push(token.slice(1)); // cut off before its end
      }
      i = end + 1;
    } else if (JSON_STRUCTURE.has(c) || /\s/.test(c)) {
      i++;
    } else {
      let end = i;
      while (end < text.length && text[end] !== '"' && !JSON_STRUCTURE.has(text[end])) end++;
      const word = text.slice(i, end).trim();
      if (!JSON_LITERAL.test(word)) pieces.push(word);
      i = end;
    }
  }
  return pieces;
}

function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));?/gi, (whole, dec?: string, hex?: string, name?: string) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    const code = dec ? parseInt(dec, 10) : parseInt(hex!, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** Of CSS, the comments and strings: the rules cannot carry text. */
function cssPieces(css: string): string[] {
  const found = css.match(/\/\*[\s\S]*?(?:\*\/|$)|"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?/g) ?? [];
  return found.map((piece) => (piece.startsWith("/*") ? piece.slice(2).replace(/\*\/$/, "") : piece.slice(1).replace(/["']$/, "")));
}

/** Reads the tag that starts at `start` (a "<" before a letter) into `pieces`; returns where it ends. */
function readTag(text: string, start: number, pieces: string[]): number {
  let i = start + 1;
  const name = /[^\s/>]+/y;
  name.lastIndex = i;
  const tag = name.exec(text)![0];
  i += tag.length;
  const words = [tag];
  const values: string[] = [];
  let type = "";
  let selfClosing = false;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] === ">") {
      i++;
      break;
    }
    if (text[i] === "/") {
      selfClosing = text[i + 1] === ">";
      i++;
      continue;
    }
    const attr = /[^\s=/>]+/y;
    attr.lastIndex = i;
    const attrName = attr.exec(text)?.[0];
    if (!attrName) {
      i++;
      continue;
    }
    words.push(attrName);
    i += attrName.length;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== "=") continue;
    i++;
    while (i < text.length && /\s/.test(text[i])) i++;
    let raw: string;
    if (text[i] === '"' || text[i] === "'") {
      const end = text.indexOf(text[i], i + 1);
      raw = text.slice(i + 1, end === -1 ? text.length : end);
      i = end === -1 ? text.length : end + 1;
    } else {
      const unquoted = /[^\s>]*/y;
      unquoted.lastIndex = i;
      raw = unquoted.exec(text)![0];
      i += raw.length;
    }
    const value = decodeEntities(raw);
    const lower = attrName.toLowerCase();
    if (lower === "style") values.push(...cssPieces(value));
    // The guard cannot read base64, such as an image in the page
    else if (!/^\s*data:[^,]*;base64,/i.test(value)) values.push(value);
    if (lower === "type") type = value;
  }
  pieces.push(words.join(" "), ...values);

  const lowerTag = tag.toLowerCase();
  if ((lowerTag === "script" || lowerTag === "style") && !selfClosing) {
    const close = new RegExp(`</${lowerTag}`, "gi");
    close.lastIndex = i;
    const end = close.exec(text)?.index ?? text.length;
    const body = text.slice(i, end);
    if (lowerTag === "style") pieces.push(...cssPieces(body));
    else pieces.push(...(/json/i.test(type) || parsesAsJson(body) ? jsonPieces(body) : [body]));
    i = end;
  }
  return i;
}

/** The pieces of `text` (or a part of it) read as HTML or XML. */
function markupPieces(text: string): string[] {
  const pieces: string[] = [];
  let textStart = 0;
  let i = text.indexOf("<");
  const closing = (from: number, end: string, skip: number) => {
    const at = text.indexOf(end, from + skip);
    const inner = text.slice(from + skip, at === -1 ? text.length : at);
    // An end tag with only its name says nothing its start tag did not
    if (!(text[from + 1] === "/" && /^[^\s]*$/.test(inner.trim()))) pieces.push(inner);
    return at === -1 ? text.length : at + end.length;
  };
  while (i !== -1 && i < text.length) {
    const next = text[i + 1] ?? "";
    const opens = text.startsWith("<!--", i) || text.startsWith("<![CDATA[", i) || "!?/".includes(next) || /[A-Za-z]/.test(next);
    if (!next || !opens) {
      // A "<" that opens nothing, as in "a < b": part of the text
      i = text.indexOf("<", i + 1);
      continue;
    }
    pieces.push(decodeEntities(text.slice(textStart, i)));
    if (text.startsWith("<!--", i)) i = closing(i, "-->", 4);
    else if (text.startsWith("<![CDATA[", i)) i = closing(i, "]]>", 9);
    // A doctype, a processing instruction or an end tag: the words in it
    else if ("!?/".includes(next)) i = closing(i, ">", 2);
    else i = readTag(text, i, pieces);
    textStart = i;
    i = text.indexOf("<", i);
  }
  pieces.push(decodeEntities(text.slice(textStart)));
  return pieces;
}

/**
 * What the guard scans of `text` (a file's text, or a part of it) in
 * `format`: the distinct pieces that can carry instructions, in the order
 * they first come, one per line. Of plain text, its distinct lines with a
 * letter.
 */
export function guardText(text: string, format: TextFormat): string {
  const pieces = format === "json" ? jsonPieces(text) : format === "markup" ? markupPieces(text) : text.split("\n");
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const piece of pieces) {
    const line = piece.replace(/\s+/g, " ").trim();
    if (!LETTER.test(line) || seen.has(line)) continue;
    seen.add(line);
    kept.push(line);
  }
  return kept.join("\n");
}
