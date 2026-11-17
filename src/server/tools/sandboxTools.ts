// The agent tools of the chat's sandbox: downloading files into it
// (web_fetch), running code in it (run_code), installing packages for that
// code (install_packages), git on its repositories (git), giving the user
// one of its files (share_file), and undoing a change to one (undo_file).
// The work is in server/sandbox. See definitions.ts for what a tool definition is.

import { AGENT_TOOL_INFO } from "@/lib/agentTools";
import { formatSize } from "@/lib/files";
import { conversationFiles, fileData, fileVersions, findFile, undoTarget } from "@/server/files/store";
import { installPackages, registryOf, REGISTRY_LABELS } from "@/server/sandbox/install";
import { sandboxRoomError } from "@/server/sandbox/room";
import { LANGUAGE_LABELS, LANGUAGES, languageOf, runCode } from "@/server/sandbox/runCode";
import { FETCH_TIMEOUT_MS, webFetch } from "@/server/sandbox/webFetch";
import { GIT_TIMEOUT_MS, INSTALL_TIMEOUT_MS, RUN_TIMEOUT_MS } from "@/server/sandbox/code";
import { runGit, splitCommand } from "@/server/sandbox/git";
import { shortUrl, shorten, urlParameter } from "./args";
import type { Args, ToolCallContext, ToolDefinition, ToolResult, ToolState } from "./definitions";
import { missingFile } from "./fileTools";
import type { ToolFile } from "./mcp";

const failure = (text: string): ToolResult => ({ text: `Error: ${text}`, images: [], files: [], error: true });

const fileName = (args: Args, key: string) => (typeof args[key] === "string" && args[key].trim() ? shorten(args[key], 48) : "a file");

/** What a run_code call runs, for its label: the language, or for a command its first line. */
function runWhat(args: Args): string {
  const language = languageOf(args.language);
  if (language !== "shell") return `${language ? LANGUAGE_LABELS[language] : "code"}`;
  const line = typeof args.code === "string" ? args.code.trim().split("\n")[0] : "";
  return line ? `\`${shorten(line, 48)}\`` : "a command";
}

/** The packages an install_packages call asks for, for its label. */
function installWhat(args: Args): string {
  const packages = Array.isArray(args.packages) ? args.packages.filter((p): p is string => typeof p === "string") : [];
  const from = typeof args.file === "string" && args.file.trim() ? [`the packages in ${shorten(args.file, 40)}`] : [];
  const what = [...packages.map((p) => p.trim()), ...from].join(", ");
  return what ? shorten(what, 120) : "packages";
}

/** A git call's label: the repository a clone downloads, or the command. */
function gitLabel(args: Args, state: ToolState): string {
  const text = typeof args.command === "string" ? args.command.trim().replace(/^git\s+/, "") : "";
  const words = splitCommand(text);
  const url = !("error" in words) && words[0] === "clone" ? words.slice(1).find((w) => w.startsWith("https://")) : undefined;
  if (url) {
    const where = shortUrl(url);
    if (state === "running") return `Cloning ${where}`;
    return state === "done" ? `Cloned ${where}` : `Could not clone ${where}`;
  }
  const what = text ? `\`git ${shorten(text, 48)}\`` : "git";
  if (state === "running") return `Running ${what}`;
  return state === "done" ? `Ran ${what}` : `Could not run ${what}`;
}

export const SANDBOX_TOOLS: ToolDefinition[] = [
  {
    name: "web_fetch",
    icon: AGENT_TOOL_INFO.web_fetch.icon,
    description:
      "Download a file from a URL into this chat's sandbox, such as a CSV dataset, a PDF report, a spreadsheet or " +
      "an image, so that code can work on it or you can share it with the user (at most 20 MB). Use the URL of the " +
      "file itself, not of a page that shows it. You get its name in the sandbox, its size and type, and the start " +
      "of its text. To read a web page, use web_read instead.",
    parameters: {
      type: "object",
      properties: {
        url: urlParameter,
        name: {
          type: "string",
          description: "Where to put it in the sandbox, such as data/sales.csv. Default: the file's own name",
        },
      },
      required: ["url"],
    },
    server: "browser",
    needs: ["tools"],
    timeoutMs: FETCH_TIMEOUT_MS + 200_000, // with the scans of the file, as one from the internet (up to 3 minutes)
    effects: { untrustedOutput: true, exec: false },
    label(args, state) {
      const what = shortUrl(args.url);
      if (state === "running") return `Downloading ${what}`;
      return state === "done" ? `Downloaded ${what}` : `Could not download ${what}`;
    },
    run: webFetch,
  },
  {
    name: "run_code",
    icon: AGENT_TOOL_INFO.run_code.icon,
    description:
      "Run code in this chat's sandbox: Python, JavaScript, TypeScript, or a shell command line (bash), such as " +
      "pytest or npm test. It runs in the sandbox folder, which holds the chat's files; files it writes there are " +
      "kept, in folders too, and every tool can use them by name afterwards. Only files survive a run, not " +
      "variables: save what you need to a file. There is no network: download data with web_fetch first. Built in: " +
      "numpy, pandas, scipy, matplotlib, openpyxl, pillow and pytest for Python; install others with " +
      "install_packages. Limits: 120 seconds, 512 MB of memory, 1 MB of output. Images, SVG and HTML files it " +
      "saves show in the chat; HTML pages cannot load anything from the internet, so put their scripts and data " +
      "in the page. You get whether it succeeded, what it printed, and which files it made, changed or deleted.",
    parameters: {
      type: "object",
      properties: {
        language: { type: "string", enum: [...LANGUAGES], description: "python, javascript, typescript or shell" },
        code: { type: "string", description: "The code, or for shell the command lines" },
      },
      required: ["language", "code"],
    },
    server: "code",
    needs: ["tools"],
    timeoutMs: RUN_TIMEOUT_MS + 60_000, // with the scans before and after
    effects: { untrustedOutput: true, exec: true },
    label(args, state) {
      const what = runWhat(args);
      if (state === "running") return `Running ${what}`;
      return state === "done" ? `Ran ${what}` : `Could not run ${what}`;
    },
    run: runCode,
  },
  {
    name: "install_packages",
    icon: AGENT_TOOL_INFO.install_packages.icon,
    description:
      "Install packages for this chat's runs of code: from PyPI for Python, or from npm for JavaScript and " +
      "TypeScript. Name them, with a version if you want one (pandas==2.2.3, lodash@^4.17), or name a " +
      "requirements.txt or package.json in the sandbox. Only use it when the built-in libraries do not have what " +
      "you need. Python packages install only as ready-built wheels, and npm packages without their install " +
      "scripts: packages that need a build step or an install script do not work. They stay installed for this chat.",
    parameters: {
      type: "object",
      properties: {
        registry: { type: "string", enum: ["pypi", "npm"], description: "pypi (Python) or npm (JavaScript and TypeScript)" },
        packages: { type: "array", items: { type: "string" }, description: "The packages, such as [\"seaborn\", \"tabulate==0.9.0\"]" },
        file: { type: "string", description: "A requirements.txt or package.json in the sandbox, to install what it lists" },
      },
      required: ["registry"],
    },
    server: "code",
    needs: ["tools"],
    timeoutMs: INSTALL_TIMEOUT_MS + 30_000,
    effects: { untrustedOutput: true, exec: true },
    label(args, state) {
      const what = installWhat(args);
      const registry = registryOf(args.registry);
      const from = registry ? ` from ${REGISTRY_LABELS[registry]}` : "";
      if (state === "running") return `Installing ${what}${from}`;
      return state === "done" ? `Installed ${what}` : `Could not install ${what}`;
    },
    run: installPackages,
  },
  {
    name: "git",
    icon: AGENT_TOOL_INFO.git.icon,
    description:
      "Run a git command on a repository in this chat's sandbox; the only way to use git here. Such as clone https://github.com/user/repo, " +
      "status, log --oneline -10, diff, add -A, commit -m \"message\", checkout -b feature, merge or pull. A " +
      "repository is a folder of the sandbox: its files are files of the sandbox, which every tool can read and " +
      "change, but its .git folder is not in the sandbox: only this tool sees it. Only public https:// repositories can be cloned, fetched and pulled, and nothing can be pushed. One " +
      "command per call, without shell operators such as && or |.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The git command, such as \"log --oneline -5\" or \"clone https://github.com/user/repo\"" },
        repo: { type: "string", description: "The repository's folder in the sandbox. Only needed when there are several" },
      },
      required: ["command"],
    },
    server: "code",
    needs: ["tools"],
    timeoutMs: GIT_TIMEOUT_MS + 200_000, // with the scan of what it brought
    effects: { untrustedOutput: true, exec: false },
    label: gitLabel,
    run: runGit,
  },
  {
    name: "share_file",
    icon: "file",
    description:
      "Give the user a file of this chat's sandbox: it shows as a file card below your reply, from which they open " +
      "or download it. Use it when the user asks for a file, or when a run made a file the user asked for, rather " +
      "than downloading or making it again. To show the user images from the web, download them with web_fetch " +
      "and share each one: downloads do not show in the chat until shared. Images, SVG and HTML that a run saves " +
      "show in the chat already: do not share those.",
    parameters: {
      type: "object",
      properties: { file: { type: "string", description: "The file's name in the sandbox, as in the list of this conversation's files" } },
      required: ["file"],
    },
    server: "files",
    needs: ["tools"],
    timeoutMs: 10_000,
    effects: { untrustedOutput: false, exec: false },
    label(args: Args, state: ToolState) {
      const name = fileName(args, "file");
      if (state === "running") return `Sharing ${name}`;
      return state === "done" ? `Shared ${name}` : `Could not share ${name}`;
    },
    async run(args, ctx) {
      const files = await conversationFiles(ctx.conversationId);
      const file = findFile(files, args.file);
      if (!file) return failure(missingFile(args.file, files));
      return {
        text: `${file.name} is shared with the user: it shows as a file card below your reply. Do not write a link to it.`,
        images: [],
        files: [],
        error: false,
        shared: [{ id: file.id, name: file.name, mimeType: file.mimeType, size: file.size }],
      };
    },
  },
  {
    name: "undo_file",
    icon: "file",
    description:
      "Undo the last change to a file of this chat's sandbox, made by a run of code, an edit, git or a download: the " +
      "file goes back to the version before it, also when it was deleted. Call it again to go further back.",
    parameters: {
      type: "object",
      properties: { file: { type: "string", description: "The file's name in the sandbox, also of a deleted file" } },
      required: ["file"],
    },
    server: "files",
    needs: ["tools"],
    timeoutMs: 10_000,
    effects: { untrustedOutput: false, exec: false },
    label(args: Args, state: ToolState) {
      const name = fileName(args, "file");
      if (state === "running") return `Undoing the last change to ${name}`;
      return state === "done" ? `Undid the last change to ${name}` : `Could not undo the change to ${name}`;
    },
    run: undoFile,
  },
];

/** Puts a file of the sandbox back to its version before the current one, as a new version. */
async function undoFile(args: Args, ctx: ToolCallContext): Promise<ToolResult> {
  const versions = await fileVersions(ctx.conversationId, args.file);
  if (!versions) return failure(missingFile(args.file, await conversationFiles(ctx.conversationId)));
  const current = versions[versions.length - 1];
  const target = undoTarget(versions);
  if (!target) return failure(`${current.name} has no earlier version to go back to. To remove it, delete it with run_code.`);
  const data = await fileData(target.id);
  const full = await sandboxRoomError(ctx.conversationId, [{ name: current.name, size: data.length }]);
  if (full) return failure(full);
  const origin = target.origin === "code" || target.origin === "internet" ? target.origin : undefined;
  const file: ToolFile = {
    name: current.name,
    mimeType: target.mimeType,
    data: data.toString("base64"),
    text: target.text,
    info: target.info,
    restoredFrom: target.id,
    ...(origin ? { origin } : {}),
  };
  const what = current.deleted ? "back, as it was before it was deleted" : "back to its previous version";
  // What the next undo would go back to
  const further = undoTarget(versions.slice(0, versions.indexOf(target) + 1));
  return {
    text:
      `Undone: ${current.name} is ${what} (${formatSize(data.length)}).` +
      (further ? " Call undo_file again to go further back." : " It has no earlier version."),
    images: [],
    files: [file],
    error: false,
  };
}
