// Downloads a file for web_fetch, through the egress proxy like all of this
// container's traffic: the proxy refuses private, loopback and LAN addresses,
// redirects included. No browser is involved: the file comes as it is, at most
// MAX_BYTES within TIMEOUT_MS, and nothing runs.

import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import { checkUrl, ToolError } from "./url.js";

const PROXY = process.env.EGRESS_PROXY || "";
export const MAX_BYTES = 20 * 1024 * 1024;
const TOO_LARGE = "The file is larger than 20 MB, which is too large.";
const TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export type Download = { url: string; status: number; type: string; name: string; data: Buffer };

const HEADERS = { "User-Agent": USER_AGENT, Accept: "*/*", "Accept-Encoding": "identity" };

/** Opens a tunnel to `url`'s server through the proxy (CONNECT), for HTTPS. */
function tunnel(url: URL, proxy: URL, signal: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const port = url.port || "443";
    const req = http.request({ host: proxy.hostname, port: proxy.port, method: "CONNECT", path: `${url.hostname}:${port}`, signal });
    req.on("connect", (res, socket) => {
      if (res.statusCode === 200) return resolve(socket);
      socket.destroy();
      reject(new ToolError(`${url.hostname} cannot be reached from here.`));
    });
    req.on("error", reject);
    req.end();
  });
}

/** One GET of `url` through the proxy, without following redirects. */
async function get(url: URL, signal: AbortSignal): Promise<http.IncomingMessage> {
  if (!PROXY) throw new Error("EGRESS_PROXY is not set");
  const proxy = new URL(PROXY);
  if (url.protocol === "http:") {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: proxy.hostname, port: proxy.port, method: "GET", path: url.href, headers: { ...HEADERS, Host: url.host }, signal },
        resolve
      );
      req.on("error", reject);
      req.end();
    });
  }
  const socket = await tunnel(url, proxy, signal);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: url.hostname,
        path: url.pathname + url.search,
        method: "GET",
        headers: { ...HEADERS, Host: url.host },
        agent: false,
        createConnection: () => tls.connect({ socket, servername: url.hostname }),
        signal,
      },
      resolve
    );
    req.on("error", reject);
    req.end();
  });
}

/** The body, or a ToolError when it is larger than MAX_BYTES. */
async function readBody(res: http.IncomingMessage): Promise<Buffer> {
  const declared = Number(res.headers["content-length"]);
  if (declared > MAX_BYTES) {
    res.destroy();
    throw new ToolError(TOO_LARGE);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res) {
    size += chunk.length;
    if (size > MAX_BYTES) {
      res.destroy();
      throw new ToolError(TOO_LARGE);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * The file as it is, from a body sent with `encoding` (Content-Encoding):
 * some servers compress it although they were asked not to. At most
 * MAX_BYTES once unpacked.
 */
export function decodeBody(body: Buffer, encoding: string | undefined): Buffer {
  const codings = (encoding ?? "")
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding && coding !== "identity");
  let data = body;
  // The last coding was applied last, so it comes off first
  for (const coding of codings.reverse()) {
    const options = { maxOutputLength: MAX_BYTES };
    try {
      if (coding === "gzip" || coding === "x-gzip") data = zlib.gunzipSync(data, options);
      else if (coding === "br") data = zlib.brotliDecompressSync(data, options);
      else if (coding === "deflate") {
        // Servers send "deflate" with and without its zlib header
        try {
          data = zlib.inflateSync(data, options);
        } catch {
          data = zlib.inflateRawSync(data, options);
        }
      } else throw new ToolError(`The server sent the file packed as ${coding}, which cannot be unpacked.`);
    } catch (err) {
      if (err instanceof ToolError) throw err;
      if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw new ToolError(TOO_LARGE);
      throw new ToolError("The server sent the file packed, and it could not be unpacked.");
    }
  }
  return data;
}

const EXTENSIONS: Record<string, string> = {
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "application/json": "json",
  "application/pdf": "pdf",
  "text/html": "html",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/xml": "xml",
  "text/xml": "xml",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/zip": "zip",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/** The file's name: from Content-Disposition, else the last part of the URL's path, with an extension from its type. */
export function fileName(disposition: string | undefined, url: URL, type: string): string {
  let name = "";
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition ?? "");
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(disposition ?? "");
  try {
    name = star ? decodeURIComponent(star[1].trim()) : plain ? plain[1].trim() : decodeURIComponent(url.pathname.split("/").pop() ?? "");
  } catch {
    name = "";
  }
  name = name.replace(/[\\/\u0000-\u001f]/g, "").trim() || "download";
  const extension = EXTENSIONS[type];
  return extension && !name.includes(".") ? `${name}.${extension}` : name;
}

/** Downloads `rawUrl`, following up to MAX_REDIRECTS redirects. Throws a ToolError meant for the model. */
export async function download(rawUrl: string): Promise<Download> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let url = await checkUrl(rawUrl);
  try {
    for (let hop = 0; ; hop++) {
      const res = await get(url, signal);
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (hop >= MAX_REDIRECTS) throw new ToolError("The URL redirects too often.");
        url = await checkUrl(new URL(res.headers.location, url).href);
        continue;
      }
      if (status === 429) {
        res.resume();
        throw new ToolError("The server answered with status 429: too many downloads from here. Do not ask it for this file again now; use another source.");
      }
      if (status >= 400) {
        res.resume();
        throw new ToolError(`The server answered with status ${status}.`);
      }
      const type = String(res.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim().toLowerCase();
      const data = decodeBody(await readBody(res), res.headers["content-encoding"]);
      return { url: url.href, status, type, name: fileName(res.headers["content-disposition"], url, type), data };
    }
  } catch (err) {
    if (err instanceof ToolError) throw err;
    if (signal.aborted) throw new ToolError(`The download took longer than ${TIMEOUT_MS / 1000} seconds and was stopped.`);
    const code = (err as { code?: string }).code;
    throw new ToolError(`The file could not be downloaded${code ? ` (${code})` : ""}.`);
  }
}
