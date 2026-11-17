// The security layer's entry point, used by runTool (server/tools/run.ts)
// and by the upload path (server/files/uploads.ts). It guards against two
// things: text from the internet that tries to instruct the model (prompt
// injection), and malware. See docs/security.md for what happens on each
// detection.
//
// After a call of a tool whose result comes from the internet, the result is
// scanned (scan.ts) before the model gets anything. A file is checked once,
// when it arrives (checkFile).

import { fileKind } from "@/lib/files";
import type { ApprovalDecision, PauseDecision, StepSecurity } from "@/lib/types";
import { prisma } from "@/server/db/prisma";
import { convertFile } from "@/server/files/convert";
import { isUntrusted, rememberedScan, rememberScan, type ConversationFile, type FileInfo } from "@/server/files/store";
import type { Args, ToolDefinition, ToolResult } from "@/server/tools/definitions";
import { contentHash, type AuditLog } from "./audit";
import { contextFromSteps, type SecurityContext } from "./context";
import { FILE_GUARD_TIMEOUT_MS, TOOL_SCAN_TIMEOUT_MS, UPLOAD_VIRUS_TIMEOUT_MS } from "./limits";
import { openPause } from "./pause";
import { scanInjection, scanVirus } from "./scan";
import { hostOf } from "./urls";

/** The security checks of one chat request: what they know about the conversation, and their log. */
export type SecuritySession = { userId: string; context: SecurityContext; audit: AuditLog };

/** What the model gets, and what is stored, in place of content that looked like a prompt injection. */
export const WITHHELD_NOTICE = "Withheld by llmlynx: the content looked like instructions aimed at the model.";

// What the dialogs call content that is not from a web page: "Text from the code's output looks like ..."
const SOURCES: Record<string, string> = {
  run_code: "the code's output",
  install_packages: "the install's report",
  git: "git's output",
};

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
  const steps = await prisma.message.findMany({ where: { conversationId, role: "tool" }, select: { metadata: true } });
  return { userId, audit, context: contextFromSteps(steps) };
}

/**
 * What a tool call returns in place of flagged content from the internet,
 * following the detection table: a virus is discarded, a prompt injection is
 * withheld and pauses the reply for the user's choice, and content that could
 * not be checked is withheld. `source` is what was flagged: a page's host, or
 * a file name.
 */
export function flaggedResult(flag: StepSecurity["flag"], source: string, score?: number, chunk?: string): ToolResult {
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
    security: { flag, source, ...(score !== undefined ? { score } : {}), ...(chunk ? { chunk } : {}) },
    pause: { source },
  };
}

/**
 * The checks after a tool call. The result of a tool whose output comes from
 * the internet or from code is scanned for a prompt injection and for
 * malware, in parallel; the model gets it only when both pass (see
 * `flaggedResult` otherwise). What a run did to the sandbox stays, also when
 * its output is withheld. Throws only when `signal` aborts.
 */
export async function checkAfterCall(
  def: ToolDefinition,
  args: Args,
  result: ToolResult,
  session: SecuritySession,
  signal: AbortSignal
): Promise<ToolResult> {
  const { context, audit } = session;
  // Flagged already, or checked by the tool itself
  if (result.security || !def.effects.untrustedOutput || result.scanned) return result;

  const text = result.text.replace(TAG_CHARACTERS, "");
  const host = hostOf(args.url);
  const scan = { timeoutMs: TOOL_SCAN_TIMEOUT_MS, signal, audit, tool: def.name, host };
  const [injection, ...viruses] = await Promise.all([
    scanInjection(text, scan),
    scanVirus(Buffer.from(text), scan),
    ...result.images.map((image) => scanVirus(Buffer.from(image.data, "base64"), scan)),
  ]);
  const source = host ?? SOURCES[def.name] ?? def.name.replace(/_/g, " ");
  // What a run of code did to the sandbox happened, whatever it printed: it ran, only its output is withheld
  const done = {
    files: result.files,
    deletions: result.deletions,
    repository: result.repository,
    run: result.run,
    ...(result.run ? { label: def.label(args, "done") } : {}),
  };

  if (viruses.some((virus) => virus.status === "flagged")) return { ...flaggedResult("virus", source), ...done };
  if (injection.status === "flagged") {
    context.tainted = true;
    return { ...flaggedResult("injection", source, injection.score, injection.chunk), ...done };
  }
  if (injection.status === "unchecked" || viruses.some((virus) => virus.status === "unchecked")) {
    return { ...flaggedResult("unchecked", source), ...done };
  }

  return { ...result, text };
}

/**
 * The check of `text`, a part of an untrusted file (made by code, or
 * downloaded), before the model reads it: it is scanned for a prompt
 * injection, unless that part was scanned before, whose verdict is remembered
 * with the file. Returns the result the model gets in its place when it is
 * flagged or could not be checked (see `flaggedResult`), or null when the
 * model may read it. Hidden Unicode tag characters are removed first: `text`
 * in the answer is what the model may read. Throws only when `signal` aborts.
 */
export async function checkFileRead({
  file,
  text,
  tool,
  session,
  signal,
}: {
  file: Pick<ConversationFile, "id" | "name" | "origin">;
  text: string;
  tool: string;
  session: SecuritySession;
  signal: AbortSignal;
}): Promise<{ blocked: ToolResult } | { text: string }> {
  if (!isUntrusted(file)) return { text };
  const clean = text.replace(TAG_CHARACTERS, "");
  const hash = contentHash(clean);
  const flagged = (score: number, chunk?: string) => {
    session.context.tainted = true;
    return { blocked: flaggedResult("injection", file.name, score, chunk) };
  };

  const known = await rememberedScan(file.id, hash);
  if (known) {
    const about = { tool, check: "injection" as const, contentHash: hash, score: known.score, durationMs: 0 };
    session.audit.add({ ...about, verdict: known.flagged ? "block" : "allow", reason: known.flagged ? "injection" : "clean" });
    return known.flagged ? flagged(known.score, known.chunk) : { text: clean };
  }

  const scan = await scanInjection(clean, { timeoutMs: TOOL_SCAN_TIMEOUT_MS, signal, audit: session.audit, tool });
  if (scan.status === "unchecked") return { blocked: flaggedResult("unchecked", file.name) };
  if (scan.status === "flagged") {
    await rememberScan(file.id, hash, { flagged: true, score: scan.score, ...(scan.chunk ? { chunk: scan.chunk } : {}) });
    return flagged(scan.score, scan.chunk);
  }
  if (scan.status === "clean") await rememberScan(file.id, hash, { flagged: false, score: scan.score });
  return { text: clean };
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

/**
 * Asks the user before code runs in a tainted chat: text that tried to
 * instruct the model is in it, so it may try to get code run. "run" runs it,
 * "skip" goes on without the run, and "stop" (no answer in time, or a stopped
 * chat) ends the reply. `announce` gets the id under which the answer can be sent.
 */
export async function awaitApproval({
  session,
  tool,
  signal,
  announce,
}: {
  session: SecuritySession;
  tool: string;
  signal: AbortSignal;
  announce: (pauseId: string) => void;
}): Promise<ApprovalDecision | "stop"> {
  const pause = openPause(session.userId, signal, undefined, "approval");
  announce(pause.id);
  const decision = await pause.decision;
  session.audit.add({ tool, check: "decision", verdict: decision === "run" ? "allow" : "block", reason: "tainted", decision });
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
  | { outcome: "injection"; action: "pause"; score: number; chunk?: string }
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
  tool,
  host,
}: {
  data: Uint8Array;
  name: string;
  source: FileSource;
  audit: AuditLog;
  signal: AbortSignal;
  tool?: string; // the tool that fetched it, for the log
  host?: string | null; // where it came from, for the log
}): Promise<FileCheck> {
  const user = source === "user";
  const unchecked: FileCheck = { outcome: "unchecked", action: user ? "refuse" : "withhold" };

  const stop = new AbortController();
  const stopped = AbortSignal.any([signal, stop.signal]);
  const converting = fileKind(name) === "image" ? null : convertFile(name, data, stopped);
  // Until it is awaited below, so a failure after a virus was found is not left unhandled
  converting?.catch(() => {});
  const virus = await scanVirus(data, { timeoutMs: UPLOAD_VIRUS_TIMEOUT_MS, signal, audit, tool, host });
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

  const injection = await scanInjection(text, { timeoutMs: FILE_GUARD_TIMEOUT_MS, signal, audit, tool, host });
  if (injection.status === "flagged") return { outcome: "injection", action: "pause", score: injection.score, chunk: injection.chunk };
  if (injection.status === "unchecked") return unchecked;
  return { outcome: "clean", text, info };
}
