// The checks that run before a tool call. Each is a small synchronous
// function on data that is already in memory; a new check is one more entry
// in PRE_CALL_CHECKS.

import type { Args, ToolEffects } from "@/server/tools/definitions";
import { contentHash } from "./audit";
import type { SecurityContext } from "./context";
import { exfilSignal, hostOf, normalizeUrl } from "./urls";

/**
 * What a check says about a call: "allow", "warn" (logged, nothing changes)
 * or "block", with a reason code for the audit log and, for a block, what the
 * model and the tool line are told.
 */
export type Verdict = {
  verdict: "allow" | "warn" | "block";
  check: "url";
  reason: string;
  message?: string; // block: what the model gets as the call's result
  note?: string; // block: why, shown after the call's label in the chat view
  host?: string | null;
  contentHash?: string;
};

/** A tool call that is about to run. */
export type ToolAction = { tool: { name: string; effects: ToolEffects }; args: Args };

export type PreCallCheck = (action: ToolAction, context: SecurityContext) => Verdict | null;

const RANK = { allow: 0, warn: 1, block: 2 } as const;

/** The strictest of the verdicts, the first of equals; null when there is none. */
export function strictest(verdicts: (Verdict | null)[]): Verdict | null {
  let worst: Verdict | null = null;
  for (const verdict of verdicts) {
    if (verdict && (!worst || RANK[verdict.verdict] > RANK[worst.verdict])) worst = verdict;
  }
  return worst;
}

/** What the model is told when its URL is blocked: how to go on by itself. */
function blockedUrlMessage(webSearch: boolean): string {
  const how = webSearch ? "Find the page with web_search and open the URL from the results, or answer without it." : "Answer without it.";
  return `Blocked: this URL does not come from the user or from a search result. ${how}`;
}

/**
 * The URL rules, for tools that request a URL the model chose. A URL that is
 * in the conversation (the user's messages and files, and the tool results)
 * is allowed. Any other URL is blocked when it looks like it carries data
 * out, or when the conversation is tainted; otherwise it is allowed with a
 * warning in the log, as models make up plain URLs all the time.
 */
export const urlRules: PreCallCheck = ({ tool, args }, context) => {
  if (!tool.effects.fetchesUrl || typeof args.url !== "string") return null;
  const url = normalizeUrl(args.url);
  if (!url) return null; // the tool itself says what is wrong with it
  if (context.knownUrls.has(url)) return null;

  const about = { check: "url" as const, host: hostOf(url), contentHash: contentHash(url) };
  const message = blockedUrlMessage(context.webSearch);
  if (exfilSignal(url, context.sharedText)) {
    return { ...about, verdict: "block", reason: "url_exfil", message, note: "blocked: the URL may carry data out" };
  }
  if (context.tainted) {
    return { ...about, verdict: "block", reason: "url_unknown_tainted", message, note: "blocked: unknown URL" };
  }
  return { ...about, verdict: "warn", reason: "url_unknown" };
};

export const PRE_CALL_CHECKS: PreCallCheck[] = [urlRules];
