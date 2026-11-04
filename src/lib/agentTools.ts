// Tools a custom agent can be given, each turned on with its own checkbox on
// the agents page. Shared by the agents API (validation), the agents page and
// the chat view (icons). What each tool does is in server/tools/definitions.ts.

export const AGENT_TOOLS = ["web_search", "web_read", "web_read_rendered", "web_screenshot"] as const;

export type AgentToolName = (typeof AGENT_TOOLS)[number];

export type ToolIcon = "globe" | "spanner";

export const AGENT_TOOL_INFO: Record<AgentToolName, { label: string; help: string; icon: ToolIcon }> = {
  web_search: {
    label: "Web search",
    help: "Searches the web and gets back titles, links and short descriptions.",
    icon: "globe",
  },
  web_read: {
    label: "Read pages",
    help: "Reads a web page, PDF or text file as text. Fast, but does not run the page's JavaScript.",
    icon: "globe",
  },
  web_read_rendered: {
    label: "Read pages with JavaScript",
    help: "Opens a page in a browser and scrolls through it before reading it. Slower; for pages that build their content with JavaScript or load it on scroll.",
    icon: "globe",
  },
  web_screenshot: {
    label: "Screenshots",
    help: "Opens a page in a browser and looks at a screenshot of it, one screen at a time. Needs a base model that can see images.",
    icon: "spanner",
  },
};

export function isAgentTool(value: unknown): value is AgentToolName {
  return typeof value === "string" && (AGENT_TOOLS as readonly string[]).includes(value);
}

/** The icon for a tool step in the chat view; tools added later get the spanner. */
export function toolIcon(name: string): ToolIcon {
  return isAgentTool(name) ? AGENT_TOOL_INFO[name].icon : "spanner";
}

/**
 * The agent's tools from a request or the database: known names only, without
 * duplicates, in the order of AGENT_TOOLS. null and undefined mean none.
 */
export function validateAgentTools(
  input: unknown
): { ok: true; value: AgentToolName[] } | { ok: false; message: string } {
  if (input == null) return { ok: true, value: [] };
  if (!Array.isArray(input)) return { ok: false, message: "tools must be a list of tool names" };
  const unknown = input.find((name) => !isAgentTool(name));
  if (unknown !== undefined) return { ok: false, message: `Unknown tool: ${String(unknown)}` };
  return { ok: true, value: AGENT_TOOLS.filter((name) => input.includes(name)) };
}

// Most tool calls an agent may make for one reply (the slider on the agents page)
export const DEFAULT_MAX_TOOL_CALLS = 7;
export const MAX_TOOL_CALLS_LIMIT = 20;

/** The agent's most tool calls per reply: a whole number from 1 to 20; undefined means the default. */
export function validateMaxToolCalls(input: unknown): { ok: true; value: number } | { ok: false; message: string } {
  if (input === undefined || input === null) return { ok: true, value: DEFAULT_MAX_TOOL_CALLS };
  if (typeof input !== "number" || !Number.isInteger(input) || input < 1 || input > MAX_TOOL_CALLS_LIMIT) {
    return { ok: false, message: `maxToolCalls must be a whole number from 1 to ${MAX_TOOL_CALLS_LIMIT}` };
  }
  return { ok: true, value: input };
}

/** Which of its tools an agent can use with its base model, as returned by GET /api/tools. */
export type ToolAvailability = { name: AgentToolName; available: boolean; reason?: string };
