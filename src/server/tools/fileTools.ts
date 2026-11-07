// The agent tools that work on files: those the user attached and those the
// agent created, which the model names. The work is done by the files server
// (tools/files): the file goes there in the call and a new one comes back,
// which the chat view shows as a card below the reply. See definitions.ts for
// what a tool definition is.

import { AGENT_TOOL_INFO } from "@/lib/agentTools";
import { cleanFileName, extensionOf, fileKind, MAX_FILE_BYTES } from "@/lib/files";
import { fileText, MAX_RENDERED_PAGES, renderPdfPages, serverError } from "@/server/files/convert";
import { conversationFiles, fileData, findFile, type ConversationFile } from "@/server/files/store";
import { checkStart, shorten, toInteger } from "./args";
import { getToolServer } from "./config";
import type { Args, ToolCallContext, ToolDefinition, ToolResult, ToolState } from "./definitions";
import { callMcpTool } from "./mcp";

const DOCUMENT_EXTENSIONS = ["docx", "pdf", "pptx"];
const EDITABLE_OFFICE = ["docx", "pptx", "xlsx"];
const MAX_EDITS = 50;
const MAX_CELLS = 500;

const failure = (text: string): ToolResult => ({ text: `Error: ${text}`, images: [], files: [], error: true });
const success = (text: string): ToolResult => ({ text, images: [], files: [], error: false });

const fileName = (args: Args, key = "file") => (typeof args[key] === "string" && args[key].trim() ? shorten(args[key], 48) : "a file");

/** A label for each state: "Reading x", "Read x", "Could not read x". */
function labels(args: Args, state: ToolState, running: string, done: string, failed: string, key = "file") {
  const name = fileName(args, key);
  return `${state === "running" ? running : state === "done" ? done : failed} ${name}`;
}

/** What the model gets when the file it names is not there: the names it can use. */
function missingFile(name: unknown, files: ConversationFile[]): string {
  const known = files.map((f) => f.name).join(", ");
  const asked = typeof name === "string" && name.trim() ? `There is no file named ${name.trim()}.` : "file is required.";
  return known ? `${asked} The files of this conversation are: ${known}.` : `${asked} This conversation has no files.`;
}

async function lookUp(args: Args, ctx: ToolCallContext): Promise<ConversationFile | ToolResult> {
  const files = await conversationFiles(ctx.conversationId);
  return findFile(files, args.file) ?? failure(missingFile(args.file, files));
}

const isResult = (value: ConversationFile | ToolResult): value is ToolResult => "error" in value;

/** The name for a file the model creates, or an error text. */
function newName(raw: unknown, allowed: (ext: string) => boolean, hint: string): { name: string } | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { error: "name is required, with an extension, such as report.docx." };
  const name = cleanFileName(raw);
  if (!name.includes(".") && fileKind(name) === null) return { error: `name needs an extension, such as ${hint}.` };
  return allowed(extensionOf(name)) ? { name } : { error: `${name} cannot be made with this tool. ${hint}` };
}

/**
 * Calls `tool` on the files server. A successful call that made a file
 * returns it, to show the user; the model gets the server's text.
 */
async function callFilesServer(
  tool: string,
  args: Args,
  ctx: ToolCallContext,
  timeoutMs: number
): Promise<ToolResult> {
  const server = getToolServer("files");
  if (!server) return failure("the file tools are not set up on this server.");
  try {
    const out = await callMcpTool(server, tool, args, { signal: ctx.signal, timeoutMs });
    if (out.isError) return failure(serverError(out.text) || "the file could not be made.");
    const files = out.files.filter((f) => Buffer.byteLength(f.data, "base64") <= MAX_FILE_BYTES);
    if (out.files.length && !files.length) return failure("the file came out larger than 20 MB, which is too large.");
    const note = files.length
      ? " The user gets it as a file card below your reply: do not write a link to it, nor repeat all of its content."
      : "";
    return { text: out.text.trim() + note, images: [], files, error: false };
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

export const FILE_TOOLS: ToolDefinition[] = [
  {
    name: "read_file",
    icon: AGENT_TOOL_INFO.read_file.icon,
    description:
      "Read a file of this conversation as text: one the user attached or one you created. " +
      "Long files come in parts; the result says which start to use for the next part.",
    parameters: {
      type: "object",
      properties: {
        file: fileParameter,
        start: { type: "integer", description: "For long files: the character to start reading at, as the previous result says. Default 0" },
      },
      required: ["file"],
    },
    server: "files",
    needs: ["tools"],
    timeoutMs: 180_000,
    label: (args, state) => labels(args, state, "Reading", "Read", "Could not read"),
    async run(args, ctx) {
      const file = await lookUp(args, ctx);
      if (isResult(file)) return file;
      if (fileKind(file.name) === "image") {
        if (!ctx.vision) return failure(`${file.name} is an image, and you cannot see images.`);
        const data = await fileData(file.id);
        return { text: `${file.name}:`, images: [{ mimeType: file.mimeType, data: data.toString("base64") }], files: [], error: false };
      }
      const start = checkStart(args.start);
      if ("error" in start) return failure(start.error);
      const { text, info } = await fileText(file, ctx.signal);
      if (text === null) return failure(`${file.name} could not be read: ${info?.error ?? "unknown error"}`);
      if (start.start >= text.length && text.length > 0) return failure(`${file.name} has only ${text.length} characters.`);
      const end = Math.min(text.length, start.start + ctx.textBudget);
      const part = text.slice(start.start, end);
      const notes: string[] = [];
      if (end < text.length) {
        notes.push(`[Characters ${start.start} to ${end} of ${text.length}. Call read_file with start=${end} for the next part.]`);
      } else if (start.start > 0) {
        notes.push(`[Characters ${start.start} to ${end}: the end of ${file.name}.]`);
      }
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
    name: "create_file",
    icon: AGENT_TOOL_INFO.create_file.icon,
    description:
      "Create a text file for the user to download: plain text, markdown, CSV, JSON, HTML or code " +
      "(Python, JavaScript, Go and so on). The extension of the name sets the type. The user gets the file " +
      "as a card below your reply.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The file name with its extension, such as notes.md, data.csv or main.py" },
        content: { type: "string", description: "The whole content of the file" },
      },
      required: ["name", "content"],
    },
    server: "files",
    needs: ["tools"],
    timeoutMs: 60_000,
    label: (args, state) => labels(args, state, "Creating", "Created", "Could not create", "name"),
    async run(args, ctx) {
      const name = newName(
        args.name,
        (ext) => fileKind(`x.${ext}`) === "text",
        "Use create_document for .docx, .pdf or .pptx and create_spreadsheet for .xlsx."
      );
      if ("error" in name) return failure(name.error);
      if (typeof args.content !== "string") return failure("content is required.");
      if (Buffer.byteLength(args.content) > MAX_FILE_BYTES) return failure("content is too long.");
      return callFilesServer("files_create_text", { name: name.name, content: args.content }, ctx, this.timeoutMs);
    },
  },
  {
    name: "edit_file",
    icon: AGENT_TOOL_INFO.edit_file.icon,
    description:
      "Change a file of this conversation and give the user the new version, as a new file card (the original " +
      "stays). Works on text and code files, and on the text of Word, PowerPoint and Excel files, whose formatting " +
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
      },
      required: ["file"],
    },
    server: "files",
    needs: ["tools"],
    timeoutMs: 120_000,
    label: (args, state) => labels(args, state, "Editing", "Edited", "Could not edit"),
    async run(args, ctx) {
      const file = await lookUp(args, ctx);
      if (isResult(file)) return file;
      const ext = extensionOf(file.name);
      if (fileKind(file.name) !== "text" && !EDITABLE_OFFICE.includes(ext)) {
        const hint = ext === "pdf" || ext === "xls" ? " Create a new file with create_document or create_spreadsheet instead." : "";
        return failure(`${file.name} cannot be edited.${hint}`);
      }
      const edits = Array.isArray(args.edits) ? args.edits : [];
      const cells = Array.isArray(args.cells) ? args.cells : [];
      if (!edits.length && !cells.length) return failure("Give edits (or cells, for Excel).");
      if (edits.length > MAX_EDITS) return failure(`At most ${MAX_EDITS} edits per call.`);
      if (cells.length > MAX_CELLS) return failure(`At most ${MAX_CELLS} cells per call.`);
      if (cells.length && ext !== "xlsx") return failure("cells only work on Excel (.xlsx) files.");
      const bad = edits.findIndex((e) => typeof e?.find !== "string" || !e.find || typeof e?.replace !== "string");
      if (bad >= 0) return failure(`Edit ${bad + 1} needs find (not empty) and replace.`);
      let rename: string | undefined;
      if (typeof args.name === "string" && args.name.trim()) {
        const named = newName(args.name, (e) => e === ext, `The new name must end in .${ext}.`);
        if ("error" in named) return failure(named.error);
        rename = named.name;
      }
      const data = await fileData(file.id);
      return callFilesServer(
        "files_edit",
        {
          name: file.name,
          data: data.toString("base64"),
          edits: edits.map((e) => ({ find: e.find, replace: e.replace, all: e.all === true || e.all === "true" })),
          cells: cells.map((c) => ({ cell: String(c?.cell ?? ""), value: c?.value ?? null })),
          ...(rename ? { new_name: rename } : {}),
        },
        ctx,
        this.timeoutMs
      );
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
      return callFilesServer("files_create_document", { name: name.name, markdown: args.markdown }, ctx, this.timeoutMs);
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
    label: (args, state) => labels(args, state, "Creating", "Created", "Could not create", "name"),
    async run(args, ctx) {
      const name = newName(args.name, (ext) => ext === "xlsx", "Use a name ending in .xlsx; create_file makes .csv files.");
      if ("error" in name) return failure(name.error);
      const sheets = Array.isArray(args.sheets) ? args.sheets : [];
      if (!sheets.length) return failure("sheets is required: at least one sheet with rows.");
      const bad = sheets.findIndex((s) => !Array.isArray(s?.rows) || s.rows.some((r: unknown) => !Array.isArray(r)));
      if (bad >= 0) return failure(`Sheet ${bad + 1} needs rows: a list of rows, each a list of cells.`);
      const payload = sheets.map((s, i) => ({ name: typeof s?.name === "string" && s.name.trim() ? s.name : `Sheet${i + 1}`, rows: s.rows }));
      if (Buffer.byteLength(JSON.stringify(payload)) > MAX_FILE_BYTES) return failure("The sheets are too large.");
      return callFilesServer("files_create_spreadsheet", { name: name.name, sheets: payload }, ctx, this.timeoutMs);
    },
  },
];
