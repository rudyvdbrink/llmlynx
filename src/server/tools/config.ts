// The MCP servers behind the agent tools, from the environment (see
// docker-compose.yml). Tools whose server is not set up are left out.

export type ToolServerId = "search" | "browser" | "files";

export type ToolServer = { id: ToolServerId; url: string; token?: string };

const ENV: Record<ToolServerId, { url: string; token: string }> = {
  search: { url: "SEARCH_MCP_URL", token: "SEARCH_MCP_TOKEN" }, // mcp-searxng
  browser: { url: "BROWSER_MCP_URL", token: "BROWSER_MCP_TOKEN" }, // tools/browser
  files: { url: "FILES_MCP_URL", token: "FILES_MCP_TOKEN" }, // tools/files
};

/** The server's address and bearer token, or null when it is not set up. */
export function getToolServer(id: ToolServerId): ToolServer | null {
  const url = process.env[ENV[id].url]?.trim();
  if (!url) return null;
  return { id, url, token: process.env[ENV[id].token]?.trim() || undefined };
}
