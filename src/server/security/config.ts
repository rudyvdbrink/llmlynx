// The security layer's settings, from the environment (see .env.example and
// docs/security.md).

import { getToolServer, type ToolServer } from "@/server/tools/config";

// Where docker-compose.yml publishes the scanners
const GUARD_URL = "http://127.0.0.1:8793/mcp";
const CLAMAV_HOST = "127.0.0.1";
const CLAMAV_PORT = 3310;

/**
 * The guard (tools/guard), which scans text for prompt injections. The
 * security checks are part of the app: no setting switches them off or leaves
 * a scanner out, and content a scanner cannot check is withheld.
 */
export function guardServer(): ToolServer {
  return getToolServer("guard") ?? { id: "guard", url: GUARD_URL, token: process.env.GUARD_MCP_TOKEN?.trim() || undefined };
}

/** Where clamd, the virus scanner, listens. */
export function clamavServer(): { host: string; port: number } {
  const port = Number(process.env.CLAMAV_PORT);
  return { host: process.env.CLAMAV_HOST?.trim() || CLAMAV_HOST, port: Number.isInteger(port) && port > 0 ? port : CLAMAV_PORT };
}

/** What keeps the security checks from running in full, for the log when the server starts. */
export function setupWarnings(): string[] {
  return guardServer().token
    ? []
    : ["GUARD_MCP_TOKEN is not set: the guard refuses the app, so content from the internet is withheld."];
}
