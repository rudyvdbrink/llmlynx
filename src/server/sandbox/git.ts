// git: the model's git commands on the chat's repositories, run by the code
// container (see tools/code/src/gitrepo.py, which says how git is kept from
// running other programs and from the network). A repository is a folder of
// the sandbox, whose files are its work tree, and its .git folder, which is
// kept apart from the sandbox's files (SandboxRepo), so that runs of code never
// see it. Only clone, fetch and pull download, and only from public https://
// URLs. A call sends the repository's files and its .git folder, and keeps
// what the command changed: the files as new versions and deletions, the .git
// folder with them (see saveToolResult). Everything a command made or changed
// is scanned for viruses, in one archive, before it is kept; what git printed
// is scanned like a web page after the call (see checkAfterCall).

import { cleanFilePath, formatSize, mimeTypeOf } from "@/lib/files";
import { prisma } from "@/server/db/prisma";
import { conversationFiles, fileData, type ConversationFile } from "@/server/files/store";
import { scanVirus } from "@/server/security/scan";
import { hostOf } from "@/server/security/urls";
import type { Args, ToolCallContext, ToolResult } from "@/server/tools/definitions";
import type { ToolFile } from "@/server/tools/mcp";
import { gitInSandbox, RUN_MEMORY, type GitOutcome } from "./code";
import { withChatLock } from "./lock";
import { roomError } from "./room";
import { startAndEnd } from "./runCode";

// A repository's .git folder, and those of a chat together
export const MAX_REPO_BYTES = 64 * 1024 * 1024;
export const MAX_REPOS_BYTES = 128 * 1024 * 1024;
// What one call sends at most: the repository's files and its .git folder (the code container takes 200 MB as base64)
const MAX_CALL_BYTES = 140 * 1024 * 1024;
// The scan of everything a command made or changed, at once, such as a clone's files
const GIT_SCAN_TIMEOUT_MS = 180_000;
const MAX_COMMAND_CHARS = 4_000;
// More changed files than this are counted, not listed
const LISTED_FILES = 20;

const NETWORK = ["clone", "fetch", "pull"];
// The options of clone and init that take the next argument as their value (as in gitrepo.py)
const CLONE_VALUES = new Set(["--depth", "--shallow-since", "--shallow-exclude", "--branch", "-b", "--origin", "-o", "--jobs", "-j"]);
const INIT_VALUES = new Set(["--initial-branch", "-b", "--object-format", "--ref-format"]);

const ONE_COMMAND =
  "Give one git command per call, without shell operators such as &&, |, ; or >: run each command in a call of its own.";
const NO_REPO =
  "There is no git repository in the sandbox yet: clone one with git clone <url>, or make one with git init <folder>.";

/**
 * The words of a git command, as a shell splits them: quotes ('...' and
 * "...") and backslashes keep spaces in a word. A leading "git" goes. An error
 * text when it is more than one plain command.
 */
export function splitCommand(text: string): string[] | { error: string } {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && '"\\$`'.includes(text[i + 1] ?? "")) word += text[++i];
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === "\\" && i + 1 < text.length && text[i + 1] !== "\n") {
      word += text[++i];
      inWord = true;
    } else if (";|&<>`\n".includes(ch) || (ch === "$" && text[i + 1] === "(")) {
      return { error: ONE_COMMAND };
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (quote) return { error: "The command has a quote that is not closed." };
  if (inWord) words.push(word);
  if (words[0] === "git") words.shift();
  return words;
}

/** The positional arguments of `args`: what is not an option, nor the value of one of `values`. */
function positionals(args: string[], values: Set<string>): string[] {
  const found: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return [...found, ...args.slice(i + 1)];
    if (arg.startsWith("-") && arg.length > 1) {
      if (values.has(arg)) i++;
    } else {
      found.push(arg);
    }
  }
  return found;
}

/** The folder git clones a URL into: "https://github.com/a/b.git" -> "b". */
export function folderFromUrl(url: string): string {
  const path = url.replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  return path.split("/").pop() || "repo";
}

/** A repository's folder as the model names it: "" for the sandbox itself, null when it is no folder of it. */
function repoFolder(raw: string): string | null {
  if (/^\s*(\.|\.\/|\/|\/?sandbox\/?)?\s*$/.test(raw)) return "";
  return cleanFilePath(raw);
}

const inFolder = (name: string, folder: string) => !folder || name.toLowerCase().startsWith(`${folder.toLowerCase()}/`);
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const shown = (folder: string) => (folder ? `${folder}/` : "the sandbox");

type Repo = { path: string; size: number };

/** The chat's repositories: their folders and the size of their .git folders. */
export async function chatRepos(conversationId: string): Promise<Repo[]> {
  return prisma.sandboxRepo.findMany({ where: { conversationId }, select: { path: true, size: true }, orderBy: { path: "asc" } });
}

/** The repository a command that is not clone or init works on: the one named, or the only one. */
function pickRepo(repos: Repo[], asked: unknown): Repo | { error: string } {
  const list = repos.map((r) => (r.path ? `${r.path}/` : "the sandbox itself")).join(", ");
  if (typeof asked === "string" && asked.trim()) {
    const folder = repoFolder(asked);
    const found = folder !== null && repos.find((r) => sameName(r.path, folder));
    if (found) return found;
    return { error: repos.length ? `${asked.trim()} is not a repository. The repositories are: ${list}.` : NO_REPO };
  }
  if (repos.length === 1) return repos[0];
  return { error: repos.length ? `Name the repository with repo; there are several: ${list}.` : NO_REPO };
}

/** Why a new repository cannot be in `folder`, or null. A clone needs a folder without files. */
function newRepoProblem(folder: string, repos: Repo[], files: ConversationFile[], clone: boolean): string | null {
  for (const repo of repos) {
    if (sameName(repo.path, folder)) return `${shown(folder)} is a repository already: use it, or clone into another folder.`;
    if (!repo.path || inFolder(folder, repo.path)) return `${shown(folder)} would be inside the repository ${shown(repo.path)}.`;
    if (!folder || inFolder(repo.path, folder)) return `${shown(folder)} would hold the repository ${shown(repo.path)}.`;
  }
  if (folder && files.some((f) => sameName(f.name, folder))) return `${folder} is a file of the sandbox, not a folder.`;
  if (clone && files.some((f) => inFolder(f.name, folder))) {
    return `${shown(folder)} has files already: clone into a new folder, such as git clone <url> <folder>.`;
  }
  return null;
}

/**
 * The files as one tar archive, for one virus scan: clamd scans each file in
 * it. Their names do not matter to it, so each is named by its number.
 */
export function scanArchive(files: Buffer[]): Buffer {
  const parts: Buffer[] = [];
  files.forEach((data, i) => {
    const header = Buffer.alloc(512);
    header.write(String(i), 0, "ascii");
    header.write("0000644\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
    header.write("00000000000\0", 136, "ascii");
    header.write("        ", 148, "ascii"); // the checksum is summed with spaces in its place
    header.write("0", 156, "ascii");
    header.write("ustar\u000000", 257, "ascii");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    parts.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  });
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** How the command ended, in words, for the model, and as a note after the tool line's label. */
function ending(outcome: GitOutcome): { sentence: string; note?: string } {
  const seconds = `${(outcome.durationMs / 1000).toFixed(1)} s`;
  switch (outcome.reason) {
    case "timeout":
      return { sentence: "Stopped: it ran longer than 120 seconds.", note: "stopped after 120 s" };
    case "memory":
      return { sentence: `Stopped: it used more than ${RUN_MEMORY} of memory.`, note: "stopped: too much memory" };
    case "processes":
      return { sentence: "Stopped: it started too many processes.", note: "stopped: too many processes" };
    case "output":
      return { sentence: "Stopped: it printed more than 1 MB.", note: "stopped: too much output" };
  }
  if (outcome.exitCode === 0) return { sentence: `It succeeded in ${seconds}.` };
  return { sentence: `It failed with exit code ${outcome.exitCode} after ${seconds}.`, note: `exit code ${outcome.exitCode}` };
}

/** What a command did to the sandbox's files, in words: listed, or counted when there are many. */
function changesText(made: { name: string; size: number }[], changed: { name: string; size: number }[], deleted: string[], folder: string): string {
  const count = made.length + changed.length + deleted.length;
  if (!count) return "It made, changed and deleted no files in the sandbox.";
  if (count <= LISTED_FILES) {
    const list = [
      ...made.map((f) => `made ${f.name} (${formatSize(f.size)})`),
      ...changed.map((f) => `changed ${f.name} (${formatSize(f.size)})`),
      ...deleted.map((name) => `deleted ${name}`),
    ];
    return `Files: ${list.join(", ")}.`;
  }
  const bytes = [...made, ...changed].reduce((sum, f) => sum + f.size, 0);
  const parts = [
    made.length ? `made ${made.length}` : "",
    changed.length ? `changed ${changed.length}` : "",
    deleted.length ? `deleted ${deleted.length}` : "",
  ].filter(Boolean);
  return `Files: in ${shown(folder)}, it ${parts.join(", ")} files (${formatSize(bytes)} made or changed). List them with git status or git ls-files.`;
}

/** Runs the model's git command (`args.command`) on a repository of the chat. Throws only when the chat is stopped. */
export async function runGit(args: Args, ctx: ToolCallContext): Promise<ToolResult> {
  const failure = (text: string, note?: string): ToolResult => ({
    text: `Error: ${text}`,
    images: [],
    files: [],
    error: true,
    ...(note ? { note } : {}),
  });
  if (typeof args.command !== "string" || !args.command.trim()) return failure("command is required, such as status or clone <url>.");
  if (args.command.length > MAX_COMMAND_CHARS) return failure(`command is too long (at most ${MAX_COMMAND_CHARS} characters).`);
  const text = args.command.trim();
  const command = /^git\s/.test(text) ? text : `git ${text}`;
  const argv = splitCommand(text);
  if ("error" in argv) return failure(argv.error);
  if (!argv.length) return failure("Name a git command, such as status, log or clone <url>.");
  const security = ctx.security;
  if (!security) return failure("what git brings could not be checked, so it did not run.");
  const [sub, ...rest] = argv;
  const fresh = sub === "clone" || sub === "init";
  const url = sub === "clone" ? positionals(rest, CLONE_VALUES)[0] : undefined;
  if (sub === "clone" && !url) return failure("Name the repository's URL: git clone https://github.com/user/repo");

  return withChatLock(ctx.conversationId, async () => {
    const [repos, files] = await Promise.all([chatRepos(ctx.conversationId), conversationFiles(ctx.conversationId)]);

    let folder: string;
    let git: Buffer | null = null;
    if (fresh) {
      const named = sub === "clone" ? positionals(rest, CLONE_VALUES)[1] : positionals(rest, INIT_VALUES)[0];
      const asked = named ?? (typeof args.repo === "string" && args.repo.trim() ? args.repo : sub === "clone" ? folderFromUrl(url!) : "");
      const found = repoFolder(asked);
      if (found === null) return failure(`${asked} cannot be a folder of the sandbox.`);
      folder = found;
      const problem = newRepoProblem(folder, repos, files, sub === "clone");
      if (problem) return failure(problem);
    } else {
      const repo = pickRepo(repos, args.repo);
      if ("error" in repo) return failure(repo.error);
      folder = repo.path;
      const row = await prisma.sandboxRepo.findUniqueOrThrow({
        where: { conversationId_path: { conversationId: ctx.conversationId, path: folder } },
        select: { git: true },
      });
      git = Buffer.from(row.git);
    }

    const prefix = folder ? `${folder}/` : "";
    const tree = sub === "clone" ? [] : files.filter((f) => inFolder(f.name, folder));
    const bytes = tree.reduce((sum, f) => sum + f.size, 0) + (git?.length ?? 0);
    if (bytes > MAX_CALL_BYTES) {
      return failure(`the repository's files and history are ${formatSize(bytes)} together, more than git can work on here (140 MB).`);
    }
    const outcome = await gitInSandbox({
      conversationId: ctx.conversationId,
      argv,
      folder,
      files: await Promise.all(tree.map(async (f) => ({ path: f.name.slice(prefix.length), data: await fileData(f.id) }))),
      git,
      signal: ctx.signal,
    });
    if ("error" in outcome) return failure(outcome.error);
    return keepResults(outcome, { sub, command, folder, url, tree, files, repos }, ctx);
  });
}

/** What the model and the sandbox get of a git command that ran. */
async function keepResults(
  outcome: GitOutcome,
  call: { sub: string; command: string; folder: string; url?: string; tree: ConversationFile[]; files: ConversationFile[]; repos: Repo[] },
  ctx: ToolCallContext
): Promise<ToolResult> {
  const { sub, folder } = call;
  const prefix = folder ? `${folder}/` : "";
  const notKept = (why: string): ToolResult => ({
    text: `Error: ${why} Nothing of this command was kept.\n\nWhat git printed:\n${startAndEnd(outcome.output.trim() || "(nothing)", 2_000)}`,
    images: [],
    files: [],
    error: true,
    note: "not kept",
  });

  if (outcome.skipped.length) {
    const list = outcome.skipped.slice(0, 5).map((s) => `${prefix}${s.path} (${s.reason})`);
    return notKept(`the sandbox cannot hold all of its files: ${list.join(", ")}.`);
  }
  const incoming = outcome.files.map((f) => ({ name: prefix + f.name, data: Buffer.from(f.data, "base64") }));
  const deletions = outcome.deleted.map((path) => prefix + path);
  const badNames = incoming.filter((f) => cleanFilePath(f.name) !== f.name).map((f) => f.name);
  if (badNames.length) {
    return notKept(
      `the sandbox cannot hold files named like ${badNames.slice(0, 3).join(", ")}: names with characters such as ` +
        ': * ? " < > |, or more than 16 folders deep.'
    );
  }
  // The sandbox tells files apart without case
  const names = new Map<string, string>();
  for (const name of [...call.tree.map((f) => f.name).filter((n) => !deletions.includes(n)), ...incoming.map((f) => f.name)]) {
    const other = names.get(name.toLowerCase());
    if (other && other !== name) return notKept(`the sandbox cannot hold both ${other} and ${name}: it does not tell apart names that differ only in case.`);
    names.set(name.toLowerCase(), name);
  }
  const room = roomError(
    call.files,
    incoming.map((f) => ({ name: f.name, size: f.data.length })),
    deletions
  );
  if (room) return notKept(`${room.charAt(0).toUpperCase()}${room.slice(1)}`);

  if (outcome.git) {
    const size = Buffer.byteLength(outcome.git, "base64");
    const others = call.repos.filter((r) => !sameName(r.path, folder)).reduce((sum, r) => sum + r.size, 0);
    if (size > MAX_REPO_BYTES) {
      return notKept(`the repository's history would take ${formatSize(size)}, more than its 64 MB. Clone less of it, such as with --depth 1.`);
    }
    if (others + size > MAX_REPOS_BYTES) {
      return notKept(`the chat's repositories would take ${formatSize(others + size)} together, more than their 128 MB.`);
    }
  }

  if (incoming.length) {
    // Everything git brought into the sandbox is scanned before any of it is kept
    const scan = await scanVirus(scanArchive(incoming.map((f) => f.data)), {
      timeoutMs: GIT_SCAN_TIMEOUT_MS,
      signal: ctx.signal,
      audit: ctx.security!.audit,
      tool: "git",
      host: call.url ? (hostOf(call.url) ?? undefined) : undefined,
    });
    if (scan.status === "flagged") return notKept(`a file it brought was flagged as malware (${scan.signature}).`);
    if (scan.status === "unchecked") return notKept("its files could not be checked for malware; try again later.");
  }

  const origin = NETWORK.includes(sub) ? ("internet" as const) : ("code" as const);
  const files: ToolFile[] = incoming.map((f) => ({ name: f.name, mimeType: mimeTypeOf(f.name), data: f.data.toString("base64"), origin }));
  const existing = new Set(call.tree.map((f) => f.name.toLowerCase()));
  const sized = incoming.map((f) => ({ name: f.name, size: f.data.length }));
  const made = sized.filter((f) => !existing.has(f.name.toLowerCase()));
  const changed = sized.filter((f) => existing.has(f.name.toLowerCase()));

  const { sentence, note } = ending(outcome);
  const notes: string[] = [];
  if (outcome.repo === "new") {
    notes.push(
      `${folder ? `${folder}/ is` : "The sandbox is"} a git repository now.` +
        (call.repos.length ? ` Name it with repo (${folder || "."}) when you use git, as there are several repositories.` : "")
    );
  }
  const budget = Math.max(500, ctx.textBudget - 800);
  const printed = outcome.output.trim() ? startAndEnd(outcome.output.trimEnd(), budget) : "(It printed nothing.)";
  const text = [sentence, `Output:\n${printed}`, changesText(made, changed, deletions, folder), ...notes].join("\n\n");
  const failed = outcome.exitCode !== 0 && NETWORK.includes(sub);

  return {
    text,
    images: [],
    files,
    deletions,
    error: failed,
    ...(note && !failed ? { note } : {}),
    ...(outcome.git && outcome.repo !== "same" && outcome.repo !== "none" ? { repository: { path: folder, git: outcome.git } } : {}),
    run: {
      kind: "run",
      language: "git",
      code: call.command,
      output: outcome.output,
      status: outcome.status,
      durationMs: outcome.durationMs,
      files: { changed: incoming.map((f) => f.name), deleted: deletions },
    },
  };
}
