// The tools agents can call, as the model sees them, and how each maps onto a
// tool of an MCP server. The definitions are provider neutral: see
// toFunctionTools for the format the chat backends send them in.
// The model gets llmlynx's own short schemas rather than the servers' own,
// which have more options than small local models handle well.

import { AGENT_TOOL_INFO, type ToolIcon, type ToolName } from "@/lib/agentTools";
import type { FileCard } from "@/lib/files";
import type { StepSecurity } from "@/lib/types";
import type { ExpectedVersion } from "@/server/files/store";
import type { SecuritySession } from "@/server/security/engine";
import type { ToolServerId } from "./config";
import { checkStart, checkUrl, shortUrl, shorten, toInteger, urlParameter } from "./args";
import { CODE_TOOLS } from "./codeTools";
import { FILE_TOOLS } from "./fileTools";
import type { ToolFile, ToolImage } from "./mcp";
import { MEMORY_TOOLS } from "./memoryTools";
import { SANDBOX_TOOLS } from "./sandboxTools";

export type ToolCapability = "tools" | "vision";

export type ToolState = "running" | "done" | "error";

export type Args = Record<string, unknown>;

/** A run of code or an install of packages, for the sandbox panel's list of runs (the SandboxRun model). */
export type RunRecord = {
  id?: string; // the id the model reads the run's output by (read_run_log)
  kind: "run" | "install";
  language: string;
  code: string;
  output: string;
  status: "ok" | "error" | "timeout" | "stopped" | "withheld" | "blocked" | "skipped";
  durationMs: number;
  printedBytes?: number; // what it printed, also past the output limit, where printing was no longer captured
  files?: { changed: string[]; deleted: string[] };
};

/**
 * What a read_file call showed the model of a file: `from` to `to` of its
 * `total` lines or characters, of the version `fileId`. Kept with the step,
 * for the list of files the model gets and for the pointer that takes the
 * place of the result once it is cleared (see server/chat/reduce.ts).
 */
export type ReadFact = { fileId: string; name: string; unit: "lines" | "characters"; from: number; to: number; total: number };

/**
 * What a tool call gives the model, and what it did to the chat's sandbox:
 * the files it made or changed (`files`, stored as new versions) and deleted
 * (`deletions`, their paths), the files it gives the user (`shared`, which
 * are in the sandbox already), and a git repository's new .git folder
 * (`repository`, stored with the files).
 */
export type ToolResult = {
  text: string;
  images: ToolImage[];
  files: ToolFile[];
  error: boolean;
  note?: string; // why the call failed, shown after its label in the chat view, such as "discarded"
  label?: string; // what the chat view shows for the finished call, in place of the tool's own label
  security?: StepSecurity; // what the security checks found in the result; stored with the tool step
  pause?: { source: string }; // the reply waits for the user's choice about what was flagged: a page's host or a file name
  deletions?: string[];
  shared?: FileCard[];
  // The tool ran the security checks on its result itself, such as a download (see checkFile)
  scanned?: boolean;
  run?: RunRecord;
  repository?: { path: string; git: string }; // git: a gzipped tar, base64
  // The versions the changed files must still have when the result is stored; else nothing is stored (see staleVersions)
  expect?: ExpectedVersion[];
  changeset?: string; // the id of the files an edit_files call changed together, for undo_file
  read?: ReadFact; // read_file: what it showed of which file
};

/**
 * What a call gets besides its arguments. `textBudget` is the most characters
 * of text its result may have. `security` is the chat's security checks (see
 * server/security/engine.ts); without it, nothing is checked.
 */
export type ToolCallContext = {
  userId: string;
  textBudget: number;
  conversationId: string;
  vision: boolean; // the model can see images
  signal: AbortSignal;
  security?: SecuritySession | null;
};

/**
 * What a tool does that the security checks care about. Every tool states
 * both, so a new tool cannot be added without deciding them.
 */
export type ToolEffects = {
  untrustedOutput: boolean; // its result comes from the internet, or from code
  exec: boolean; // runs code in the chat's sandbox: in a tainted chat, the user is asked first
};

/** The tool to call on the MCP server, or an error text for the model when its arguments are unusable. */
export type McpCall = { name: string; arguments: Args } | { error: string };

type ToolBase = {
  name: ToolName;
  icon: ToolIcon;
  description: string;
  parameters: { type: "object"; properties: Record<string, object>; required: string[] };
  server: ToolServerId;
  /** What the base model must support for the tool to be offered. */
  needs: ToolCapability[];
  /** How long a call may take, connecting included. */
  timeoutMs: number;
  effects: ToolEffects;
  /** What the chat view shows for a call while it runs and after. */
  label(args: Args, state: ToolState): string;
};

/**
 * A tool is one call to its MCP server (`toMcpCall`), or does more and runs
 * itself (`run`, which may call the server), such as the file tools, which
 * first look up the conversation's files.
 */
export type ToolDefinition = ToolBase &
  (
    | {
        toMcpCall(args: Args, textBudget: number): McpCall;
        /** Rewrites a successful result's text before the model gets it. */
        finish?(text: string, args: Args, textBudget: number): string;
        run?: never;
      }
    | { run(args: Args, ctx: ToolCallContext): Promise<ToolResult>; toMcpCall?: never; finish?: never }
  );

const MAX_QUERY_LENGTH = 400;
const MAX_SECTION = 10;
const TIME_RANGES = ["day", "week", "month", "year"];

/**
 * Page markdown from mcp-searxng without its images ("![alt](url)", also
 * inside links), which tell the model nothing and use up the text budget.
 */
function withoutImages(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[\s*\]\([^)]*\)/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

const isImageSearch = (args: Args) => args.images === true || args.images === "true";

/**
 * Image results from mcp-searxng's full format, with only what the model
 * needs: the lines about scores, engines and categories go, and "Image
 * Source" becomes "Image".
 */
function imageResults(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^(Relevance Score|Engines|Category):/.test(line))
    .map((line) => line.replace(/^Image Source:/, "Image:"))
    .join("\n");
}

const startParameter = {
  type: "integer",
  description: "For long pages: the character to start reading at, as the previous result says. Default 0",
};

const WEB_TOOLS: ToolDefinition[] = [
  {
    name: "web_search",
    icon: AGENT_TOOL_INFO.web_search.icon,
    description:
      "Search the web. Returns the titles, URLs and short descriptions of the top results. " +
      "Use it for current events, recent facts and anything you are not sure about, and to find pages to read. " +
      "With images set to true it finds pictures instead, and each result also gives the URL of the image file itself.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for, as you would type it into a search engine" },
        time_range: {
          type: "string",
          enum: TIME_RANGES,
          description: "Only results from the last day, week, month or year. Leave out for any time",
        },
        images: { type: "boolean", description: "true to search for pictures. Default false" },
      },
      required: ["query"],
    },
    server: "search",
    needs: ["tools"],
    timeoutMs: 30_000,
    effects: { untrustedOutput: true, exec: false },
    label(args, state) {
      const query = typeof args.query === "string" && args.query.trim() ? `: ${shorten(args.query)}` : "";
      const what = isImageSearch(args) ? "the web for images" : "the web";
      if (state === "running") return `Searching ${what}${query}`;
      return state === "done" ? `Searched ${what}${query}` : `Could not search ${what}${query}`;
    },
    toMcpCall(args) {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return { error: "query is required." };
      if (query.length > MAX_QUERY_LENGTH) return { error: `query is too long (at most ${MAX_QUERY_LENGTH} characters).` };
      const timeRange = typeof args.time_range === "string" && TIME_RANGES.includes(args.time_range) ? args.time_range : undefined;
      // Only the full results have the image file's URL ("Image Source")
      const kind = isImageSearch(args) ? { categories: "images", result_detail: "full" } : { result_detail: "compact" };
      return {
        name: "searxng_web_search",
        arguments: { query, num_results: 8, ...kind, ...(timeRange ? { time_range: timeRange } : {}) },
      };
    },
    finish(text, args) {
      return isImageSearch(args) ? imageResults(text) : text;
    },
  },
  {
    name: "web_read",
    icon: AGENT_TOOL_INFO.web_read.icon,
    description:
      "Read a web page, PDF or text file as text. Fast, but the page's JavaScript does not run. " +
      "Long pages come in parts; the result says which start to use for the next part.",
    parameters: {
      type: "object",
      properties: { url: urlParameter, start: startParameter },
      required: ["url"],
    },
    server: "search",
    needs: ["tools"],
    timeoutMs: 30_000,
    effects: { untrustedOutput: true, exec: false },
    label(args, state) {
      const page = shortUrl(args.url);
      if (state === "running") return `Reading ${page}`;
      return state === "done" ? `Read ${page}` : `Could not read ${page}`;
    },
    toMcpCall(args, textBudget) {
      const url = checkUrl(args.url);
      if ("error" in url) return url;
      const start = checkStart(args.start);
      if ("error" in start) return start;
      return { name: "web_url_read", arguments: { url: url.url, startChar: start.start, maxLength: textBudget } };
    },
    finish(text, args, textBudget) {
      // mcp-searxng cuts a long page off at maxLength without saying so
      const start = toInteger(args.start) ?? 0;
      const end = start + text.length;
      const more =
        text.length >= textBudget - 10
          ? `\n\n[Characters ${start} to ${end} of the page. There is probably more: call web_read with start=${end} for the next part.]`
          : "";
      return withoutImages(text) + more;
    },
  },
  {
    name: "web_read_rendered",
    icon: AGENT_TOOL_INFO.web_read_rendered.icon,
    description:
      "Open a web page in a real browser, scroll through it, and read the text it shows, with its links. " +
      "Slower than reading the page directly; use it for pages that build their content with JavaScript " +
      "or load it while scrolling.",
    parameters: {
      type: "object",
      properties: { url: urlParameter, start: startParameter },
      required: ["url"],
    },
    server: "browser",
    needs: ["tools"],
    timeoutMs: 60_000,
    effects: { untrustedOutput: true, exec: false },
    label(args, state) {
      const page = shortUrl(args.url);
      if (state === "running") return `Reading ${page} in a browser`;
      return state === "done" ? `Read ${page} in a browser` : `Could not read ${page} in a browser`;
    },
    toMcpCall(args, textBudget) {
      const url = checkUrl(args.url);
      if ("error" in url) return url;
      const start = checkStart(args.start);
      if ("error" in start) return start;
      return { name: "browser_read", arguments: { url: url.url, start: start.start, maxChars: textBudget } };
    },
  },
  {
    name: "web_screenshot",
    icon: AGENT_TOOL_INFO.web_screenshot.icon,
    description:
      "Open a web page in a real browser and look at a screenshot of one screen of it. Use it when the " +
      "layout, images or charts matter, or for content that only shows in a browser. Section 1 is the top " +
      "of the page; each next section is one screen further down, and content that loads on scroll appears.",
    parameters: {
      type: "object",
      properties: {
        url: urlParameter,
        section: { type: "integer", description: `Which screen of the page, 1 to ${MAX_SECTION}. Default 1` },
      },
      required: ["url"],
    },
    server: "browser",
    needs: ["tools", "vision"],
    timeoutMs: 60_000,
    effects: { untrustedOutput: true, exec: false },
    label(args, state) {
      const section = toInteger(args.section);
      const where = shortUrl(args.url) + (section && section > 1 ? `, section ${section}` : "");
      if (state === "running") return `Taking a screenshot of ${where}`;
      return state === "done" ? `Took a screenshot of ${where}` : `Could not take a screenshot of ${where}`;
    },
    toMcpCall(args) {
      const url = checkUrl(args.url);
      if ("error" in url) return url;
      const section = toInteger(args.section);
      if (section === null || (section !== undefined && (section < 1 || section > MAX_SECTION))) {
        return { error: `section must be a whole number from 1 to ${MAX_SECTION}.` };
      }
      return { name: "browser_screenshot", arguments: { url: url.url, section: section ?? 1 } };
    },
  },
];

export const TOOL_DEFINITIONS: ToolDefinition[] = [...WEB_TOOLS, ...FILE_TOOLS, ...CODE_TOOLS, ...SANDBOX_TOOLS, ...MEMORY_TOOLS];

/** The tools in the format of the `tools` request field, which Ollama, Chat Completions and OpenRouter share. */
export function toFunctionTools(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** The tools in the format of the `tools` request field of OpenAI's Responses API. */
export function toResponsesTools(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict: false,
  }));
}

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((d) => d.name === name);
}

/** The label of a call to `name`, also for tools that no longer exist. */
export function toolLabel(name: string, args: Args, state: ToolState): string {
  const def = getToolDefinition(name);
  if (def) return def.label(args, state);
  return state === "error" ? `Could not use ${name}` : `Used ${name}`;
}

/**
 * Most characters of text one tool result may have: about a quarter of the
 * model's context (at roughly 3.5 characters per token), within limits.
 */
export function textBudget(numCtx: unknown): number {
  const tokens = typeof numCtx === "number" && numCtx > 0 ? numCtx : 2048;
  return Math.round(Math.min(12_000, Math.max(1_500, tokens * 0.25 * 3.5)));
}
