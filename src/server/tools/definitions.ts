// The tools agents can call, as the model sees them, and how each maps onto a
// tool of an MCP server. The definitions are provider neutral: see
// toFunctionTools for the format the chat backends send them in.
// The model gets llmlynx's own short schemas rather than the servers' own,
// which have more options than small local models handle well.

import { AGENT_TOOL_INFO, type AgentToolName, type ToolIcon } from "@/lib/agentTools";
import type { ToolServerId } from "./config";

export type ToolCapability = "tools" | "vision";

export type ToolState = "running" | "done" | "error";

type Args = Record<string, unknown>;

/** The tool to call on the MCP server, or an error text for the model when its arguments are unusable. */
type McpCall = { name: string; arguments: Args } | { error: string };

export type ToolDefinition = {
  name: AgentToolName;
  icon: ToolIcon;
  description: string;
  parameters: { type: "object"; properties: Record<string, object>; required: string[] };
  server: ToolServerId;
  /** What the base model must support for the tool to be offered. */
  needs: ToolCapability[];
  /** How long a call may take, connecting included. */
  timeoutMs: number;
  /** What the chat view shows for a call while it runs and after. */
  label(args: Args, state: ToolState): string;
  /** `textBudget` is the most characters of text the result may have. */
  toMcpCall(args: Args, textBudget: number): McpCall;
  /** Rewrites a successful result's text before the model gets it. */
  finish?(text: string, args: Args, textBudget: number): string;
};

const MAX_QUERY_LENGTH = 400;
const MAX_LABEL_LENGTH = 60;
const MAX_SECTION = 10;
const TIME_RANGES = ["day", "week", "month", "year"];

function shorten(text: string, max = MAX_LABEL_LENGTH): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** "https://www.example.com/a/b?c" -> "example.com/a/b", for labels. */
function shortUrl(raw: unknown): string {
  if (typeof raw !== "string") return "a page";
  try {
    const url = new URL(raw);
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    return shorten(url.hostname.replace(/^www\./, "") + path, 48);
  } catch {
    return shorten(raw, 48);
  }
}

/** Models sometimes send numbers as strings. Returns undefined when `raw` is absent. */
function toInteger(raw: unknown): number | undefined | null {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "string" ? Number(raw.trim()) : raw;
  return typeof n === "number" && Number.isInteger(n) ? n : null;
}

/** The URL to give a tool, or an error text. The MCP servers block private addresses themselves. */
function checkUrl(raw: unknown): { url: string } | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { error: "url is required." };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { error: `Not a valid URL: ${raw}. Use a full URL that starts with https://.` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "Only http and https URLs can be opened." };
  if (url.username || url.password) return { error: "URLs with a user name or password cannot be opened." };
  return { url: url.href };
}

function checkStart(raw: unknown): { start: number } | { error: string } {
  const start = toInteger(raw);
  if (start === null || (start !== undefined && start < 0)) return { error: "start must be a whole number, 0 or more." };
  return { start: start ?? 0 };
}

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

const urlParameter = { type: "string", description: "The full URL, starting with https:// or http://" };
const startParameter = {
  type: "integer",
  description: "For long pages: the character to start reading at, as the previous result says. Default 0",
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "web_search",
    icon: AGENT_TOOL_INFO.web_search.icon,
    description:
      "Search the web. Returns the titles, URLs and short descriptions of the top results. " +
      "Use it for current events, recent facts and anything you are not sure about, and to find pages to read.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for, as you would type it into a search engine" },
        time_range: {
          type: "string",
          enum: TIME_RANGES,
          description: "Only results from the last day, week, month or year. Leave out for any time",
        },
      },
      required: ["query"],
    },
    server: "search",
    needs: ["tools"],
    timeoutMs: 30_000,
    label(args, state) {
      const query = typeof args.query === "string" && args.query.trim() ? `: ${shorten(args.query)}` : "";
      if (state === "running") return `Searching the web${query}`;
      return state === "done" ? `Searched the web${query}` : `Could not search the web${query}`;
    },
    toMcpCall(args) {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return { error: "query is required." };
      if (query.length > MAX_QUERY_LENGTH) return { error: `query is too long (at most ${MAX_QUERY_LENGTH} characters).` };
      const timeRange = typeof args.time_range === "string" && TIME_RANGES.includes(args.time_range) ? args.time_range : undefined;
      return {
        name: "searxng_web_search",
        arguments: { query, num_results: 8, result_detail: "compact", ...(timeRange ? { time_range: timeRange } : {}) },
      };
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

/** The tools in the format of the `tools` request field, which Ollama, OpenAI and OpenRouter share. */
export function toFunctionTools(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
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
