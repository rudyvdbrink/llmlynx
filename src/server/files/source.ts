// Files as source text, for the coding tools (read_file by lines,
// search_workspace, edit_files): their bytes decoded as they are, without the
// markdown conversion documents get, so that lines, indentation and blank
// lines stay. Lines are numbered from 1.

import { isUtf8 } from "node:buffer";
import { baseName, fileKind } from "@/lib/files";

/** No NUL bytes at the start, and no UTF-16 byte order mark: text that UTF-8 or a one-byte encoding can hold. */
export function looksLikeText(data: Uint8Array): boolean {
  if (data.length >= 2 && ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff))) return false;
  return !data.subarray(0, 8192).includes(0);
}

/**
 * Whether a file is source text: a text or code file by its extension, or a
 * file whose extension says nothing (README, Makefile, LICENSE, .lock) that
 * holds text. Documents and images are not.
 */
export function isSourceFile(name: string, data: Uint8Array): boolean {
  const kind = fileKind(name);
  return (kind === "text" || kind === null) && looksLikeText(data);
}

const BOM = [0xef, 0xbb, 0xbf];

const withoutBom = (data: Uint8Array) =>
  data.length >= 3 && data[0] === BOM[0] && data[1] === BOM[1] && data[2] === BOM[2] ? data.subarray(3) : data;

/** Whether the file's bytes are valid UTF-8 (a byte order mark allowed), so that an edit can keep them as they are. */
export const isUtf8Text = (data: Uint8Array) => isUtf8(withoutBom(data));

/** The text of source bytes: UTF-8 without its byte order mark; bytes that are not UTF-8 become U+FFFD. */
export function decodeSource(data: Uint8Array): string {
  return new TextDecoder("utf-8").decode(withoutBom(data));
}

/** The lines of a text, without their line ends ("\n" or "\r\n"). A text that ends with a line end has no empty last line. */
export function sourceLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/** Where each line starts in the text, by character. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/** A numbered line as the model gets it: "12| text". The number and "| " are not part of the file. */
export const numbered = (number: number, line: string, width: number) => `${String(number).padStart(width)}| ${line}`;

/** At most `width` characters of a line around the place `at`, for a search hit. */
export function excerpt(line: string, at: number, width = 160): string {
  const trimmed = line.trimEnd();
  if (trimmed.length <= width) return trimmed;
  const start = Math.max(0, Math.min(at - Math.floor(width / 3), trimmed.length - width));
  const end = start + width;
  return (start ? "…" : "") + trimmed.slice(start, end) + (end < trimmed.length ? "…" : "");
}

/** The places of `find` in `text`, without overlaps. */
export function occurrences(text: string, find: string): number[] {
  const places: number[] = [];
  if (!find) return places;
  for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + find.length)) places.push(at);
  return places;
}

/** A glob turned into a regular expression: ** any folders, * and ? within one part of the path, {a,b} either. */
function globExpression(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        out += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "{") {
      const close = glob.indexOf("}", i);
      if (close < 0) {
        out += "\\{";
        continue;
      }
      out += `(?:${glob.slice(i + 1, close).split(",").map((part) => globExpression(part).source.slice(1, -1)).join("|")})`;
      i = close;
    } else if (c === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close < 0) {
        out += "\\[";
        continue;
      }
      const set = glob.slice(i + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\");
      out += `[${set}]`;
      i = close;
    } else {
      out += c.replace(/[.+^$()|\\\]]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, "i");
}

/**
 * Which paths a pattern of the model's matches, without case: a glob such as
 * src/**\/*.ts (the whole path) or *.test.ts (without "/": the file name, in
 * any folder); text without * ? [ or { matches every path that holds it, such
 * as a folder ("src/server") or part of a name ("policy"). null when it is
 * not a usable pattern.
 */
export function pathMatcher(raw: string): ((path: string) => boolean) | null {
  const pattern = raw.trim().replace(/\\/g, "/").replace(/^\/?(sandbox\/)?(\.\/)?/, "");
  if (!pattern || pattern === "." || pattern === "/") return () => true;
  if (!/[*?[{]/.test(pattern)) {
    const part = pattern.toLowerCase().replace(/\/+$/, "");
    return (path) => path.toLowerCase().includes(part);
  }
  let expression: RegExp;
  try {
    expression = globExpression(pattern.replace(/\/+$/, "/**"));
  } catch {
    return null;
  }
  const byName = !pattern.includes("/");
  return (path) => expression.test(byName ? baseName(path) : path);
}
