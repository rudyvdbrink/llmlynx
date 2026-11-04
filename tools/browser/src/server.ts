// MCP server (stateless Streamable HTTP on POST /mcp) with two tools:
// browser_screenshot and browser_read. Every /mcp request needs the bearer
// token from MCP_AUTH_TOKEN. GET /health answers without one.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { MAX_SECTION, readPage, screenshotPage } from "./page.js";
import { ToolError } from "./url.js";

const PORT = Number(process.env.PORT) || 8080;
const TOKEN = process.env.MCP_AUTH_TOKEN || "";
const MAX_BODY_BYTES = 1024 * 1024;

if (!TOKEN) {
  console.error("MCP_AUTH_TOKEN is not set; not starting without a token.");
  process.exit(1);
}

// Compares hashes, so the comparison takes as long whatever the token's length
const digest = (s: string) => createHash("sha256").update(s).digest();
const TOKEN_DIGEST = digest(`Bearer ${TOKEN}`);
const authorized = (req: IncomingMessage) => timingSafeEqual(digest(req.headers.authorization || ""), TOKEN_DIGEST);

type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

// Errors meant for the model become its tool result; anything else is logged and kept vague
async function run(name: string, fn: () => Promise<ToolContent[]>) {
  try {
    return { content: await fn() };
  } catch (err) {
    if (!(err instanceof ToolError)) console.error(`${name} failed:`, err);
    const text = err instanceof ToolError ? err.message : "The browser failed to open this page.";
    return { content: [{ type: "text" as const, text }], isError: true };
  }
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "llmlynx-browser", version: "1.0.0" });

  server.registerTool(
    "browser_screenshot",
    {
      description:
        "Opens a web page in a browser (JavaScript runs) and returns a screenshot of one screen of it. " +
        "Section 1 is the top of the page; each next section is one screen further down. The page is " +
        "scrolled to get there, so content that loads on scroll appears.",
      inputSchema: {
        url: z.string().describe("The http or https URL to open"),
        section: z.number().int().min(1).max(MAX_SECTION).optional().describe("Which screen of the page, 1 to 10. Default 1"),
      },
    },
    ({ url, section }) =>
      run("browser_screenshot", async () => {
        const shot = await screenshotPage(url, section ?? 1);
        return [
          { type: "text", text: shot.text },
          { type: "image", data: shot.jpeg.toString("base64"), mimeType: "image/jpeg" },
        ];
      })
  );

  server.registerTool(
    "browser_read",
    {
      description:
        "Opens a web page in a browser (JavaScript runs), scrolls to its end so content that loads on " +
        "scroll appears, and returns the text it shows, with its links.",
      inputSchema: {
        url: z.string().describe("The http or https URL to open"),
        start: z.number().int().min(0).optional().describe("Character to start at, for long pages. Default 0"),
        maxChars: z.number().int().min(500).max(100_000).optional().describe("Most characters to return. Default 20000"),
      },
    },
    ({ url, start, maxChars }) =>
      run("browser_read", async () => [{ type: "text", text: await readPage(url, start ?? 0, maxChars ?? 20_000) }])
  );

  return server;
}

function send(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const rpcError = (message: string) => ({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });

createServer(async (req, res) => {
  const path = (req.url || "/").split("?")[0];
  if (path === "/health" && req.method === "GET") return send(res, 200, { status: "ok" });
  if (path !== "/mcp") return send(res, 404, { error: "Not found" });
  if (!authorized(req)) return send(res, 401, rpcError("Unauthorized"));
  // Stateless: no sessions, so no GET streams and nothing to DELETE
  if (req.method !== "POST") return send(res, 405, rpcError("Method not allowed"));

  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    return send(res, 400, rpcError("Invalid request body"));
  }

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) send(res, 500, rpcError("Internal error"));
  }
}).listen(PORT, "0.0.0.0", () => console.log(`llmlynx-browser listening on :${PORT}`));
