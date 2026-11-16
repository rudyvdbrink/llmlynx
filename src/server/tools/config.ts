// The MCP servers behind the agent tools and the guard. They are part of the
// app: docker-compose.yml always runs them, and the app finds them where it
// publishes them. An environment variable only moves one, for example when the
// containers run on another host. The guard is not a tool of the model: the
// security checks call it (see guardServer in server/security/config.ts).

export type ToolServerId = "search" | "browser" | "files" | "guard";

export type ToolServer = { id: ToolServerId; url: string; token?: string };

const SERVERS: Record<ToolServerId, { url: string; urlEnv: string; tokenEnv: string }> = {
  search: { url: "http://127.0.0.1:8790/mcp", urlEnv: "SEARCH_MCP_URL", tokenEnv: "SEARCH_MCP_TOKEN" }, // mcp-searxng
  browser: { url: "http://127.0.0.1:8791/mcp", urlEnv: "BROWSER_MCP_URL", tokenEnv: "BROWSER_MCP_TOKEN" }, // tools/browser
  files: { url: "http://127.0.0.1:8792/mcp", urlEnv: "FILES_MCP_URL", tokenEnv: "FILES_MCP_TOKEN" }, // tools/files
  guard: { url: "http://127.0.0.1:8793/mcp", urlEnv: "GUARD_MCP_URL", tokenEnv: "GUARD_MCP_TOKEN" }, // tools/guard
};

/** The server's address and bearer token. */
export function getToolServer(id: ToolServerId): ToolServer {
  const { url, urlEnv, tokenEnv } = SERVERS[id];
  return { id, url: process.env[urlEnv]?.trim() || url, token: process.env[tokenEnv]?.trim() || undefined };
}
