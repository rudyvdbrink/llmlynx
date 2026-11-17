// run_code: runs the model's code in the chat's sandbox (see code.ts), and
// keeps what it did there: the files it made or changed become new versions,
// and the files it deleted get a deletion. The code is scanned for malware
// before it runs; every file it made is scanned before it is stored or shown.
// What it printed is scanned like a web page after the call (see
// checkAfterCall).

import { fileKind, formatSize, isArtifact, mimeTypeOf, cleanFilePath } from "@/lib/files";
import { conversationFiles, fileData } from "@/server/files/store";
import { TOOL_SCAN_TIMEOUT_MS, UPLOAD_VIRUS_TIMEOUT_MS } from "@/server/security/limits";
import { scanVirus } from "@/server/security/scan";
import type { Args, RunRecord, ToolCallContext, ToolResult } from "@/server/tools/definitions";
import type { ToolFile } from "@/server/tools/mcp";
import { chatLocks, runInSandbox, type RunOutcome } from "./code";
import { withChatLock } from "./lock";
import { notRun } from "./records";
import { roomError } from "./room";

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
 * How the run ended, in words, for the model, and as a note after the tool
 * line's label. A run stopped at a limit says what to do instead.
 */
function ending(outcome: RunOutcome): { sentence: string; note?: string } {
  const seconds = `${(outcome.durationMs / 1000).toFixed(1)} s`;
  switch (outcome.reason) {
    case "timeout":
      return {
        sentence:
          "Stopped: it ran longer than 120 seconds. Do the work in smaller steps: save what each run finds to a file, " +
          "and go on from there in the next run.",
        note: "stopped after 120 s",
      };
    case "memory":
      return {
        sentence: "Stopped: it used more than 512 MB of memory. Work on the data in parts, rather than loading it all at once.",
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
  const language = languageOf(args.language);
  if (!language) return failure(`language must be one of: ${LANGUAGES.join(", ")}.`);
  if (typeof args.code !== "string" || !args.code.trim()) return failure("code is required.");
  if (args.code.length > MAX_CODE_CHARS) return failure(`code is too long (at most ${MAX_CODE_CHARS} characters).`);
  const code = args.code;
  const security = ctx.security;
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
      files: inputs,
      locks: await chatLocks(ctx.conversationId),
      signal: ctx.signal,
    });
    if ("error" in outcome) return failure(outcome.error);
    return keepResults(outcome, files, language, code, ctx);
  });
}

/** What the model and the sandbox get of a run that happened. */
async function keepResults(
  outcome: RunOutcome,
  current: { name: string; size: number }[],
  language: Language,
  code: string,
  ctx: ToolCallContext
): Promise<ToolResult> {
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
  if (shown.length) notes.push(`The user sees these in the chat below your reply, so do not share or link to them: ${shown.join(", ")}.`);
  // A model that can see checks its own charts the way it looks at any image
  const images = files.filter((f) => fileKind(f.name) === "image").map((f) => f.name);
  if (ctx.vision && images.length) {
    notes.push(`Look at ${images.join(", ")} with view_image to check ${images.length === 1 ? "it" : "them"}.`);
  }
  const { sentence, note } = ending(outcome);
  // Room for the rest of the text in the budget
  const budget = Math.max(500, ctx.textBudget - 600);
  const printed = outcome.output.trim() ? startAndEnd(outcome.output.trimEnd(), budget) : "(It printed nothing.)";
  const text = [
    sentence,
    ...(outcome.reinstalled.length ? ["The chat's packages were installed again first."] : []),
    `Output:\n${printed}`,
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
      kind: "run",
      language,
      code,
      output: outcome.output,
      status: outcome.status,
      durationMs: outcome.durationMs,
      files: { changed: files.map((f) => f.name), deleted: deletions },
    },
  };
}
