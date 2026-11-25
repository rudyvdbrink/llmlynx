// web_fetch: downloads a file from a URL into the chat's sandbox, such as a
// dataset or a report, so code can work on it. The download runs in the
// browser container, whose traffic goes through the egress proxy (see
// tools/browser/src/fetch.ts): not in the app, which could reach the LAN, nor
// in the code container, which has no network. A file that is not what its
// name says, such as a web page saved as photo.jpg, is not stored. The file is
// checked as a file from the internet (checkFile): a virus discards it, an
// injection withholds it and pauses the reply, and one that could not be
// checked is not stored.

import { baseName, cleanFilePath, extensionOf, fileKind, formatSize, mimeTypeOf, typeLabel } from "@/lib/files";
import { sniffType } from "@/server/files/sniff";
import { conversationFiles, fileData, findFile } from "@/server/files/store";
import { checkFile, flaggedResult } from "@/server/security/engine";
import { hostOf } from "@/server/security/urls";
import { checkUrl } from "@/server/tools/args";
import { getToolServer } from "@/server/tools/config";
import type { Args, ToolCallContext, ToolResult } from "@/server/tools/definitions";
import { callMcpTool } from "@/server/tools/mcp";
import { roomError } from "./room";

export const FETCH_TIMEOUT_MS = 90_000;

const failure = (text: string): ToolResult => ({ text: `Error: ${text}`, images: [], files: [], error: true });

/** An error the browser server returned, without the prefix the MCP SDK adds. */
const serverError = (text: string) => text.replace(/^error( executing tool [\w-]+)?:\s*/i, "").trim();

/**
 * The name to store a download under, or why it is not stored. A name that
 * promises an image or a PDF must hold one: one of another of these types gets
 * the right extension, anything else is refused. A web page is only stored
 * under an HTML name. A name without an extension gets one for an image or a
 * PDF. `type` is the type the server gave.
 */
export function fitName(name: string, data: Buffer, type: string): { name: string } | { error: string } {
  const real = sniffType(data);
  const hasExtension = baseName(name).includes(".");
  const ext = hasExtension ? extensionOf(name).replace(/^jpeg$/, "jpg") : "";
  const promised = ext === "pdf" || fileKind(name) === "image";
  const notIt = (what: string) =>
    `the URL gave ${what}, not the ${typeLabel(name)} file itself, so nothing was kept. Use the URL of the file itself, ` +
    "such as the link to it on the page, which often ends in its extension.";
  if (real === "html" && ext !== "html" && ext !== "htm") return { error: notIt("a web page") };
  if (real && real !== "html" && real !== ext && (promised || !hasExtension)) {
    return { name: `${hasExtension ? name.slice(0, name.lastIndexOf(".")) : name}.${real}` };
  }
  if (promised && real !== ext) return { error: notIt(type ? `a file of type ${type}` : "another kind of file") };
  return { name };
}

/** Downloads `args.url` into the sandbox, as `args.name` or the file's own name. Throws only when the chat is stopped. */
export async function webFetch(args: Args, ctx: ToolCallContext): Promise<ToolResult> {
  const checked = checkUrl(args.url);
  if ("error" in checked) return failure(checked.error);
  const security = ctx.security;
  if (!security) return failure("the download could not be checked, so it was not kept.");
  let wantedName: string | null = null;
  if (typeof args.name === "string" && args.name.trim()) {
    wantedName = cleanFilePath(args.name);
    if (!wantedName) return failure("name must be a file name in the sandbox, such as data.csv or input/data.csv.");
  }

  let out;
  try {
    out = await callMcpTool(getToolServer("browser"), "browser_fetch", { url: checked.url }, { signal: ctx.signal, timeoutMs: FETCH_TIMEOUT_MS });
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    console.error(`web_fetch failed: ${(err as Error)?.message || err}`);
    return failure("the download did not answer. It may be down; try again later.");
  }
  if (out.isError) return failure(serverError(out.text) || "the file could not be downloaded.");
  const [file] = out.files;
  if (!file) return failure("the download returned no file.");
  const about = JSON.parse(out.text) as { url?: string; type?: string; name?: string };
  const finalUrl = about.url ?? checked.url;
  const host = hostOf(finalUrl) ?? "the internet";
  const data = Buffer.from(file.data, "base64");
  if (!data.length) return failure("the file is empty.");
  const fitted = fitName(wantedName ?? cleanFilePath(about.name ?? file.name) ?? "download", data, about.type ?? "");
  if ("error" in fitted) return failure(fitted.error);
  const { name } = fitted;

  const files = await conversationFiles(ctx.conversationId);
  const same = findFile(files, name);
  if (same && same.name.toLowerCase() === name.toLowerCase() && same.size === data.length && (await fileData(same.id)).equals(data)) {
    return {
      text: `${finalUrl} has not changed since it was downloaded to ${same.name}: the sandbox has it already.`,
      images: [],
      files: [],
      error: false,
      scanned: true,
    };
  }
  const full = roomError(files, [{ name, size: data.length }]);
  if (full) return failure(full);

  // Checked as a file from the internet: a virus, then its text for prompt injections
  const check = await checkFile({
    data,
    name,
    source: "internet",
    audit: security.audit,
    signal: ctx.signal,
    tool: "web_fetch",
    host: hostOf(finalUrl),
  });
  if (check.outcome === "virus") return flaggedResult("virus", host);
  if (check.outcome === "unchecked") return flaggedResult("unchecked", host);
  if (check.outcome === "injection") {
    security.context.tainted = true;
    return flaggedResult("injection", host, check);
  }

  const kind = typeLabel(name);
  const head = [`Downloaded ${finalUrl} to ${name} in the sandbox (${formatSize(data.length)}, ${kind}).`];
  if (check.text?.trim()) {
    const room = Math.max(500, ctx.textBudget - 400);
    const start = check.text.slice(0, room);
    head.push(
      start.length < check.text.length
        ? `The start of its text (${start.length} of ${check.text.length} characters):\n${start}`
        : `Its text:\n${start}`
    );
  } else if (fileKind(name) === "image") {
    head.push(ctx.vision ? "It is an image: look at it with view_image." : "It is an image.");
  } else {
    head.push(check.info?.error ? `Its text could not be read: ${check.info.error}` : "It has no text.");
  }
  return {
    text: head.join("\n\n"),
    images: [],
    files: [
      {
        name,
        mimeType: mimeTypeOf(name),
        data: file.data,
        origin: "internet",
        text: check.text,
        info: check.info,
        scanned: true,
      },
    ],
    error: false,
    scanned: true,
  };
}
