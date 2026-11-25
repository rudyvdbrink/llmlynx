// The agent tools for working on code in the chat's sandbox: finding files and
// text in them (search_workspace), and changing several source files at once,
// all or nothing (edit_files). A search hit gives a path, a line and a version
// that read_file (start_line) and the edit tools take as they are. See
// definitions.ts for what a tool definition is.

import { randomBytes } from "node:crypto";
import { baseName, fileKind, formatSize, MAX_FILE_BYTES, mimeTypeOf } from "@/lib/files";
import { lineDiff } from "@/server/files/diff";
import {
  decodeSource,
  excerpt,
  isSourceFile,
  isUtf8Text,
  looksLikeText,
  numbered,
  pathMatcher,
  sourceLines,
} from "@/server/files/source";
import {
  contentVersion,
  conversationFiles,
  filesData,
  findExactFile,
  isUntrusted,
  staleText,
  type ConversationFile,
  type StaleVersion,
} from "@/server/files/store";
import { applyTextEdits, type TextEdit } from "@/server/files/textEdit";
import { sandboxRoomError } from "@/server/sandbox/room";
import { checkFileRead } from "@/server/security/engine";
import { listError, shorten, toList } from "./args";
import type { Args, ToolCallContext, ToolDefinition, ToolResult, ToolState } from "./definitions";
import type { ToolFile } from "./mcp";

// Files larger than this are not searched; a call reads at most MAX_SCAN_BYTES of files
const MAX_SEARCH_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
// Files whose contents are read from the database at once
const BATCH = 64;
const MAX_PATTERN_LENGTH = 400;
// edit_files: most files and edits per call
const MAX_CHANGED_FILES = 10;
const MAX_EDITS = 50;

// Like the file tools: nothing from the internet, and the text of untrusted files is checked before the model gets it
const LOCAL = { untrustedOutput: false, exec: false };

const failure = (text: string): ToolResult => ({ text: `Error: ${text}`, images: [], files: [], error: true });
const success = (text: string): ToolResult => ({ text, images: [], files: [], error: false });

/** What the model gets when there is no file at the exact path it gave: files of that name elsewhere, if any. */
export function missingPath(name: unknown, files: ConversationFile[]): string {
  if (typeof name !== "string" || !name.trim()) return "file is required: the file's exact path in the sandbox.";
  const wanted = name.trim();
  const base = baseName(wanted.replace(/\\/g, "/")).toLowerCase();
  const same = files.filter((f) => baseName(f.name).toLowerCase() === base).slice(0, 5).map((f) => f.name);
  return `There is no file at ${wanted}.` + (same.length ? ` Files with that name: ${same.join(", ")}.` : " Find it with search_workspace.");
}

/** Paths in a stable order: by their characters. */
const byPath = (a: ConversationFile, b: ConversationFile) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** A search's `after`: "path:line" (text) or a path; the line is 0 when there is none. */
function parseAfter(raw: unknown): { path: string; line: number } | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const text = raw.trim();
  const colon = text.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(text.slice(colon + 1))) return { path: text.slice(0, colon), line: Number(text.slice(colon + 1)) };
  return { path: text, line: 0 };
}

const asBoolean = (raw: unknown) => raw === true || raw === "true";

function searchLabel(args: Args, state: ToolState): string {
  const pattern = typeof args.pattern === "string" && args.pattern.trim() ? shorten(args.pattern, 48) : "";
  const what = args.mode === "paths" ? `files named ${pattern || "…"}` : pattern ? `“${pattern}”` : "text";
  if (state === "running") return `Searching the sandbox for ${what}`;
  return state === "done" ? `Searched the sandbox for ${what}` : `Could not search the sandbox for ${what}`;
}

/** search_workspace with mode "paths": the files whose path matches the pattern. */
function searchPaths(pattern: string, files: ConversationFile[], args: Args, ctx: ToolCallContext): ToolResult {
  const matches = pathMatcher(pattern);
  if (!matches) return failure(`${pattern} is not a pattern that can be used. Use a glob such as src/**/*.ts or *.test.ts.`);
  const after = parseAfter(args.after);
  const all = files.filter((f) => matches(f.name)).sort(byPath);
  const left = after ? all.filter((f) => f.name > after.path) : all;
  if (!left.length) return success(after ? `No more files match ${pattern}.` : `No files match ${pattern}.`);
  const max = Math.max(20, Math.min(200, Math.floor(ctx.textBudget / 60)));
  const shown = left.slice(0, max);
  const count = `${left.length} file${left.length === 1 ? " matches" : "s match"}`;
  const lines = [`${count} ${pattern}${after ? ` after ${after.path}` : ""}:`, ...shown.map((f) => f.name)];
  if (left.length > shown.length) {
    lines.push(`[${left.length - shown.length} more. Continue with after="${shown[shown.length - 1].name}".]`);
  }
  return success(lines.join("\n"));
}

type FileHits = { file: ConversationFile; version: string; hits: { line: number; text: string }[]; withheld?: string };

/**
 * search_workspace with mode "text": the lines that hold the pattern, in the
 * files that match `path`, file by file in the order of their paths. It stops
 * at a number of hits, or after reading MAX_SCAN_BYTES of files, and then says
 * where to continue.
 */
async function searchText(pattern: string, files: ConversationFile[], args: Args, ctx: ToolCallContext): Promise<ToolResult> {
  if (/[\r\n]/.test(pattern)) return failure("The text search finds text within one line: search for one line of it.");
  let scope = files;
  if (typeof args.path === "string" && args.path.trim()) {
    const inPath = pathMatcher(args.path);
    if (!inPath) return failure(`${args.path} is not a path pattern that can be used. Use a folder or a glob, such as src or src/**/*.ts.`);
    scope = files.filter((f) => inPath(f.name));
  }
  // Images and documents are not source text
  scope = scope.filter((f) => fileKind(f.name) !== "image" && fileKind(f.name) !== "document").sort(byPath);
  const ignoreCase = asBoolean(args.ignore_case);
  const needle = ignoreCase ? pattern.toLowerCase() : pattern;
  const after = parseAfter(args.after);
  const first = after ? scope.findIndex((f) => f.name >= after.path) : 0;
  const maxHits = Math.max(10, Math.min(60, Math.floor(ctx.textBudget / 170)));

  const found: FileHits[] = [];
  const tooLarge: string[] = [];
  let hitCount = 0;
  let searched = 0;
  let readBytes = 0;
  let stop: { after: string; why: string } | null = null;
  const todo = first < 0 ? [] : scope.slice(first);
  scan: for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const contents = await filesData(batch.filter((f) => f.size <= MAX_SEARCH_FILE_BYTES).map((f) => f.id));
    for (const file of batch) {
      if (file.size > MAX_SEARCH_FILE_BYTES) {
        tooLarge.push(file.name);
        continue;
      }
      if (readBytes > 0 && readBytes + file.size > MAX_SCAN_BYTES) {
        stop = { after: `${file.name}:0`, why: `it read ${formatSize(readBytes)} of files` };
        break scan;
      }
      const data = contents.get(file.id);
      if (!data || !looksLikeText(data)) continue;
      searched++;
      readBytes += data.length;
      const lines = sourceLines(decodeSource(data));
      const from = after && file.name === after.path ? after.line : 0;
      const hits: FileHits["hits"] = [];
      for (let n = from + 1; n <= lines.length; n++) {
        const at = (ignoreCase ? lines[n - 1].toLowerCase() : lines[n - 1]).indexOf(needle);
        if (at < 0) continue;
        if (hitCount >= maxHits) {
          stop = { after: `${file.name}:${n - 1}`, why: `${maxHits} matches` };
          break;
        }
        hits.push({ line: n, text: excerpt(lines[n - 1], at) });
        hitCount++;
      }
      if (hits.length) found.push({ file, version: contentVersion(data), hits });
      if (stop) break scan;
    }
  }

  // The text of an untrusted file is checked before the model reads it, as with read_file: a hit whose
  // text does not pass keeps its place (path and line), without the text
  await Promise.all(
    found
      .filter((group) => isUntrusted(group.file))
      .map(async (group) => {
        if (!ctx.security) {
          group.withheld = "it could not be checked";
          return;
        }
        const text = group.hits.map((h) => h.text).join("\n");
        const checked = await checkFileRead({ file: group.file, text, tool: "search_workspace", session: ctx.security, signal: ctx.signal });
        if ("blocked" in checked) {
          const injection = checked.blocked.security?.flag === "injection";
          // No flag is stored for it: the user cannot mark it a false positive
          if (injection) ctx.security.context.leftOut = true;
          group.withheld = injection ? "it looked like instructions aimed at the model" : "it could not be checked";
        } else {
          const cleaned = checked.text.split("\n");
          group.hits.forEach((h, i) => (h.text = cleaned[i] ?? h.text));
        }
      })
  );

  const quoted = JSON.stringify(pattern);
  const where = typeof args.path === "string" && args.path.trim() ? ` in ${args.path.trim()}` : "";
  const out: string[] = [];
  if (!hitCount) {
    out.push(
      stop
        ? `No matches of ${quoted}${where} so far: the search stopped at its limit after ${searched} files.`
        : `No matches of ${quoted}${where} in the ${searched} text files searched.`
    );
  } else {
    out.push(`${hitCount} match${hitCount === 1 ? "" : "es"} of ${quoted}${where} in ${found.length} file${found.length === 1 ? "" : "s"}:`);
    for (const group of found) {
      out.push(`${group.file.name} (version ${group.version})`);
      const width = String(group.hits[group.hits.length - 1].line).length;
      if (group.withheld) {
        out.push(`  lines ${group.hits.map((h) => h.line).join(", ")} (their text is withheld: ${group.withheld})`);
      } else {
        for (const hit of group.hits) out.push(`  ${numbered(hit.line, hit.text, width)}`);
      }
    }
  }
  if (tooLarge.length) {
    out.push(`[Not searched, larger than ${formatSize(MAX_SEARCH_FILE_BYTES)}: ${tooLarge.slice(0, 5).join(", ")}${tooLarge.length > 5 ? ` and ${tooLarge.length - 5} more` : ""}.]`);
  }
  out.push(
    stop
      ? `[The search stopped at its limit (${stop.why}); there may be more. Continue with after="${stop.after}".]`
      : hitCount
        ? `[All ${searched} text files searched. Read around a match with read_file start_line.]`
        : ""
  );
  return success(out.filter(Boolean).join("\n"));
}

async function searchWorkspace(args: Args, ctx: ToolCallContext): Promise<ToolResult> {
  const mode = args.mode === "paths" || args.mode === "text" ? args.mode : null;
  if (!mode) return failure(`mode must be "paths" (find files by path) or "text" (find text in files).`);
  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  if (!pattern.trim()) return failure("pattern is required.");
  if (pattern.length > MAX_PATTERN_LENGTH) return failure(`pattern is too long (at most ${MAX_PATTERN_LENGTH} characters).`);
  const files = await conversationFiles(ctx.conversationId);
  if (!files.length) return success("The sandbox has no files.");
  return mode === "paths" ? searchPaths(pattern.trim(), files, args, ctx) : searchText(pattern, files, args, ctx);
}

/** A change edit_files makes, ready to store. */
type Prepared = { file: ConversationFile; expected: string; before: string; after: string; bom: boolean };

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export const EDITS_EXAMPLE = '[{"find": "old text", "replace": "new text"}]';

/** Why an edit of edit_file or edit_files is not usable (`i` from 0), naming what it has; null when it is. */
export function editProblem(edit: unknown, i: number): string | null {
  const e = edit as { find?: unknown; replace?: unknown } | null;
  if (e && typeof e === "object" && typeof e.find === "string" && e.find && typeof e.replace === "string") return null;
  const has = e && typeof e === "object" && !Array.isArray(e) ? `it has ${Object.keys(e).join(", ") || "nothing"}` : `it is ${shorten(JSON.stringify(edit) ?? String(edit), 60)}`;
  return `Edit ${i + 1} needs find (the exact text to replace, not empty) and replace (the new text); ${has}.`;
}

/** The edits of one change of edit_files, or why they are not usable. */
function editsOf(raw: unknown): TextEdit[] | string {
  const list = toList(raw);
  if (!list?.length) return listError("edits", raw, EDITS_EXAMPLE);
  const problem = list.map(editProblem).find(Boolean);
  if (problem) return problem;
  return (list as { find: string; replace: string; all?: unknown }[]).map((e) => ({ find: e.find, replace: e.replace, all: asBoolean(e.all) }));
}

/** The diff of the changes, for the model, within `budget` characters; checked as read_file checks untrusted files. */
async function diffText(changes: Prepared[], newVersions: string[], budget: number, ctx: ToolCallContext): Promise<string> {
  const parts: string[] = [];
  let left = budget;
  for (const [i, change] of changes.entries()) {
    const diff = lineDiff(sourceLines(change.before), sourceLines(change.after));
    const head = `${change.file.name}: version ${change.expected} -> ${newVersions[i]}, +${diff.added} -${diff.removed} lines`;
    let hunks = diff.hunks.join("\n");
    if (isUntrusted(change.file)) {
      const checked = ctx.security
        ? await checkFileRead({ file: change.file, text: hunks, tool: "edit_files", session: ctx.security, signal: ctx.signal })
        : null;
      if (checked && "blocked" in checked && checked.blocked.security?.flag === "injection") ctx.security!.context.leftOut = true;
      hunks = checked && "text" in checked ? checked.text : "(The diff is not shown: the file's text could not be checked. Read the file to see it.)";
    }
    if (hunks.length + head.length + 1 > left) {
      hunks = left > head.length + 200 ? `${hunks.slice(0, left - head.length - 100)}\n[The rest of this diff is left out: read the file to see it.]` : "[Diff left out: read the file to see it.]";
    }
    parts.push(`${head}\n${hunks}`);
    left = Math.max(0, left - head.length - hunks.length - 1);
  }
  return parts.join("\n\n");
}

/**
 * edit_files: exact replacements in several source files, stored together.
 * Every file, its version, every edit and the sandbox's room are checked
 * before anything is written; the result names the versions the files must
 * still have when it is stored (see staleVersions), so a change made in
 * between makes the whole call fail rather than part of it.
 */
async function editFiles(args: Args, ctx: ToolCallContext): Promise<ToolResult> {
  // Small models sometimes send the list as JSON text
  const changes = (toList(args.changes) ?? []) as ({ file?: unknown; expected_version?: unknown; edits?: unknown } | null)[];
  if (!changes.length) {
    return failure(listError("changes", args.changes, '[{"file": "src/a.ts", "expected_version": "1a2b3c4d", "edits": [...]}]'));
  }
  if (changes.length > MAX_CHANGED_FILES) return failure(`At most ${MAX_CHANGED_FILES} files per call.`);
  const editCount = changes.reduce((sum, c) => sum + (toList(c?.edits)?.length ?? 0), 0);
  if (editCount > MAX_EDITS) return failure(`At most ${MAX_EDITS} edits per call.`);

  const files = await conversationFiles(ctx.conversationId);
  const targets = changes.map((c) => findExactFile(files, c?.file));
  const contents = await filesData(targets.filter((f): f is ConversationFile => !!f).map((f) => f.id));
  const errors: string[] = [];
  const stale: StaleVersion[] = [];
  const prepared: Prepared[] = [];
  const seen = new Set<string>();
  for (const [i, change] of changes.entries()) {
    const file = targets[i];
    if (!file) {
      errors.push(`change ${i + 1}: ${missingPath(change?.file, files)}`);
      continue;
    }
    if (seen.has(file.id)) {
      errors.push(`${file.name}: give each file once, with all of its edits.`);
      continue;
    }
    seen.add(file.id);
    const expected = typeof change?.expected_version === "string" ? change.expected_version.trim().toLowerCase() : "";
    if (!expected) {
      errors.push(`${file.name}: expected_version is required: the version read_file or search_workspace gave.`);
      continue;
    }
    const edits = editsOf(change?.edits);
    if (typeof edits === "string") {
      errors.push(`${file.name}: ${edits}`);
      continue;
    }
    const data = contents.get(file.id)!;
    if (!isSourceFile(file.name, data) || !isUtf8Text(data)) {
      errors.push(`${file.name} is not a UTF-8 text or code file: change it with edit_file.`);
      continue;
    }
    const current = contentVersion(data);
    if (current !== expected) {
      stale.push({ name: file.name, version: expected, current });
      continue;
    }
    const before = decodeSource(data);
    const applied = applyTextEdits(before, edits);
    if ("error" in applied) {
      errors.push(`${file.name}: ${applied.error}`);
      continue;
    }
    prepared.push({ file, expected, before, after: applied.text, bom: data.subarray(0, 3).equals(BOM) });
  }
  if (stale.length) return { ...failure(""), text: [staleText(stale), ...errors.map((e) => `- ${e}`)].join("\n") };
  if (errors.length) return failure(`Nothing was changed.\n${errors.map((e) => `- ${e}`).join("\n")}`);

  const changed = prepared.filter((p) => p.after !== p.before);
  if (!changed.length) return failure("The edits change nothing: each replace is the same as its find.");
  const outputs = changed.map((p) => Buffer.concat([p.bom ? BOM : Buffer.alloc(0), Buffer.from(p.after, "utf8")]));
  const tooLarge = changed.find((_, i) => outputs[i].length > MAX_FILE_BYTES);
  if (tooLarge) return failure(`Nothing was changed: ${tooLarge.file.name} would be larger than 20 MB.`);
  const full = await sandboxRoomError(
    ctx.conversationId,
    changed.map((p, i) => ({ name: p.file.name, size: outputs[i].length }))
  );
  if (full) return failure(`Nothing was changed: ${full}`);

  const versions = outputs.map(contentVersion);
  const changeset = `cs-${randomBytes(4).toString("hex")}`;
  // A new version of a file from code or the internet stays untrusted
  const stored: ToolFile[] = changed.map((p, i) => ({
    name: p.file.name,
    mimeType: mimeTypeOf(p.file.name),
    data: outputs[i].toString("base64"),
    ...(p.file.origin === "code" || p.file.origin === "internet" ? { origin: p.file.origin } : {}),
  }));
  const head =
    `Changed ${changed.length} file${changed.length === 1 ? "" : "s"} together, as changeset ${changeset} ` +
    `(undo_file with changeset ${changeset} undoes all of it).` +
    (prepared.length > changed.length ? ` Unchanged: ${prepared.filter((p) => p.after === p.before).map((p) => p.file.name).join(", ")}.` : "");
  const diff = await diffText(changed, versions, Math.max(500, ctx.textBudget - head.length - 100), ctx);
  return {
    text: `${head}\n\n${diff}`,
    images: [],
    files: stored,
    error: false,
    expect: changed.map((p) => ({ name: p.file.name, version: p.expected })),
    changeset,
  };
}

function editFilesLabel(args: Args, state: ToolState): string {
  const names = (Array.isArray(args.changes) ? args.changes : [])
    .map((c) => (typeof c?.file === "string" ? baseName(c.file.trim()) : ""))
    .filter(Boolean);
  const what = names.length ? shorten(names.join(", "), 60) : "files";
  if (state === "running") return `Editing ${what}`;
  return state === "done" ? `Edited ${what}` : `Could not edit ${what}`;
}

const editItems = {
  type: "object",
  properties: {
    find: { type: "string", description: "The exact text to replace" },
    replace: { type: "string", description: "The new text; empty to delete" },
    all: { type: "boolean", description: "Replace every occurrence instead of exactly one. Default false" },
  },
  required: ["find", "replace"],
};

export const CODE_TOOLS: ToolDefinition[] = [
  {
    name: "search_workspace",
    icon: "file",
    description:
      "Find files of this chat's sandbox, or text in them. mode \"paths\": the files whose path matches pattern, a " +
      "glob such as src/**/*.ts or *.test.ts. mode \"text\": the lines that hold pattern, exact text (not a regular " +
      "expression), with each file's path and version and each line's number; path limits it to files such as " +
      "src/**/*.py. Read the lines around a match with read_file start_line.",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["paths", "text"], description: "paths: find files by path. text: find text in files" },
        pattern: { type: "string", description: "paths: a glob, or part of a path. text: the exact text to find, within one line" },
        path: { type: "string", description: "text only: search only files whose path matches this glob or folder" },
        ignore_case: { type: "boolean", description: "text only: ignore upper and lower case. Default false" },
        after: { type: "string", description: "To continue a search that stopped at its limit: the after value its result gave" },
      },
      required: ["mode", "pattern"],
    },
    server: "files",
    needs: ["tools"],
    timeoutMs: 120_000,
    effects: LOCAL,
    label: searchLabel,
    run: searchWorkspace,
  },
  {
    name: "edit_files",
    icon: "file",
    description:
      "Change several text or code files of the sandbox in one step: all of them change, or none. Each change names a " +
      "file by its exact path, the version read_file or search_workspace gave for it, and exact replacements as in " +
      "edit_file. If any file changed since that version, or any replacement does not fit, nothing changes. Returns a " +
      "changeset id, which undo_file takes to undo all of it, and the diff. For Word, PowerPoint and Excel files, use edit_file.",
    parameters: {
      type: "object",
      properties: {
        changes: {
          type: "array",
          description: "One entry per file",
          items: {
            type: "object",
            properties: {
              file: { type: "string", description: "The file's exact path in the sandbox" },
              expected_version: { type: "string", description: "The file's version, as read_file or search_workspace gave it" },
              edits: { type: "array", description: "The replacements, made in order", items: editItems },
            },
            required: ["file", "expected_version", "edits"],
          },
        },
      },
      required: ["changes"],
    },
    server: "files",
    needs: ["tools"],
    timeoutMs: 120_000,
    effects: LOCAL,
    label: editFilesLabel,
    run: editFiles,
  },
];

export { editItems };
