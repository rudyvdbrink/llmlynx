// One headless Chromium for all tool calls. Each call gets a fresh context
// (no cookies, storage or service workers survive it), and at most
// BROWSER_MAX_CONCURRENCY pages are open at a time.

import { chromium, type Browser, type Page } from "playwright";
import { ToolError } from "./url.js";

const PROXY = process.env.EGRESS_PROXY || "";
const MAX_CONCURRENCY = Math.max(1, Number(process.env.BROWSER_MAX_CONCURRENCY) || 1);
// A whole tool call, from waiting for a free slot to the last screenshot byte
const CALL_TIMEOUT_MS = Number(process.env.BROWSER_CALL_TIMEOUT_MS) || 45_000;
// Waiting for a free slot counts towards the call timeout; give up a little earlier
const QUEUE_TIMEOUT_MS = CALL_TIMEOUT_MS - 5_000;

const [VIEWPORT_WIDTH, VIEWPORT_HEIGHT] = (process.env.BROWSER_VIEWPORT || "1280x900").split("x").map(Number);
export const VIEWPORT = { width: VIEWPORT_WIDTH || 1280, height: VIEWPORT_HEIGHT || 900 };

let browser: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  browser ??= chromium
    .launch({
      headless: true,
      chromiumSandbox: true,
      // Everything, loopback included, goes through the egress proxy
      proxy: PROXY ? { server: PROXY, bypass: "<-loopback>" } : undefined,
      args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-dev-shm-usage"],
    })
    .then((b) => {
      b.on("disconnected", () => (browser = null));
      return b;
    })
    .catch((err) => {
      browser = null;
      throw err;
    });
  return browser;
}

// Sites that block "HeadlessChrome" get the user agent of a normal Chrome of the same version
function userAgent(b: Browser): string {
  const major = b.version().split(".")[0];
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

let active = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENCY) {
    active++;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.splice(waiting.indexOf(go), 1);
      reject(new ToolError("The browser is busy with other pages. Try again in a moment."));
    }, QUEUE_TIMEOUT_MS);
    const go = () => {
      clearTimeout(timer);
      active++;
      resolve();
    };
    waiting.push(go);
  });
}

function release() {
  active--;
  waiting.shift()?.();
}

/**
 * Runs `fn` with a new page in a fresh context, and closes the context after.
 * With `textOnly`, images, media and fonts are not loaded. A call that takes
 * longer than the call timeout is stopped by closing its context.
 */
export async function withPage<T>(fn: (page: Page) => Promise<T>, { textOnly = false } = {}): Promise<T> {
  const started = Date.now();
  await acquire();
  try {
    const b = await getBrowser();
    const context = await b.newContext({
      viewport: VIEWPORT,
      userAgent: userAgent(b),
      locale: "en-US",
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      context.close().catch(() => {});
    }, CALL_TIMEOUT_MS - (Date.now() - started));
    try {
      if (textOnly) {
        await context.route("**/*", (route) =>
          ["image", "media", "font"].includes(route.request().resourceType()) ? route.abort() : route.continue()
        );
      }
      return await fn(await context.newPage());
    } catch (err) {
      if (timedOut) throw new ToolError(`The page took longer than ${CALL_TIMEOUT_MS / 1000} seconds and was stopped.`);
      throw err;
    } finally {
      clearTimeout(timer);
      await context.close().catch(() => {});
    }
  } finally {
    release();
  }
}
