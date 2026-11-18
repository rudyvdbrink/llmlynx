// The agent tools that work on files: the files of the chat's sandbox, which
// the user attached, the agent created, code made or a download fetched, and
// which the model names. The work is done by the files server (tools/files):
// the file goes there in the call and a new one comes back, which the chat
// view shows as a card below the reply. See definitions.ts for what a tool
// definition is.

import { AGENT_TOOL_INFO } from "@/lib/agentTools";
import { baseName, cleanFilePath, extensionOf, fileKind, MAX_FILE_BYTES, mimeTypeOf } from "@/lib/files";
import { fileText, MAX_RENDERED_PAGES, prepareImage, renderPdfPages, serverError } from "@/server/files/convert";
import { sniffType } from "@/server/files/sniff";
import { decodeSource, isSourceFile, isUtf8Text, lineStarts, numbered, sourceLines } from "@/server/files/source";
import {
  contentVersion,
  conversationFiles,
  fileData,
  findExactFile,
  findFile,
  isUntrusted,
  staleText,
  type ConversationFile,
} from "@/server/files/store";
import { sandboxRoomError } from "@/server/sandbox/room";
import { checkFileRead } from "@/server/security/engine";
import { checkStart, listError, shorten, toInteger, toList } from "./args";
import { EDITS_EXAMPLE, editProblem, missingPath } from "./codeTools";
import { getToolServer } from "./config";
import type { Args, ToolCallContext, ToolDefinition, ToolResult, ToolState } from "./definitions";
import { callMcpTool } from "./mcp";

const DOCUMENT_EXTENSIONS = ["docx", "pdf", "pptx"];
const EDITABLE_OFFICE = ["docx", "pptx", "xlsx"];
const MAX_EDITS = 50;
const MAX_CELLS = 500;

// The file tools fetch nothing from the internet. The files they read were
// checked when they arrived; the text of an untrusted file (from code, or
// downloaded) is scanned before the model reads it (see read_file)
const LOCAL = { untrustedOutput: false, exec: false };

const failure = (text: string): ToolResult => ({ text: `Error: ${text}`, images: [], files: [], error: true });
const success = (text: string): ToolResult => ({ text, images: [], files: [], error: false });

const fileName = (args: Args, key = "file") => (typeof args[key] === "string" && args[key].trim() ? shorten(args[key], 48) : "a file");

/** A label for each state: "Reading x", "Read x", "Could not read x". */
function labels(args: Args, state: ToolState, running: string, done: string, failed: string, key = "file") {
  const name = fileName(args, key);
  return `${state === "running" ? running : state === "done" ? done : failed} ${name}`;
}

/** What the model gets when the file it names is not there: the names it can use. */
export function missingFile(name: unknown, files: ConversationFile[]): string {
  const known = files.map((f) => f.name).join(", ");
  const asked = typeof name === "string" && name.trim() ? `There is no file named ${name.trim()}.` : "file is required.";
  return known ? `${asked} The files of this conversation are: ${known}.` : `${asked} This conversation has no files.`;
}

async function lookUp(args: Args, ctx: ToolCallContext): Promise<ConversationFile | ToolResult> {
  const files = await conversationFiles(ctx.conversationId);
  return findFile(files, args.file) ?? failure(missingFile(args.file, files));
}

const isResult = (value: ConversationFile | ToolResult): value is ToolResult => "error" in value;

/** The path for a file the model creates (folders allowed), or an error text. */
function newName(raw: unknown, allowed: (ext: string) => boolean, hint: string): { name: string } | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { error: "name is required, with an extension, such as report.docx." };
  const name = cleanFilePath(raw);
  if (!name) return { error: "name must be a file name in the sandbox, such as report.docx or out/report.docx." };
  const base = baseName(name);
  if (!base.includes(".") && fileKind(base) === null) return { error: `name needs an extension, such as ${hint}.` };
  return allowed(extensionOf(base)) ? { name } : { error: `${name} cannot be made with this tool. ${hint}` };
}

/**
 * Calls `tool` on the files server. A successful call that made a file
 * returns it, stored in the sandbox as `path` (the server only gets its file
 * name), to show the user; the model gets the server's text. A file made from
 * an untrusted one stays untrusted (`origin`).
 */
async function callFilesServer(
  tool: string,
  args: Args,
  ctx: ToolCallContext,
  timeoutMs: number,
  path: string,
  origin?: ConversationFile["origin"]
): Promise<ToolResult> {
  const server = getToolServer("files");
  try {
    const out = await callMcpTool(server, tool, args, { signal: ctx.signal, timeoutMs });
    if (out.isError) return failure(serverError(out.text) || "the file could not be made.");
    const files = out.files
      .filter((f) => Buffer.byteLength(f.data, "base64") <= MAX_FILE_BYTES)
      .map((f) => ({ ...f, name: path, ...(origin === "code" || origin === "internet" ? { origin } : {}) }));
    if (out.files.length && !files.length) return failure("the file came out larger than 20 MB, which is too large.");
    const full = await sandboxRoomError(
      ctx.conversationId,
      files.map((f) => ({ name: f.name, size: Buffer.byteLength(f.data, "base64") }))
    );
    if (full) return failure(full);
    // Its version, for a next edit of it
    const version = files.length === 1 ? ` Its version is ${contentVersion(Buffer.from(files[0].data, "base64"))}.` : "";
    const note = files.length
      ? " The user gets it as a file card below your reply: do not write a link to it, nor repeat all of its content."
      : "";
    return { text: out.text.trim() + version + note, images: [], files, error: false };
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    console.error(`Files tool ${tool} failed: ${(err as Error)?.message || err}`);
    return failure("the files server did not answer. It may be down; try again later.");
  }
}

/** Page numbers from 3, "3", [2, 3] or "2-4, 6", or an error text. */
function parsePages(raw: unknown): { pages: number[] } | { error: string } {
  const parts: unknown[] = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [raw];
  const pages: number[] = [];
  for (const part of parts) {
    const range = typeof part === "string" ? /^\s*(\d+)\s*(?:-|–|to)\s*(\d+)\s*$/.exec(part) : null;
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      for (let p = from; p <= to && pages.length <= MAX_RENDERED_PAGES; p++) pages.push(p);
      continue;
    }
    const page = toInteger(part);
    if (page === undefined) continue;
    if (page === null || page < 1) return { error: `pages must be page numbers from 1, such as "3" or "2-4".` };
    pages.push(page);
  }
  if (!pages.length) return { error: `pages is required, such as "3" or "2-4".` };
  const unique = [...new Set(pages)];
  if (unique.length > MAX_RENDERED_PAGES) return { error: `At most ${MAX_RENDERED_PAGES} pages per call.` };
  return { pages: unique };
}

const pagesLabel = (args: Args) => {
  const pages = parsePages(args.pages);
  if ("error" in pages) return "pages";
  return pages.pages.length === 1 ? `page ${pages.pages[0]}` : `pages ${pages.pages.join(", ")}`;
};

const fileParameter = { type: "string", description: "The file's name, as in the list of this conversation's files" };

/**
 * An image file as the model sees it: a smaller JPEG or PNG of a large photo
 * or of a GIF, else the file itself, as the type its bytes are.
 */
async function viewImage(file: ConversationFile, ctx: ToolCallContext): Promise<ToolResult> {
  if (!ctx.vision) return failure(`${file.name} is an image, and you cannot see images.`);
  const prepared = await prepareImage(file, ctx.signal);
  if ("error" in prepared) return failure(`${file.name} cannot be shown: ${prepared.error}`);
  let image = prepared.image;
  if (!image) {
    const data = await fileData(file.id);
    const real = sniffType(data);
    image = { mimeType: real ? mimeTypeOf(`x.${real}`) : file.mimeType, data: data.toString("base64") };
  }
  return { text: `${file.name}:`, images: [image], files: [], error: false };
}

/**
 * A source file's text as it is: UTF-8 decoded, or for a file in another
 * encoding, the text the files server makes of it.
 */
async function sourceText(file: ConversationFile, data: Buffer, signal: AbortSignal): Promise<string> {
  if (isUtf8Text(data)) return decodeSource(data);
  return (await fileText(file, signal)).text ?? decodeSource(data);
}

/**
 * read_file by lines: the lines from start_line to end_line that fit in the
 * text budget, numbered, with the file's version. A line too long to fit is
 * shown in part, with where it goes on by characters, so that reading always
 * moves on.
 */
async function readLines(file: ConversationFile, data: Buffer, args: Args, ctx: ToolCallContext): Promise<ToolResult> {
  const startLine = toInteger(args.start_line);
  const endLine = toInteger(args.end_line);
  if (startLine === null || (startLine !== undefined && startLine < 1)) return failure("start_line must be a whole number from 1.");
  const first = startLine ?? 1;
  if (endLine === null || (endLine !== undefined && endLine < first)) {
    return failure(`end_line must be a whole number from start_line (${first}).`);
  }
  const version = contentVersion(data);
  const text = await sourceText(file, data, ctx.signal);
  const lines = sourceLines(text);
  if (!lines.length) return success(`${file.name} (version ${version}) is empty.`);
  if (first > lines.length) return failure(`${file.name} has only ${lines.length} lines.`);
  const last = Math.min(endLine ?? lines.length, lines.length);
  const width = String(last).length;
  const shown: string[] = [];
  let used = 0;
  let next = first;
  let longLine: string | null = null;
  for (; next <= last; next++) {
    const row = numbered(next, lines[next - 1], width);
    if (used + row.length + 1 > ctx.textBudget) {
      if (shown.length) break;
      // A line too long for the budget: its start, and where it goes on, by characters
      const keep = Math.max(1, ctx.textBudget - width - 2);
      shown.push(row.slice(0, width + 2 + keep));
      const at = lineStarts(text)[next - 1] + keep;
      longLine =
        `[Line ${next} has ${lines[next - 1].length} characters; this shows the first ${keep}. Read on in it with ` +
        `start=${at} (characters)${next < lines.length ? `, or go on with start_line=${next + 1}` : ""}.]`;
      next++;
      break;
    }
    shown.push(row);
    used += row.length + 1;
  }
  const lastShown = next - 1;
  let part = shown.join("\n");
  // A file from code or the internet is checked before the model reads it, as by characters
  if (isUntrusted(file)) {
    if (!ctx.security) return failure(`${file.name} could not be checked, so it cannot be read.`);
    const checked = await checkFileRead({ file, text: part, tool: "read_file", session: ctx.security, signal: ctx.signal });
    if ("blocked" in checked) return checked.blocked;
    part = checked.text;
  }
  const range = first === lastShown ? `line ${first}` : `lines ${first} to ${lastShown}`;
  const notes = [`${file.name}, version ${version}, ${range} of ${lines.length}:`, part];
  if (longLine) notes.push(longLine);
  else if (lastShown < last) notes.push(`[Call read_file with start_line=${lastShown + 1} for the next part.]`);
  return success(notes.join("\n"));
}

export const FILE_TOOLS: ToolDefinition[] = [
  {
    name: "read_file",
    icon: AGENT_TOOL_INFO.read_file.icon,
    description:
      "Read a file of this conversation as text: one the user attached or one you created. Long files come in parts; " +
      "the result says where the next part starts. Read text and code files by lines with start_line and end_line, " +
      "such as the lines search_workspace found. For a text or code file, the result gives its version, for edits.",
    parameters: {
      type: "object",
      properties: {
        file: fileParameter,
        start: { type: "integer", description: "For long files: the character to start reading at, as the previous result says. Default 0" },
        start_line: {
          type: "integer",
          description: 'Text and code files: the first line to read, from 1. Lines come numbered as "12| text": the number and "| " are not part of the file',
        },
        end_line: { type: "integer", description: "Text and code files: the last line to read. Default: as many as fit" },
      },
      required: ["file"],
    },
    server: "files",
    needs: ["tools"],
    timeoutMs: 180_000,
    effects: LOCAL,
    label: (args, state) => labels(args, state, "Reading", "Read", "Could not read"),
    async run(args, ctx) {
      const file = await lookUp(args, ctx);
      if (isResult(file)) return file;
      if (fileKind(file.name) === "image") return viewImage(file, ctx);
      const byLines = [args.start_line, args.end_line].some((v) => v !== undefined && v !== null && v !== "");
      if (byLines && toInteger(args.start) !== undefined) {
        return failure("Give either start (characters) or start_line and end_line (lines), not both.");
      }
      const data = await fileData(file.id);
      const source = isSourceFile(file.name, data);
      if (byLines) {
        if (!source) return failure(`${file.name} is not a text or code file, so it has no lines to read: read it with start (characters).`);
        return readLines(file, data, args, ctx);
      }
      const start = checkStart(args.start);
      if ("error" in start) return failure(start.error);
      // Source text as it is, the same text that start_line reads; documents as markdown
      const { text, info } = source ? { text: await sourceText(file, data, ctx.signal), info: null } : await fileText(file, ctx.signal);
      if (text === null) return failure(`${file.name} could not be read: ${info?.error ?? "unknown error"}`);
      if (start.start >= text.length && text.length > 0) return failure(`${file.name} has only ${text.length} characters.`);
      const end = Math.min(text.length, start.start + ctx.textBudget);
      let part = text.slice(start.start, end);
      // A file from code or the internet is scanned for prompt injections before the model reads it
      const untrusted = isUntrusted(file);
      if (untrusted) {
        if (!ctx.security) return failure(`${file.name} could not be checked, so it cannot be read.`);
        const checked = await checkFileRead({ file, text: part, tool: "read_file", session: ctx.security, signal: ctx.signal });
        if ("blocked" in checked) return checked.blocked;
        part = checked.text;
      }
      const notes: string[] = [];
      if (end < text.length) {
        notes.push(`[Characters ${start.start} to ${end} of ${text.length}. Call read_file with start=${end} for the next part.]`);
      } else if (start.start > 0) {
        notes.push(`[Characters ${start.start} to ${end}: the end of ${file.name}.]`);
      }
      if (source) notes.push(`[${file.name} is version ${contentVersion(data)}.]`);
      if (info?.textlessPages?.length) {
        notes.push(
          `[Pages ${info.textlessPages.join(", ")} have no text, probably scanned.` +
            (ctx.vision ? " Look at them with view_pdf_pages.]" : "]")
        );
      }
      return success([part || "(The file has no text.)", ...notes].join("\n\n"));
    },
  },
  {
    name: "view_pdf_pages",
    icon: AGENT_TOOL_INFO.view_pdf_pages.icon,
    description:
      `Look at pages of a PDF of this conversation as images: for scanned pages, charts, pictures or layout. ` +
      `At most ${MAX_RENDERED_PAGES} pages per call.`,
    parameters: {
      type: "object",
      properties: {
        file: fileParameter,
        pages: { type: "string", description: `Page numbers from 1, such as "3" or "2-4"` },
      },
      required: ["file", "pages"],
    },
    server: "files",
    needs: ["tools", "vision"],
    timeoutMs: 90_000,
    effects: LOCAL,
    label(args, state) {
      const where = `${pagesLabel(args)} of ${fileName(args)}`;
      if (state === "running") return `Looking at ${where}`;
      return state === "done" ? `Looked at ${where}` : `Could not look at ${where}`;
    },
    async run(args, ctx) {
      const file = await lookUp(args, ctx);
      if (isResult(file)) return file;
      if (extensionOf(file.name) !== "pdf") return failure(`${file.name} is not a PDF.`);
      const pages = parsePages(args.pages);
      if ("error" in pages) return failure(pages.error);
      const total = (await fileText(file, ctx.signal)).info?.pages;
      const beyond = total ? pages.pages.filter((p) => p > total) : [];
      if (total && beyond.length) return failure(`${file.name} has ${total} pages; there is no page ${beyond.join(", ")}.`);
      const rendered = await renderPdfPages(file, pages.pages, ctx.signal);
      if ("error" in rendered) return failure(rendered.error);
      const shown = rendered.images.map((i) => i.page).join(", ");
      return {
        text: `Pages ${shown} of ${file.name}${total ? ` (${total} pages)` : ""}, in that order:`,
        images: rendered.images.map((i) => i.image),
        files: [],
        error: false,
      };
    },
  },
  {
    name: "view_image",
    icon: "file",
    description:
      "Look at an image file of this conversation (PNG, JPEG, WebP or GIF), such as one you downloaded, one code " +
      "made or one the user attached. Large images come smaller.",
    parameters: { type: "object", properties: { file: fileParameter }, required: ["file"] },
    server: "files",
    needs: ["tools", "vision"],
    timeoutMs: 90_000,
    effects: LOCAL,
    label: (args, state) => labels(args, state, "Looking at", "Looked at", "Could not look at"),
    async run(args, ctx) {
      const file = await lookUp(args, ctx);
      if (isResult(file)) return file;
      if (fileKind(file.name) !== "image") return failure(`${file.name} is not an image (PNG, JPEG, WebP or GIF).`);
      return viewImage(file, ctx);
    },
  },
  {
    name: "create_file",
    icon: AGENT_TOOL_INFO.create_file.icon,
    description:
      "Create a text file for the user to download: plain text, markdown, CSV, JSON, HTML, SVG or code " +
      "(Python, JavaScript, Go and so on). The extension of the name sets the type. The user gets the file " +
      "as a card below your reply.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The file name with its extension, such as notes.md, data.csv or src/main.py (folders are made as needed)",
        },
        content: { type: "string", description: "The whole content of the file" },
      },
      required: ["name", "content"],
    },
    server: "files",
    needs: ["tools"],
    timeoutMs: 60_000,
    effects: LOCAL,
    label: (args, state) => labels(args, state, "Creating", "Created", "Could not create", "name"),
    async run(args, ctx) {
      const name = newName(
        args.name,
        (ext) => fileKind(`x.${ext}`) === "text",
        "create_file makes text and code files, such as .txt, .md, .csv, .json, .html, .svg and .py. Use create_document " +
          "for .docx, .pdf or .pptx, create_spreadsheet for .xlsx, and run_code for other formats, such as PNG images."
      );
      if ("error" in name) return failure(name.error);
      if (typeof args.content !== "string") return failure("content is required.");
      if (Buffer.byteLength(args.content) > MAX_FILE_BYTES) return failure("content is too long.");
      return callFilesServer(
        "files_create_text",
        { name: baseName(name.name), content: args.content },
        ctx,
        this.timeoutMs,
        name.name
      );
    },
  },
  {
    name: "edit_file",
    icon: AGENT_TOOL_INFO.edit_file.icon,
    description:
      "Change a file of this conversation and give the user the new version, as a file card below your reply. " +
      "Works on text and code files, and on the text of Word, PowerPoint and Excel files, whose formatting " +
      "stays as it is. Each edit replaces text that must occur in the file exactly once, unless all is true; in " +
      "Word and PowerPoint, within one paragraph, written without markdown. For Excel, cells can also be set.",
    parameters: {
      type: "object",
      properties: {
        file: fileParameter,
        edits: {
          type: "array",
          description: "The replacements, made in order",
          items: {
            type: "object",
            properties: {
              find: { type: "string", description: "The exact text to replace" },
              replace: { type: "string", description: "The new text; empty to delete" },
              all: { type: "boolean", description: "Replace every occurrence instead of exactly one. Default false" },
            },
            required: ["find", "replace"],
          },
        },
        cells: {
          type: "array",
          description: "Excel only: cells to set, such as {\"cell\": \"Sheet1!B3\", \"value\": 42}. Text that starts with = is a formula",
          items: {
            type: "object",
            properties: {
              cell: { type: "string", description: "The cell, such as B3 (first sheet) or Sheet1!B3" },
              // One type only: not every API takes a list of types. Numbers in text become numbers.
              value: { type: "string", description: "The new value: a number, text, or a formula starting with =" },
            },
            required: ["cell", "value"],
          },
        },
        name: { type: "string", description: "A new name for the new version. Default: the same name" },
        expected_version: {
          type: "string",
          description:
            "The file's version as read_file or search_workspace gave it, with its exact path as file: nothing changes if the file changed since",
        },
      },
      required: ["file"],
    },
    server: "files",
    needs: ["tools"],
    timeoutMs: 120_000,
    effects: LOCAL,
    label: (args, state) => labels(args, state, "Editing", "Edited", "Could not edit"),
    async run(args, ctx) {
      // With a version, the file is the one at that exact path: never one guessed by its name
      const expected = typeof args.expected_version === "string" ? args.expected_version.trim().toLowerCase() : "";
      const files = await conversationFiles(ctx.conversationId);
      const file = expected ? findExactFile(files, args.file) : findFile(files, args.file);
      if (!file) return failure(expected ? missingPath(args.file, files) : missingFile(args.file, files));
      const ext = extensionOf(file.name);
      if (fileKind(file.name) !== "text" && !EDITABLE_OFFICE.includes(ext)) {
        const hint = ext === "pdf" || ext === "xls" ? " Create a new file with create_document or create_spreadsheet instead." : "";
        return failure(`${file.name} cannot be edited.${hint}`);
      }
      // Models also send these lists as JSON text
      const editList = toList(args.edits);
      if (editList === null) return failure(listError("edits", args.edits, EDITS_EXAMPLE));
      const cellList = toList(args.cells);
      if (cellList === null) return failure(listError("cells", args.cells, '[{"cell": "B3", "value": "42"}]'));
      const edits = (editList ?? []) as { find: string; replace: string; all?: unknown }[];
      const cells = (cellList ?? []) as { cell?: unknown; value?: unknown }[];
      if (!edits.length && !cells.length) return failure(`Give edits, a list such as ${EDITS_EXAMPLE} (or cells, for Excel).`);
      if (edits.length > MAX_EDITS) return failure(`At most ${MAX_EDITS} edits per call.`);
      if (cells.length > MAX_CELLS) return failure(`At most ${MAX_CELLS} cells per call.`);
      if (cells.length && ext !== "xlsx") return failure("cells only work on Excel (.xlsx) files.");
      const problem = edits.map(editProblem).find(Boolean);
      if (problem) return failure(problem);
      let rename: string | undefined;
      if (typeof args.name === "string" && args.name.trim()) {
        const named = newName(args.name, (e) => e === ext, `The new name must end in .${ext}.`);
        if ("error" in named) return failure(named.error);
        rename = named.name;
      }
      const data = await fileData(file.id);
      const version = contentVersion(data);
      if (expected && expected !== version) return { ...failure(""), text: staleText([{ name: file.name, version: expected, current: version }]) };
      // The new version of a file from code or the internet stays untrusted
      const result = await callFilesServer(
        "files_edit",
        {
          name: baseName(file.name),
          data: data.toString("base64"),
          edits: edits.map((e) => ({ find: e.find, replace: e.replace, all: e.all === true || e.all === "true" })),
          cells: cells.map((c) => ({ cell: String(c?.cell ?? ""), value: c?.value ?? null })),
          ...(rename ? { new_name: baseName(rename) } : {}),
        },
        ctx,
        this.timeoutMs,
        rename ?? file.name,
        file.origin
      );
      // Stored only if the file is still as it was read here (see staleVersions)
      return result.error ? result : { ...result, expect: [{ name: file.name, version }] };
    },
  },
  {
    name: "create_document",
    icon: AGENT_TOOL_INFO.create_document.icon,
    description:
      "Create a Word document (.docx), a PDF (.pdf) or a PowerPoint presentation (.pptx) from markdown, for the " +
      "user to download. The extension of the name sets the type. Headings, lists, tables, bold and italic, " +
      "links, code and math ($...$) work. For a presentation, each slide starts with a '## ' heading, and " +
      "speaker notes go in a block that starts with '::: notes' and ends with ':::'. The user gets the file as a " +
      "card below your reply.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The file name, ending in .docx, .pdf or .pptx" },
        markdown: { type: "string", description: "The whole document, in markdown" },
      },
      required: ["name", "markdown"],
    },
    server: "files",
    needs: ["tools"],
    timeoutMs: 120_000,
    effects: LOCAL,
    label: (args, state) => labels(args, state, "Creating", "Created", "Could not create", "name"),
    async run(args, ctx) {
      const name = newName(
        args.name,
        (ext) => DOCUMENT_EXTENSIONS.includes(ext),
        "Use a name ending in .docx, .pdf or .pptx; create_file makes text files and create_spreadsheet .xlsx."
      );
      if ("error" in name) return failure(name.error);
      if (typeof args.markdown !== "string" || !args.markdown.trim()) return failure("markdown is required.");
      if (Buffer.byteLength(args.markdown) > MAX_FILE_BYTES) return failure("markdown is too long.");
      return callFilesServer(
        "files_create_document",
        { name: baseName(name.name), markdown: args.markdown },
        ctx,
        this.timeoutMs,
        name.name
      );
    },
  },
  {
    name: "create_spreadsheet",
    icon: AGENT_TOOL_INFO.create_spreadsheet.icon,
    description:
      "Create an Excel workbook (.xlsx) for the user to download. Give each sheet's rows as lists of cells; the " +
      "first row is the header. Numbers become numbers, and text that starts with = is a formula, such as " +
      "=SUM(B2:B10). The user gets the file as a card below your reply.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The file name, ending in .xlsx" },
        sheets: {
          type: "array",
          description: "The sheets, in order",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "The sheet's name, at most 31 characters" },
              rows: {
                type: "array",
                description: "The rows, each a list of cells: numbers, text, or formulas starting with =",
                items: { type: "array", items: { type: "string" } },
              },
            },
            required: ["name", "rows"],
          },
        },
      },
      required: ["name", "sheets"],
    },
    server: "files",
    needs: ["tools"],
    timeoutMs: 60_000,
    effects: LOCAL,
    label: (args, state) => labels(args, state, "Creating", "Created", "Could not create", "name"),
    async run(args, ctx) {
      const name = newName(args.name, (ext) => ext === "xlsx", "Use a name ending in .xlsx; create_file makes .csv files.");
      if ("error" in name) return failure(name.error);
      const sheetList = toList(args.sheets);
      if (sheetList === null) return failure(listError("sheets", args.sheets, '[{"name": "Data", "rows": [["Name", "Total"], ["A", "1"]]}]'));
      const sheets = (sheetList ?? []).map((s) => {
        const sheet = s as { name?: unknown; rows?: unknown };
        return { name: sheet?.name, rows: toList(sheet?.rows) ?? sheet?.rows };
      }) as { name?: unknown; rows: unknown[][] }[];
      if (!sheets.length) return failure("sheets is required: at least one sheet with rows.");
      const bad = sheets.findIndex((s) => !Array.isArray(s?.rows) || s.rows.some((r: unknown) => !Array.isArray(r)));
      if (bad >= 0) return failure(`Sheet ${bad + 1} needs rows: a list of rows, each a list of cells.`);
      const payload = sheets.map((s, i) => ({ name: typeof s?.name === "string" && s.name.trim() ? s.name : `Sheet${i + 1}`, rows: s.rows }));
      if (Buffer.byteLength(JSON.stringify(payload)) > MAX_FILE_BYTES) return failure("The sheets are too large.");
      return callFilesServer(
        "files_create_spreadsheet",
        { name: baseName(name.name), sheets: payload },
        ctx,
        this.timeoutMs,
        name.name
      );
    },
  },
];
