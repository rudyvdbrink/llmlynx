// run_code: runs the model's code in the chat's sandbox (see code.ts), and
// keeps what it did there: the files it made or changed become new versions,
// and the files it deleted get a deletion. The code is scanned for malware
// before it runs; every file it made is scanned before it is stored or shown.
// What it printed is scanned like a web page after the call (see
// checkAfterCall). The result starts with a header of the same facts every
// time (the run's id, folder, exit code, stop, duration, output), and lists
// failing tests when a test runner left results it can read (testResults.ts).
// Output too long for the result is kept whole with the run, for read_run_log.

import { randomBytes } from "node:crypto";
import { fileKind, formatSize, isArtifact, mimeTypeOf, cleanFilePath } from "@/lib/files";
import { isImageFile, markdownRef } from "@/lib/inlineImages";
import { conversationFiles, fileData } from "@/server/files/store";
import { TOOL_SCAN_TIMEOUT_MS, UPLOAD_VIRUS_TIMEOUT_MS } from "@/server/security/limits";
import { scanVirus } from "@/server/security/scan";
import type { Args, RunRecord, ToolCallContext, ToolResult } from "@/server/tools/definitions";
import type { ToolFile } from "@/server/tools/mcp";
import { chatLocks, RUN_MEMORY, RUN_TIME, runInSandbox, type RunOutcome } from "./code";
import { withChatLock } from "./lock";
import { notRun } from "./records";
import { roomError } from "./room";
import { describeTestResults, readTestResults } from "./testResults";

export const LANGUAGES = ["python", "javascript", "typescript", "shell"] as const;
export type Language = (typeof LANGUAGES)[number];

const ALIASES: Record<string, Language> = {
  py: "python",
  python3: "python",
  js: "javascript",
  node: "javascript",
  nodejs: "javascript",
  ts: "typescript",
  bash: "shell",
  sh: "shell",
  command: "shell",
};

export const LANGUAGE_LABELS: Record<Language, string> = {
  python: "Python",
  javascript: "JavaScript",
  typescript: "TypeScript",
  shell: "a command",
};

const MAX_CODE_CHARS = 200_000;

/** The language the model means, or null. */
export function languageOf(raw: unknown): Language | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().toLowerCase();
  return (LANGUAGES as readonly string[]).includes(name) ? (name as Language) : (ALIASES[name] ?? null);
}

/**
 * `text` within `budget` characters: when it is longer, its start and its
 * end, where errors show, with a note on what was left out.
 */
export function startAndEnd(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const head = Math.floor(budget * 0.4);
  const tail = budget - head;
  const left = text.length - head - tail;
  return `${text.slice(0, head)}\n\n[... ${left} characters of the output left out ...]\n\n${text.slice(-tail)}`;
}

/**
 * `text` within `budget` characters, by whole lines where it can: when it is
 * longer, its first lines and its last ones, where errors show, and which
 * lines were left out (`left`, from 1), for read_run_log.
 */
export function clipLines(text: string, budget: number): { text: string; lines: number; left?: { from: number; to: number } } {
  const lines = text.split("\n");
  if (text.length <= budget) return { text, lines: lines.length };
  const fit = (from: number, step: number, room: number, limit: number) => {
    let count = 0;
    let used = 0;
    while (count < limit && used + lines[from + step * count].length + 1 <= room) used += lines[from + step * count++].length + 1;
    return count;
  };
  const head = fit(0, 1, Math.floor(budget * 0.4), lines.length);
  const tail = fit(lines.length - 1, -1, budget - Math.floor(budget * 0.4), lines.length - head);
  // Lines too long to show whole: by characters
  if (!head || !tail) return { text: startAndEnd(text, budget), lines: lines.length, left: { from: 1, to: lines.length } };
  const left = { from: head + 1, to: lines.length - tail };
  const gap = `[... lines ${left.from} to ${left.to} left out ...]`;
  return { text: [...lines.slice(0, head), gap, ...lines.slice(lines.length - tail)].join("\n"), lines: lines.length, left };
}

const STOPS: Record<NonNullable<RunOutcome["reason"]>, string> = {
  timeout: `yes, after ${RUN_TIME} (the time limit)`,
  memory: `yes, at ${RUN_MEMORY} of memory (the limit)`,
  processes: "yes, at 128 processes or threads (the limit)",
  output: "yes, at 1 MB of output (the limit)",
};

/** The facts every run's result starts with, in the same order. */
function header(outcome: RunOutcome, id: string, cwd: string, output: string): string {
  return [
    `run: ${id}`,
    `folder: ${cwd || "the sandbox folder"}`,
    `exit code: ${outcome.reason ? "none (stopped)" : outcome.exitCode}`,
    `stopped: ${outcome.reason ? STOPS[outcome.reason] : "no"}`,
    `duration: ${(outcome.durationMs / 1000).toFixed(1)} s`,
    `output: ${output}`,
  ].join("\n");
}

/**
 * The folder a run runs in (`cwd`, a folder of the sandbox, "" for the
 * sandbox folder itself), as the files of the sandbox spell it, or an error text.
 */
export function workingFolder(raw: unknown, files: { name: string }[]): { cwd: string } | { error: string } {
  if (raw === undefined || raw === null) return { cwd: "" };
  // The sandbox folder itself: "", ".", "./", "/" or "/sandbox"
  if (typeof raw === "string" && /^(\.|\/sandbox|sandbox|\/)?\/?$/.test(raw.trim().replace(/\\/g, "/").replace(/^\.\//, ""))) return { cwd: "" };
  const path = typeof raw === "string" ? cleanFilePath(raw) : null;
  if (path) {
    const prefix = `${path.toLowerCase()}/`;
    const file = files.find((f) => f.name.startsWith(`${path}/`)) ?? files.find((f) => f.name.toLowerCase().startsWith(prefix));
    if (file) return { cwd: file.name.slice(0, path.length) };
  }
  const folders = [...new Set(files.map((f) => f.name.split("/")).filter((p) => p.length > 1).map((p) => p[0]))].slice(0, 10);
  return {
    error:
      `cwd must be a folder of the sandbox that holds files${typeof raw === "string" ? `; ${raw} is not one` : ""}.` +
      (folders.length ? ` Its folders are: ${folders.join(", ")}.` : " The sandbox has no folders: leave cwd out."),
  };
}

/**
 * How the run ended, in words, for the model, and as a note after the tool
 * line's label. A run stopped at a limit says what to do instead.
 */
function ending(outcome: RunOutcome): { sentence: string; note?: string } {
  const seconds = `${(outcome.durationMs / 1000).toFixed(1)} s`;
  switch (outcome.reason) {
    case "timeout":
      return {
        sentence:
          `Stopped: it ran longer than ${RUN_TIME}. Do the work in smaller steps: save what each run finds to a file, ` +
          "and go on from there in the next run.",
        note: `stopped after ${RUN_TIME}`,
      };
    case "memory":
      return {
        sentence: `Stopped: it used more than ${RUN_MEMORY} of memory. Work on the data in parts, rather than loading it all at once.`,
        note: "stopped: too much memory",
      };
    case "processes":
      return {
        sentence: "Stopped: it started more than 128 processes or threads. Do the work in one process, one part after another.",
        note: "stopped: too many processes",
      };
    case "output":
      return {
        sentence: "Stopped: it printed more than 1 MB. Write the full output to a file, and print only a summary of it.",
        note: "stopped: too much output",
      };
  }
  if (outcome.exitCode === 0) return { sentence: `It succeeded in ${seconds}.` };
  return { sentence: `It failed with exit code ${outcome.exitCode} after ${seconds}.`, note: `exit code ${outcome.exitCode}` };
}

// A line that runs a program, as models send with language python: "python train.py", "pytest -q", "cd app"
const COMMAND_LINE = /^(?:python3?|node|npx|npm|pytest|pip3?|bash|sh|cd|ls|cat)\s+[\w./"'-]/;

/**
 * The lines of `code` that do something: without blank lines and comments
 * ("#" for Python and shell, "//" and block comments for JavaScript and
 * TypeScript). Rough, but enough to tell code that does nothing.
 */
export function codeLines(language: Language, code: string): string[] {
  const text = language === "javascript" || language === "typescript" ? code.replace(/\/\*[\s\S]*?\*\//g, "") : code;
  const comment = language === "javascript" || language === "typescript" ? /^\/\// : /^#/;
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !comment.test(line));
}

/**
 * The language to run `code` in: the one the model gave, or for a command
 * line sent as Python, JavaScript or TypeScript, shell; python when it gave
 * none. With a note for the model when it is not the one it gave, or an
 * error text for code that does nothing.
 */
export function chooseLanguage(raw: unknown, code: string): { language: Language; note?: string } | { error: string } {
  const given = typeof raw === "string" && raw.trim() ? languageOf(raw) : null;
  if (typeof raw === "string" && raw.trim() && !given) {
    return { error: `language must be one of: ${LANGUAGES.join(", ")} (python if unsure; shell for a command line such as python script.py).` };
  }
  const lines = codeLines(given ?? "python", code);
  if (!lines.length) {
    return {
      error:
        "not run: the code has only comments, so nothing would run. To run a file of the sandbox, use language shell " +
        "with a command such as python script.py.",
    };
  }
  const commandLine = lines.every((line) => COMMAND_LINE.test(line));
  if (!given) {
    const language = commandLine ? "shell" : "python";
    return { language, note: `language was not given, so it ran as ${language}.` };
  }
  if (given !== "shell" && commandLine) {
    return { language: "shell", note: `It is a command line, so it ran as one: next time, use language shell for it.` };
  }
  if (given === "python" && lines.every((line) => /^(import|from)\s/.test(line))) {
    return { language: given, note: "The code only imports modules, so nothing else ran." };
  }
  return { language: given };
}

/**
 * Runs the model's code (`args.language`, `args.code`) in the chat's
 * sandbox. Throws only when the chat is stopped.
 */
export async function runCode(args: Args, ctx: ToolCallContext): Promise<ToolResult> {
  const failure = (text: string, run?: RunRecord, note?: string): ToolResult => ({
    text: `Error: ${text}`,
    images: [],
    files: [],
    error: true,
    ...(note ? { note } : {}),
    ...(run ? { run } : {}),
  });
  if (typeof args.code !== "string" || !args.code.trim()) return failure("code is required.");
  if (args.code.length > MAX_CODE_CHARS) return failure(`code is too long (at most ${MAX_CODE_CHARS} characters).`);
  const code = args.code;
  const chosen = chooseLanguage(args.language, code);
  if ("error" in chosen) return failure(chosen.error);
  const { language } = chosen;
  const security = ctx.security;
  const folder = workingFolder(args.cwd, await conversationFiles(ctx.conversationId));
  if ("error" in folder) return failure(folder.error);
  if (!security) return failure("the code could not be checked, so it was not run.");

  // The code itself is checked for malware before it runs
  const scan = await scanVirus(Buffer.from(code), {
    timeoutMs: TOOL_SCAN_TIMEOUT_MS,
    signal: ctx.signal,
    audit: security.audit,
    tool: "run_code",
  });
  if (scan.status === "flagged") {
    return failure("not run: the code was flagged as malware.", notRun("run_code", args, "blocked"), "blocked: malware");
  }
  if (scan.status === "unchecked") {
    return failure("not run: the code could not be checked; try again later.", notRun("run_code", args, "blocked"), "not checked");
  }

  return withChatLock(ctx.conversationId, async () => {
    const files = await conversationFiles(ctx.conversationId);
    const full = roomError(files, []);
    if (full) return failure(full);
    const inputs = await Promise.all(files.map(async (f) => ({ path: f.name, data: await fileData(f.id) })));
    const outcome = await runInSandbox({
      conversationId: ctx.conversationId,
      language,
      code,
      cwd: folder.cwd,
      files: inputs,
      locks: await chatLocks(ctx.conversationId),
      signal: ctx.signal,
    });
    if ("error" in outcome) return failure(outcome.error);
    return keepResults(outcome, files, language, code, folder.cwd, chosen.note, ctx);
  });
}

/** What the model and the sandbox get of a run that happened. */
async function keepResults(
  outcome: RunOutcome,
  current: { name: string; size: number }[],
  language: Language,
  code: string,
  cwd: string,
  languageNote: string | undefined,
  ctx: ToolCallContext
): Promise<ToolResult> {
  const id = `run-${randomBytes(6).toString("hex")}`;
  const notes: string[] = [];
  const kept: ToolFile[] = [];
  for (const file of outcome.files) {
    const path = cleanFilePath(file.name);
    if (!path) continue;
    const data = Buffer.from(file.data, "base64");
    // Every file the code made is scanned before it is stored or shown
    const scan = await scanVirus(data, {
      timeoutMs: UPLOAD_VIRUS_TIMEOUT_MS,
      signal: ctx.signal,
      audit: ctx.security!.audit,
      tool: "run_code",
    });
    if (scan.status === "flagged") notes.push(`${path} was flagged as malware and discarded.`);
    else if (scan.status === "unchecked") notes.push(`${path} could not be checked for malware, so it was not kept.`);
    else kept.push({ name: path, mimeType: mimeTypeOf(path), data: file.data, origin: "code" });
  }
  for (const skipped of outcome.skipped) notes.push(`${skipped.path} was not kept: ${skipped.reason}.`);

  let deletions = outcome.deleted;
  const sizes = kept.map((f) => ({ name: f.name, size: Buffer.byteLength(f.data, "base64") }));
  const full = roomError(current, sizes, deletions);
  let files = kept;
  if (full) {
    notes.push(`None of the files of this run were kept: ${full}`);
    files = [];
    deletions = [];
  }

  const existing = new Set(current.map((f) => f.name.toLowerCase()));
  const changes = [
    ...sizes
      .filter(() => files.length)
      .map((f) => `${existing.has(f.name.toLowerCase()) ? "changed" : "made"} ${f.name} (${formatSize(f.size)})`),
    ...deletions.map((name) => `deleted ${name}`),
  ];
  const shown = files.filter((f) => isArtifact(f.mimeType)).map((f) => f.name);
  if (shown.length) notes.push(`The user sees these in the chat below your reply, so do not share them or write links to them: ${shown.join(", ")}.`);
  // Charts and other images can also show within the text, where the reply talks about them
  const showable = files.filter(isImageFile).map((f) => f.name);
  if (showable.length) {
    notes.push(`To show ${showable.length === 1 ? "it" : "an image"} within your reply's text instead, write ![caption](${markdownRef(showable[0])}).`);
  }
  // A model that can see checks its own charts the way it looks at any image
  const images = files.filter((f) => fileKind(f.name) === "image").map((f) => f.name);
  if (ctx.vision && images.length) {
    notes.push(`Look at ${images.join(", ")} with view_image to check ${images.length === 1 ? "it" : "them"}.`);
  }
  const { sentence, note } = ending(outcome);

  // What the tests found, when a test runner left results this can read
  const exists = new Set([...current.map((f) => f.name), ...outcome.files.map((f) => f.name)]);
  for (const name of deletions) exists.delete(name);
  const reports = outcome.files.map((f) => ({ name: f.name, data: Buffer.from(f.data, "base64") }));
  const report = readTestResults(outcome.output, reports, (path) => exists.has(path), cwd);
  // A run stopped at a limit did not finish its tests: what it printed so far is no result
  const tests = report && (outcome.reason ? "Tests: no results, as the run was stopped before it ended." : describeTestResults(report));

  // Room for the rest of the text in the budget
  const budget = Math.max(500, ctx.textBudget - 900 - (tests?.length ?? 0));
  const trimmed = outcome.output.trimEnd();
  const clipped = trimmed.trim() ? clipLines(trimmed, budget) : null;
  const lost = outcome.printedBytes - Buffer.byteLength(outcome.output);
  const about = [
    clipped ? `${clipped.lines} line${clipped.lines === 1 ? "" : "s"}` : "none",
    ...(clipped?.left
      ? [`lines ${clipped.left.from} to ${clipped.left.to} are left out here: read them, or find text in them, with read_run_log (run ${id})`]
      : []),
    ...(lost > 0 ? [`it printed ${formatSize(outcome.printedBytes)}, but only the first 1 MB was kept: the rest is lost`] : []),
  ].join("; ");
  const text = [
    header(outcome, id, cwd, about),
    ...(languageNote ? [languageNote] : []),
    ...(outcome.reason ? [sentence] : []),
    ...(outcome.reinstalled.length ? ["The chat's packages were installed again first."] : []),
    ...(tests ? [tests] : []),
    `Output:\n${clipped ? clipped.text : "(It printed nothing.)"}`,
    changes.length ? `Files: ${changes.join(", ")}.` : "It made, changed and deleted no files.",
    ...notes,
  ].join("\n\n");

  return {
    text,
    images: [],
    files,
    deletions,
    error: false,
    ...(note ? { note } : {}),
    run: {
      id,
      kind: "run",
      language,
      code,
      output: outcome.output,
      status: outcome.status,
      durationMs: outcome.durationMs,
      printedBytes: outcome.printedBytes,
      files: { changed: files.map((f) => f.name), deleted: deletions },
    },
  };
}
