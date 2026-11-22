// What the model did with tools, for the facts of a checkpoint's summary (see
// checkpoint.ts). The steps are grouped by what they did and what they did it
// to, each with the numbers of its results, which read_result takes. A file
// goes by its name, with as much of its path as tells it apart from the other
// files. Steps that failed are listed apart, and the newest steps once more,
// in their order. It is put together from the calls' arguments, not from the
// labels of the chat view, which are cut short for the screen.

import { baseName } from "@/lib/files";
import { findFile, type ConversationFile } from "@/server/files/store";
import { LANGUAGE_LABELS, languageOf } from "@/server/sandbox/runCode";
import { shorten, toList } from "@/server/tools/args";
import { getToolDefinition, type Args } from "@/server/tools/definitions";

/** A stored tool step, with the arguments of its call. */
export type ToolStep = {
  position: number;
  toolName: string | null;
  args: Args;
  label: string | null;
  error: boolean;
  runStatus: string | null; // run_code and install_packages: how the run ended
};

// What a step did: as done, and as what it was to do
const KINDS = {
  read: { done: "Read", to: "read" },
  looked: { done: "Looked at", to: "look at" },
  searched: { done: "Searched", to: "search" },
  downloaded: { done: "Downloaded", to: "download" },
  created: { done: "Created", to: "create" },
  edited: { done: "Edited", to: "edit" },
  undid: { done: "Undid the last change to", to: "undo the last change to" },
  installed: { done: "Installed", to: "install" },
  ran: { done: "Ran", to: "run" },
  shared: { done: "Shared", to: "share" },
  reread: { done: "Read again", to: "read again" },
  notes: { done: "Updated your notes", to: "update your notes" },
  used: { done: "Used", to: "use" },
};
type Kind = keyof typeof KINDS;

// How many targets a group lists, how many failures, how many numbers one target, and how many of the newest steps are listed again
const MAX_TARGETS = 8;
const MAX_FAILED = 6;
const MAX_NUMBERS = 5;
const RECENT = 8;
// Most characters of a command line or a search
const MAX_TEXT = 80;
// Runs that did not end well, though the call itself worked
const FAILED_RUNS = ["error", "timeout", "stopped", "blocked", "skipped"];

/** What a step did, to which files or what else, and for a command its line. */
type Described = { kind: Kind; files?: string[]; text?: string; detail?: string };

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** A file's path as the sandbox has it, or as the call gave it when there is no such file (any more). */
function filePath(raw: unknown, files: ConversationFile[]): string {
  const given = text(raw);
  if (!given) return "a file";
  return findFile(files, given)?.name ?? given.replace(/\\/g, "/").replace(/^\/?(sandbox\/)?(\.\/)?/, "");
}

/** A page by its host and path. */
function page(raw: unknown): string {
  const given = text(raw);
  if (!given) return "a page";
  try {
    const url = new URL(given);
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    return shorten(url.hostname.replace(/^www\./, "") + path + url.search, 100);
  } catch {
    return shorten(given, 100);
  }
}

// What comes before the command itself: the folder it runs in, variables, and programs that run it
const CD = /^cd\s+\S+\s*(?:&&|;)\s*/;
const PREFIX = /^(?:cd\s+\S+\s*(?:&&|;)\s*|[A-Za-z_]\w*=\S*\s+|(?:sudo|env|time|nohup|nice)\s+|timeout\s+(?:-\S+\s+)*\d+[smhd]?\s+)/;
const WITH_SUBCOMMAND = new Set(["git", "npm", "npx", "pnpm", "yarn", "pip", "pip3", "uv", "poetry", "cargo", "go", "make", "docker", "conda", "dotnet", "bun", "deno"]);
const INTERPRETERS = new Set(["node", "bash", "sh", "ruby", "perl", "Rscript", "tsx", "ts-node"]);

const strip = (line: string, prefix: RegExp) => {
  let before: string;
  do {
    before = line;
    line = line.replace(prefix, "");
  } while (line !== before);
  return line;
};

/**
 * A command line's program, with what tells its uses apart: the script an
 * interpreter runs, or a subcommand, such as "python verify.py", "git diff",
 * "npm test" or "grep".
 */
function commandKey(line: string): string {
  const words = strip(line, PREFIX)
    .split(/\s*(?:&&|\|\||[;|<>])/)[0]
    .split(/\s+/)
    .map((w) => w.replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  if (!words.length) return "a command";
  const program = baseName(words[0]);
  const rest = words.slice(1);
  const argument = rest.find((w) => !w.startsWith("-"));
  if (INTERPRETERS.has(program) || /^python[\d.]*$/.test(program)) {
    if (rest[0] === "-m" && rest[1]) return `${program} -m ${rest[1]}`;
    if (rest[0] === "-c" || rest[0] === "-") return `${program} ${rest[0]}`;
    return argument ? `${program} ${argument}` : program;
  }
  return WITH_SUBCOMMAND.has(program) && argument ? `${program} ${argument}` : program;
}

/** A shell command as it ran: its first line, without the folder it ran in. */
function command(code: string): { key: string; detail: string } {
  const lines = code
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const line = strip(lines[0] ?? "", CD);
  if (!line) return { key: "`a command`", detail: "a command" };
  return { key: `\`${commandKey(line)}\``, detail: `\`${shorten(line, MAX_TEXT)}\`${lines.length > 1 ? " and more lines" : ""}` };
}

function describe(step: ToolStep, files: ConversationFile[]): Described {
  const { args } = step;
  const file = (key: string) => [filePath(args[key], files)];
  switch (step.toolName) {
    case "read_file":
      return { kind: "read", files: file("file") };
    case "view_image":
    case "view_pdf_pages":
      return { kind: "looked", files: file("file") };
    case "web_read":
    case "web_read_rendered":
      return { kind: "read", text: page(args.url) };
    case "web_screenshot":
      return { kind: "looked", text: page(args.url) };
    case "web_fetch":
      return { kind: "downloaded", text: page(args.url) };
    case "web_search":
      return { kind: "searched", text: `the web for "${shorten(text(args.query), MAX_TEXT)}"` };
    case "search_workspace": {
      const pattern = shorten(text(args.pattern), MAX_TEXT);
      return { kind: "searched", text: args.mode === "paths" ? `files named ${pattern}` : `"${pattern}"` };
    }
    case "read_run_log":
      return { kind: "read", text: text(args.run) ? `the output of ${text(args.run)}` : "a run's output" };
    case "create_file":
    case "create_document":
    case "create_spreadsheet":
      return { kind: "created", files: file("name") };
    case "edit_file":
      return { kind: "edited", files: file("file") };
    case "edit_files": {
      // Models also send the list as JSON text
      const changes = (toList(args.changes) ?? []) as ({ file?: unknown } | null)[];
      return { kind: "edited", files: changes.length ? changes.map((c) => filePath(c?.file, files)) : ["files"] };
    }
    case "undo_file":
      return text(args.changeset) && !text(args.file) ? { kind: "undid", text: `changeset ${text(args.changeset)}` } : { kind: "undid", files: file("file") };
    case "share_file":
      return { kind: "shared", files: file("file") };
    case "install_packages": {
      const packages = Array.isArray(args.packages) ? args.packages.map(text).filter(Boolean) : [];
      const from = text(args.file) ? [`the packages in ${text(args.file)}`] : [];
      return { kind: "installed", text: shorten([...packages, ...from].join(", "), 200) || "packages" };
    }
    case "run_code": {
      const language = languageOf(args.language);
      if (language && language !== "shell") return { kind: "ran", text: `${LANGUAGE_LABELS[language]} code` };
      const { key, detail } = command(text(args.code));
      return { kind: "ran", text: key, detail };
    }
    case "git": {
      const { key, detail } = command(`git ${text(args.command).replace(/^git\s+/, "")}`);
      return { kind: "ran", text: key, detail };
    }
    case "read_result":
      return { kind: "reread", text: `result ${String(args.result ?? "")}`.trim() };
    case "update_notes":
      return { kind: "notes", text: "" };
    default:
      return { kind: "used", text: step.toolName ?? "a tool" };
  }
}

/** What the chat view's label adds to the tool's own, such as "exit code 1" or "files changed meanwhile". */
function noteOf(step: ToolStep): string {
  const def = step.toolName ? getToolDefinition(step.toolName) : undefined;
  if (!def || !step.label) return "";
  for (const state of ["error", "done"] as const) {
    try {
      const own = def.label(step.args, state);
      const note = step.label.startsWith(own) ? step.label.slice(own.length).match(/^ \((.+)\)$/)?.[1] : undefined;
      if (note) return note;
    } catch {
      // A label it cannot make from these arguments: no note
    }
  }
  return "";
}

/**
 * The names files go by: each file's name, with as many of the folders before
 * it as tell it apart from the other files, such as pipeline/utils.py.
 */
function fileNames(paths: string[]): Map<string, string> {
  const unique = [...new Set(paths)];
  const end = (path: string, parts: number) => path.toLowerCase().split("/").slice(-parts).join("/");
  return new Map(
    unique.map((path) => {
      const parts = path.split("/");
      let n = 1;
      while (n < parts.length && unique.some((other) => other !== path && end(other, n) === end(path, n))) n++;
      return [path, parts.slice(-n).join("/")];
    })
  );
}

/** A list of result numbers: the newest, and how many earlier ones are left out. */
function numbers(positions: number[]): string {
  const shown = positions.slice(-MAX_NUMBERS).join(", ");
  const left = positions.length - MAX_NUMBERS;
  return `[${shown}${left > 0 ? `, and ${left} earlier` : ""}]`;
}

/**
 * The lines of the facts about the steps, in order: `recall` is whether the
 * model can read a result again with read_result.
 */
export function toolFacts(steps: ToolStep[], files: ConversationFile[], recall: boolean): string[] {
  if (!steps.length) return [];
  const described = steps.map((step) => {
    const what = describe(step, files);
    const failed = step.error || FAILED_RUNS.includes(step.runStatus ?? "");
    return { step, ...what, failed, note: noteOf(step) };
  });
  const names = fileNames(described.flatMap((d) => d.files ?? []));
  const targets = (d: Described) => (d.files ? d.files.map((f) => names.get(f) ?? f) : [d.text ?? ""]);
  // The step in words, as done or as what it was to do
  const sentence = (d: (typeof described)[number], as: "done" | "to") => {
    const what = d.detail ?? targets(d).join(", ");
    return [KINDS[d.kind][as], what, d.note ? `(${d.note})` : ""].filter(Boolean).join(" ");
  };

  // By what they did, then by target: the result numbers, in order
  const groups = new Map<Kind, Map<string, number[]>>(Object.keys(KINDS).map((kind) => [kind as Kind, new Map()]));
  const failed: { text: string; position: number }[] = [];
  for (const d of described) {
    if (d.failed) {
      failed.push({ text: sentence(d, "to"), position: d.step.position });
      continue;
    }
    const group = groups.get(d.kind)!;
    for (const target of targets(d)) group.set(target, [...(group.get(target) ?? []), d.step.position]);
  }

  const lines = [
    `What you did with tools (${steps.length} step${steps.length === 1 ? "" : "s"}), as llmlynx recorded it.` +
      (recall ? " The numbers in square brackets are result numbers: give one to read_result to get that tool result back in full." : ""),
  ];
  const inOrder = (from: typeof described, indent: string) =>
    from.map((d) => `${indent}- ${d.step.error ? `Could not ${sentence(d, "to")}` : sentence(d, "done")} [${d.step.position}]`);
  // A few steps need no groups: the list of them is short
  if (described.length <= RECENT) return [...lines, ...inOrder(described, "")];
  // The targets used last come first; past the limit, only how many more there are
  const listed = (items: { text: string; last: number; numbers: string }[], max = MAX_TARGETS) => {
    const newest = [...items].sort((a, b) => b.last - a.last);
    const shown = newest.slice(0, max).map((i) => [i.text, i.numbers].filter(Boolean).join(" "));
    return [...shown, ...(newest.length > max ? [`and ${newest.length - max} more`] : [])].join("; ");
  };
  for (const [kind, group] of groups) {
    if (!group.size) continue;
    const items = [...group].map(([target, positions]) => ({ text: target, last: positions[positions.length - 1], numbers: numbers(positions) }));
    lines.push(items.length === 1 && !items[0].text ? `- ${KINDS[kind].done} ${items[0].numbers}` : `- ${KINDS[kind].done}: ${listed(items)}`);
  }
  if (failed.length) {
    lines.push(`- Failed: ${listed(failed.map((f) => ({ text: f.text, last: f.position, numbers: `[${f.position}]` })), MAX_FAILED)}`);
  }
  return [...lines, "- Your last steps, in order:", ...inOrder(described.slice(-RECENT), "  ")];
}
