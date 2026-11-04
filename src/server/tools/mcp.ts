// Calls tools on the MCP servers over Streamable HTTP.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolServer } from "./config";

export type ToolImage = { mimeType: string; data: string }; // data: base64

/** What a tool returned: its text, any images, and whether it reported an error. */
export type ToolOutput = { text: string; images: ToolImage[]; isError: boolean };

type ContentItem = { type?: string; text?: unknown; data?: unknown; mimeType?: unknown };

/**
 * Calls the tool `name` on `server`. Each call has a connection of its own:
 * the servers are stateless and on the same machine, so this costs little.
 * Throws when the server cannot be reached or does not answer within `timeoutMs`.
 */
export async function callMcpTool(
  server: ToolServer,
  name: string,
  args: Record<string, unknown>,
  { signal, timeoutMs }: { signal: AbortSignal; timeoutMs: number }
): Promise<ToolOutput> {
  const client = new Client({ name: "llmlynx", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: server.token ? { Authorization: `Bearer ${server.token}` } : {} },
  });
  try {
    await client.connect(transport, { signal, timeout: timeoutMs });
    const result = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: timeoutMs });
    const content: ContentItem[] = Array.isArray(result.content) ? result.content : [];
    return {
      text: content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("\n\n"),
      images: content
        .filter((c) => c.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string")
        .map((c) => ({ mimeType: c.mimeType as string, data: c.data as string })),
      isError: result.isError === true,
    };
  } finally {
    await client.close().catch(() => {});
  }
}
