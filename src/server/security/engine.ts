// The security layer's entry point, used by runTool (server/tools/run.ts)
// and by the upload path (server/files/uploads.ts). It guards against three
// things: text from the internet that tries to instruct the model (prompt
// injection), URLs that carry conversation data out, and malware. See
// docs/security.md for what happens on each detection.
//
// Before a tool call, synchronous checks run on what is in memory
// (checks.ts). After a call of a tool whose result comes from the internet,
// the result is scanned (scan.ts) before the model gets anything. A file is
// checked once, when it arrives (checkFile).

import { fileKind } from "@/lib/files";
import type { PauseDecision, StepSecurity } from "@/lib/types";
import { prisma } from "@/server/db/prisma";
import { convertFile } from "@/server/files/convert";
import type { FileInfo } from "@/server/files/store";
import type { Args, ToolDefinition, ToolResult } from "@/server/tools/definitions";
import type { AuditLog } from "./audit";
import { PRE_CALL_CHECKS, strictest, type PreCallCheck } from "./checks";
import { contextFromSteps, type SecurityContext } from "./context";
import { FILE_GUARD_TIMEOUT_MS, TOOL_SCAN_TIMEOUT_MS, UPLOAD_VIRUS_TIMEOUT_MS } from "./limits";
import { openPause } from "./pause";
import { scanInjection, scanVirus } from "./scan";
import { hostOf } from "./urls";

/** The security checks of one chat request: what they know about the conversation, and their log. */
export type SecuritySession = { userId: string; context: SecurityContext; audit: AuditLog };

/** What the model gets, and what is stored, in place of content that looked like a prompt injection. */
export const WITHHELD_NOTICE = "Withheld by llmlynx: the content looked like instructions aimed at the model.";

// Unicode tag characters are invisible and can carry a hidden prompt
const TAG_CHARACTERS = /[\u{E0000}-\u{E007F}]/gu;

/**
 * Starts the checks of a chat request in `conversationId`, with one query for
 * the stored conversation. Returns the session for the tool calls, or null
 * when the chat has no tools.
 */
export async function openSecurity({
  userId,
  conversationId,
  tools,
  audit,
}: {
  userId: string;
  conversationId: string;
  tools: Pick<ToolDefinition, "name">[];
  audit: AuditLog;
}): Promise<SecuritySession | null> {
  if (!tools.length) return null;
  const steps = await prisma.message.findMany({
    where: { conversationId, role: { in: ["user", "tool"] } },
    orderBy: { position: "asc" },
    select: {
      role: true,
      content: true,
      metadata: true,
      attachments: { where: { parentId: null, name: { not: null } }, select: { text: true } },
    },
  });
  return { userId, audit, context: contextFromSteps(steps, tools.some((tool) => tool.name === "web_search")) };
}

/**
 * The checks before a tool call: no I/O, only what is in memory. Returns the
 * error result the model gets when the call is blocked, or null when it may
 * run. A warning is only logged.
 */
export function checkBeforeCall(
  def: ToolDefinition,
  args: Args,
  session: SecuritySession,
  checks: PreCallCheck[] = PRE_CALL_CHECKS
): ToolResult | null {
  const action = { tool: def, args };
  const verdict = strictest(checks.map((check) => check(action, session.context)));
  if (!verdict || verdict.verdict === "allow") return null;

  const blocked = verdict.verdict === "block";
  session.audit.add({
    tool: def.name,
    check: verdict.check,
    verdict: blocked ? "block" : "warn",
    reason: verdict.reason,
    host: verdict.host,
    contentHash: verdict.contentHash,
  });
  if (!blocked) return null;
  return { text: verdict.message ?? "Blocked by llmlynx.", images: [], files: [], error: true, note: verdict.note ?? "blocked" };
}

/**
 * What a tool call returns in place of flagged content from the internet,
 * following the detection table: a virus is discarded, a prompt injection is
 * withheld and pauses the reply for the user's choice, and content that could
 * not be checked is withheld. `source` is what was flagged: a page's host, or
 * a file name.
 */
export function flaggedResult(flag: StepSecurity["flag"], source: string, score?: number): ToolResult {
  const none = { images: [], files: [], error: true };
  if (flag === "virus") {
    return {
      ...none,
      text: "Error: discarded: the content was flagged as malware; use another source.",
      note: "discarded",
      security: { flag, source },
    };
  }
  if (flag === "unchecked") {
    return {
      ...none,
      text: "Error: the content could not be checked; try again later or answer without it.",
      note: "not checked",
      security: { flag, source },
    };
  }
  return {
    ...none,
    text: WITHHELD_NOTICE,
    note: "withheld",
    security: { flag, source, ...(score !== undefined ? { score } : {}) },
    pause: { source },
  };
}

/**
 * The checks after a tool call. The result of a tool whose output comes from
 * the internet is scanned for a prompt injection and for malware, in
 * parallel; the model gets it only when both pass (see `flaggedResult`
 * otherwise). Every result the model gets adds its URLs to the known ones.
 * Throws only when `signal` aborts.
 */
export async function checkAfterCall(
  def: ToolDefinition,
  args: Args,
  result: ToolResult,
  session: SecuritySession,
  signal: AbortSignal
): Promise<ToolResult> {
  const { context, audit } = session;
  if (!def.effects.untrustedOutput) {
    context.addToolResult(result.text);
    return result;
  }

  const text = result.text.replace(TAG_CHARACTERS, "");
  const host = hostOf(args.url);
  const scan = { timeoutMs: TOOL_SCAN_TIMEOUT_MS, signal, audit, tool: def.name, host };
  const [injection, ...viruses] = await Promise.all([
    scanInjection(text, scan),
    scanVirus(Buffer.from(text), scan),
    ...result.images.map((image) => scanVirus(Buffer.from(image.data, "base64"), scan)),
  ]);
  const source = host ?? def.name.replace(/_/g, " ");

  if (viruses.some((virus) => virus.status === "flagged")) return flaggedResult("virus", source);
  if (injection.status === "flagged") {
    context.tainted = true;
    return flaggedResult("injection", source, injection.score);
  }
  if (injection.status === "unchecked" || viruses.some((virus) => virus.status === "unchecked")) {
    return flaggedResult("unchecked", source);
  }

  context.addToolResult(text);
  return { ...result, text };
}

/**
 * Waits for the user's choice about flagged content that paused the reply:
 * "remove" (go on without it) or "stop". `announce` gets the id under which
 * the choice can be sent (see server/security/pause.ts). No choice in time,
 * or a stopped chat, counts as "stop".
 */
export async function awaitDecision({
  session,
  tool,
  host,
  signal,
  announce,
}: {
  session: SecuritySession;
  tool: string;
  host: string | null;
  signal: AbortSignal;
  announce: (pauseId: string) => void;
}): Promise<PauseDecision> {
  const pause = openPause(session.userId, signal);
  announce(pause.id);
  const decision = await pause.decision;
  session.audit.add({
    tool,
    check: "decision",
    verdict: "block",
    reason: "injection",
    host,
    decision: decision === "remove" ? "remove_and_continue" : "stop",
  });
  return decision;
}

/** Where a file comes from: attached by the user, or fetched from the internet by a tool. */
export type FileSource = "user" | "internet";

/**
 * The outcome of a file's check, with what the detection table says happens
 * (`action`): a virus refuses a user's file and discards one from the
 * internet; a prompt injection withholds a file from the internet with the
 * pause dialog, so it comes without its text; a file that could not be
 * checked is refused or withheld. For a file from the internet,
 * `flaggedResult` turns the outcome into the tool's result.
 */
export type FileCheck =
  | { outcome: "clean"; text: string | null; info: FileInfo | null }
  | { outcome: "injection"; action: "pause"; score: number }
  | { outcome: "virus"; action: "refuse" | "discard"; signature: string }
  | { outcome: "unchecked"; action: "refuse" | "withhold" };

/**
 * Checks a file, for any source: the virus scan and the conversion to text
 * run in parallel on the bytes, and a virus stops the conversion. The text of
 * a file from the internet is then scanned for a prompt injection. A file the
 * user attached is not: it is the user's own, and the scan of a large file
 * takes minutes. `text` is the file as the model reads it (null for an image,
 * and for a file that cannot be converted: `info.error` says why). Throws
 * only when `signal` aborts.
 */
export async function checkFile({
  data,
  name,
  source,
  audit,
  signal,
}: {
  data: Uint8Array;
  name: string;
  source: FileSource;
  audit: AuditLog;
  signal: AbortSignal;
}): Promise<FileCheck> {
  const user = source === "user";
  const unchecked: FileCheck = { outcome: "unchecked", action: user ? "refuse" : "withhold" };

  const stop = new AbortController();
  const stopped = AbortSignal.any([signal, stop.signal]);
  const converting = fileKind(name) === "image" ? null : convertFile(name, data, stopped);
  // Until it is awaited below, so a failure after a virus was found is not left unhandled
  converting?.catch(() => {});
  const virus = await scanVirus(data, { timeoutMs: UPLOAD_VIRUS_TIMEOUT_MS, signal, audit });
  if (virus.status !== "clean") {
    stop.abort();
    return virus.status === "flagged" ? { outcome: "virus", action: user ? "refuse" : "discard", signature: virus.signature } : unchecked;
  }

  let converted: { text: string | null; info: FileInfo | null } = { text: null, info: null };
  if (converting) {
    try {
      converted = await converting;
    } catch (err) {
      if (signal.aborted) throw err;
      // The files server did not answer: the file cannot be read now
      console.error(`Converting ${name} failed: ${(err as Error)?.message || err}`);
      return unchecked;
    }
  }
  const { text, info } = converted;
  if (user || !text) return { outcome: "clean", text, info };

  const injection = await scanInjection(text, { timeoutMs: FILE_GUARD_TIMEOUT_MS, signal, audit });
  if (injection.status === "flagged") return { outcome: "injection", action: "pause", score: injection.score };
  if (injection.status === "unchecked") return unchecked;
  return { outcome: "clean", text, info };
}
