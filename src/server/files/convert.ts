// What llmlynx itself asks of the files server (tools/files): turning files
// into text, PDF pages into images, and photos into images a model takes.
// The agent's file tools use the same server, see tools/fileTools.ts.

import { getToolServer } from "@/server/tools/config";
import { callMcpTool, type ToolImage } from "@/server/tools/mcp";
import { fileData, saveFileText, type ConversationFile, type FileInfo } from "./store";

// The server may be a Raspberry Pi; long PDFs take a while
const CONVERT_TIMEOUT_MS = 180_000;
const RENDER_TIMEOUT_MS = 90_000;

// Most pages one call renders
export const MAX_RENDERED_PAGES = 5;

export const filesServer = () => getToolServer("files");

/** An error the files server returned, without the prefix the MCP SDK adds ("Error executing tool x: ..."). */
export const serverError = (text: string) => text.replace(/^error( executing tool [\w-]+)?:\s*/i, "").trim();

const errorText = (text: string) => serverError(text) || "The file could not be read.";

/**
 * Converts a file's bytes to text (markdown) on the files server. `text` is
 * null when the file cannot be converted; `info.error` says why. Throws when
 * the server does not answer, and when `signal` aborts.
 */
export async function convertFile(
  name: string,
  data: Uint8Array,
  signal: AbortSignal
): Promise<{ text: string | null; info: FileInfo }> {
  const out = await callMcpTool(
    filesServer(),
    "files_convert",
    { name, data: Buffer.from(data).toString("base64") },
    { signal, timeoutMs: CONVERT_TIMEOUT_MS }
  );
  if (out.isError) return { text: null, info: { error: errorText(out.text) } };
  const parsed = JSON.parse(out.text) as { markdown?: unknown; pages?: unknown; textless_pages?: unknown };
  const info: FileInfo = {};
  if (typeof parsed.pages === "number") info.pages = parsed.pages;
  if (Array.isArray(parsed.textless_pages) && parsed.textless_pages.length) {
    info.textlessPages = parsed.textless_pages.filter((p): p is number => Number.isInteger(p));
  }
  return { text: typeof parsed.markdown === "string" ? parsed.markdown : "", info };
}

/**
 * The file as text (markdown). Files are converted when they are attached
 * (see server/files/uploads.ts); one that was stored without its text is
 * converted here the first time, and the text stored. `text` is null when it
 * cannot be converted; `info.error` says why. Throws only when `signal` aborts.
 */
export async function fileText(
  file: Pick<ConversationFile, "id" | "name" | "text" | "info">,
  signal: AbortSignal
): Promise<{ text: string | null; info: FileInfo | null }> {
  if (file.text !== null || file.info?.error) return { text: file.text, info: file.info };

  let result: { text: string | null; info: FileInfo };
  try {
    result = await convertFile(file.name, await fileData(file.id), signal);
  } catch (err) {
    if (signal.aborted) throw err;
    console.error(`Converting ${file.name} failed: ${(err as Error)?.message || err}`);
    // Not stored: the server may only be down for now
    return { text: null, info: { error: "The files server did not answer." } };
  }
  await saveFileText(file.id, result.text, result.info);
  return result;
}

/**
 * Images of `pages` (from 1) of the PDF `file`, at most MAX_RENDERED_PAGES.
 * Returns an error text instead when it cannot. Throws only when `signal` aborts.
 */
export async function renderPdfPages(
  file: Pick<ConversationFile, "id" | "name">,
  pages: number[],
  signal: AbortSignal
): Promise<{ images: { page: number; image: ToolImage }[] } | { error: string }> {
  try {
    const data = await fileData(file.id);
    const wanted = pages.slice(0, MAX_RENDERED_PAGES);
    const out = await callMcpTool(
      filesServer(),
      "files_render_pdf",
      { name: file.name, data: data.toString("base64"), pages: wanted },
      { signal, timeoutMs: RENDER_TIMEOUT_MS }
    );
    if (out.isError) return { error: errorText(out.text) };
    // The server says which page each image shows, in order: "pages: 3, 4"
    const shown = /pages?:\s*([\d,\s]+)/i.exec(out.text)?.[1].split(",").map((p) => Number(p.trim())) ?? wanted;
    return { images: out.images.map((image, i) => ({ page: shown[i] ?? wanted[i], image })) };
  } catch (err) {
    if (signal.aborted) throw err;
    console.error(`Rendering ${file.name} failed: ${(err as Error)?.message || err}`);
    return { error: "The files server did not answer." };
  }
}

/** A workbook's sheets as rows of cells, its first 1,000 rows each (`more`: it has more). */
export type Sheets = { sheets: { name: string; rows: (string | number | boolean | null)[][]; more: boolean }[] };

/**
 * The sheets of an Excel `file`, for a preview, or an error text. Throws only
 * when `signal` aborts.
 */
export async function readSheets(
  file: Pick<ConversationFile, "id" | "name">,
  signal: AbortSignal
): Promise<Sheets | { error: string }> {
  try {
    const data = await fileData(file.id);
    const out = await callMcpTool(
      filesServer(),
      "files_sheets",
      { name: file.name.split("/").pop(), data: data.toString("base64") },
      { signal, timeoutMs: CONVERT_TIMEOUT_MS }
    );
    if (out.isError) return { error: errorText(out.text) };
    return JSON.parse(out.text) as Sheets;
  } catch (err) {
    if (signal.aborted) throw err;
    console.error(`Reading the sheets of ${file.name} failed: ${(err as Error)?.message || err}`);
    return { error: "The files server did not answer." };
  }
}

/**
 * The image as a model takes it: a smaller JPEG or PNG for a large photo or
 * another format, or null when the original will do; or why it cannot be read.
 */
export async function prepareImage(
  file: Pick<ConversationFile, "id" | "name">,
  signal: AbortSignal
): Promise<{ image: ToolImage | null } | { error: string }> {
  try {
    const data = await fileData(file.id);
    const out = await callMcpTool(
      filesServer(),
      "files_prepare_image",
      { name: file.name, data: data.toString("base64") },
      { signal, timeoutMs: RENDER_TIMEOUT_MS }
    );
    if (out.isError) return { error: serverError(out.text) || "It cannot be read." };
    if (/^unchanged/i.test(out.text)) return { image: null };
    return out.images[0] ? { image: out.images[0] } : { error: "It cannot be read." };
  } catch (err) {
    if (signal.aborted) throw err;
    console.error(`Preparing ${file.name} failed: ${(err as Error)?.message || err}`);
    return { error: "The files server did not answer." };
  }
}
