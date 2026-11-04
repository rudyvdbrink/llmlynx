// Loading, scrolling and capturing pages. Pages are scrolled one viewport at a
// time, with a pause at each step, so content that loads on scroll appears.

import type { Page } from "playwright";
import { checkUrl, ToolError } from "./url.js";
import { withPage } from "./browser.js";

const NAV_TIMEOUT_MS = 20_000;
// After loading and after each scroll step: how long to wait for the network to go quiet
const SETTLE_MS = 4_000;
const STEP_SETTLE_MS = 1_500;
const STEP_PAUSE_MS = 400;
export const MAX_SECTION = 10;
// browser_read scrolls through at most this many viewports
const MAX_READ_STEPS = 15;
const MAX_LINKS = 40;

type PageInfo = { url: string; title: string; status: number | null };
type ScrollState = { top: number; section: number; sections: number | null; atEnd: boolean };

// Content types a browser shows as a page. Anything else would be a download or a file viewer.
const PAGE_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain|application\/xml|text\/xml)\b/i;

async function settle(page: Page, ms: number) {
  await page.waitForLoadState("networkidle", { timeout: ms }).catch(() => {});
}

async function open(page: Page, raw: string): Promise<PageInfo> {
  const url = await checkUrl(raw);
  let response;
  try {
    response = await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  } catch (err) {
    const message = (err as Error).message || "";
    if (/download is starting/i.test(message)) {
      throw new ToolError("This URL is a file to download, not a web page; downloads are turned off. Use web_read for PDFs and text files.");
    }
    if (/timeout/i.test(message)) throw new ToolError(`The page did not load within ${NAV_TIMEOUT_MS / 1000} seconds.`);
    // net::ERR_NAME_NOT_RESOLVED, net::ERR_CONNECTION_RESET (the proxy refused it), ...
    const code = /net::(ERR_[A-Z_]+)/.exec(message)?.[1];
    throw new ToolError(`The page could not be loaded${code ? ` (${code})` : ""}.`);
  }
  const type = response?.headers()["content-type"] || "";
  if (type && !PAGE_TYPES.test(type)) {
    throw new ToolError(`This URL is not a web page (${type.split(";")[0]}). Use web_read for PDFs and text files.`);
  }
  await settle(page, SETTLE_MS);
  return { url: page.url(), title: (await page.title().catch(() => "")) || "", status: response?.status() ?? null };
}

// Where the page is scrolled to. Uses the window, or for pages that scroll an
// inner element instead, the largest element that scrolls.
function readScroll(page: Page): Promise<ScrollState> {
  return page.evaluate(() => {
    const doc = document.scrollingElement || document.documentElement;
    let main: Element | null = doc.scrollHeight > window.innerHeight + 4 ? doc : null;
    if (!main) {
      let largest = 0;
      for (const el of document.querySelectorAll("body *")) {
        if (el.scrollHeight <= el.clientHeight + 4 || el.clientHeight < 200) continue;
        if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY)) continue;
        const area = el.clientHeight * el.clientWidth;
        if (area > largest) [largest, main] = [area, el];
      }
    }
    if (!main) return { top: 0, section: 1, sections: 1, atEnd: true };
    const height = main === doc ? window.innerHeight : main.clientHeight;
    return {
      top: main.scrollTop,
      section: Math.floor(main.scrollTop / height + 0.01) + 1,
      sections: Math.ceil(main.scrollHeight / height - 0.01),
      atEnd: main.scrollTop + height >= main.scrollHeight - 4,
    };
  });
}

// Scrolls down one viewport like a user would (a wheel event where the user's
// pointer would be), so that lazy loading and infinite scroll react.
async function scrollStep(page: Page) {
  const { width, height } = page.viewportSize() ?? { width: 1280, height: 900 };
  await page.mouse.move(width / 2, height / 2);
  await page.mouse.wheel(0, height);
  await page.waitForTimeout(STEP_PAUSE_MS);
  await settle(page, STEP_SETTLE_MS);
}

function describe(info: PageInfo): string {
  const lines = [`Title: ${info.title || "(none)"}`, `URL: ${info.url}`];
  if (info.status && info.status >= 400) lines.push(`The site answered with status ${info.status}.`);
  return lines.join("\n");
}

export type Screenshot = { text: string; jpeg: Buffer };

/** A screenshot of the viewport at `section` (1 is the top of the page). */
export function screenshotPage(rawUrl: string, section = 1): Promise<Screenshot> {
  return withPage(async (page) => {
    const info = await open(page, rawUrl);
    let state = await readScroll(page);
    while (state.section < section && !state.atEnd) {
      await scrollStep(page);
      const next = await readScroll(page);
      if (next.top === state.top) break; // the page did not scroll
      state = next;
    }
    const jpeg = await page.screenshot({ type: "jpeg", quality: 70, animations: "disabled", caret: "hide" });
    const where =
      state.sections && state.sections > 1
        ? `Section ${state.section} of about ${state.sections}.`
        : "The whole page fits in one section.";
    const more = state.atEnd
      ? "This is the end of the page."
      : `There is more below: call again with section=${Math.min(state.section + 1, MAX_SECTION)}.`;
    const short = section > state.section ? ` (section ${section} was asked for, but the page ends here)` : "";
    return { text: `${describe(info)}\n${where}${short} ${more}`, jpeg };
  });
}

/** The page's text after rendering and scrolling to the end, with its links. */
export function readPage(rawUrl: string, start = 0, maxChars = 20_000): Promise<string> {
  return withPage(
    async (page) => {
      const info = await open(page, rawUrl);
      let state = await readScroll(page);
      for (let i = 0; i < MAX_READ_STEPS && !state.atEnd; i++) {
        await scrollStep(page);
        const next = await readScroll(page);
        if (next.top === state.top) break; // the page did not scroll
        state = next;
      }
      const { text, links } = await page.evaluate((maxLinks) => {
        const body = document.body;
        const main = document.querySelector("main, article, [role=main]") as HTMLElement | null;
        // The main content when the page marks it, unless that leaves most of the text out
        const root = main && main.innerText.length > body.innerText.length * 0.3 ? main : body;
        const seen = new Set<string>();
        const found: { text: string; href: string }[] = [];
        for (const a of root.querySelectorAll("a[href]")) {
          const href = (a as HTMLAnchorElement).href;
          const label = (a as HTMLElement).innerText.replace(/\s+/g, " ").trim().slice(0, 80);
          if (!label || !/^https?:/.test(href) || seen.has(href)) continue;
          seen.add(href);
          found.push({ text: label, href });
          if (found.length >= maxLinks) break;
        }
        return { text: root.innerText.replace(/\n{3,}/g, "\n\n").trim(), links: found };
      }, MAX_LINKS);

      const full = text + (links.length ? `\n\nLinks:\n${links.map((l) => `- [${l.text}](${l.href})`).join("\n")}` : "");
      const part = full.slice(start, start + maxChars);
      const rest = full.length - (start + part.length);
      const note =
        start >= full.length
          ? `The page has ${full.length} characters; start=${start} is past the end.`
          : rest > 0
            ? `[Characters ${start} to ${start + part.length} of ${full.length}. Call again with start=${start + part.length} for more.]`
            : "";
      return `${describe(info)}\n\n${part}${note ? `\n\n${note}` : ""}`;
    },
    { textOnly: true }
  );
}
