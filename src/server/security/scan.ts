// The two scanners, as the checks use them: the guard (tools/guard), which
// scores text for prompt injections, and clamd, which scans bytes for
// malware. Both run in the stack; no content leaves the server. Every scan
// has a timeout and is logged. A scanner that failed or timed out is skipped
// for a while (circuit breaker), so a broken one makes nobody wait twice;
// what it should have scanned then counts as not checked.

import { callMcpTool } from "@/server/tools/mcp";
import { contentHash, type AuditLog } from "./audit";
import { clamdScan } from "./clamd";
import { clamavServer, guardServer } from "./config";
import { BREAKER_MS, VERDICT_CACHE_SIZE } from "./limits";

/**
 * "empty": there was no text to scan. A flagged scan has the text of the chunk
 * that scored highest (`chunk`), for the user to judge; the model never gets it.
 */
export type InjectionScan =
  | { status: "clean"; score: number }
  | { status: "flagged"; score: number; chunk?: string }
  | { status: "unchecked" | "empty" };

type Verdict = Extract<InjectionScan, { status: "clean" | "flagged" }>;

export type VirusScan = { status: "clean" | "unchecked" } | { status: "flagged"; signature: string };

// What clamd reports for content it could not scan whole, past one of its limits (AlertExceedsMax in
// tools/clamav/clamd.conf): not a virus, but not checked either
const LIMIT_EXCEEDED = "Heuristics.Limits.Exceeded.";

export type ScanOptions = {
  timeoutMs: number;
  signal: AbortSignal; // aborts when the chat or the upload is stopped
  audit: AuditLog;
  tool?: string; // the tool whose result is scanned, for the log
  host?: string | null; // the page's host, for the log
};

function createBreaker() {
  let openUntil = 0;
  return {
    isOpen: () => Date.now() < openUntil,
    trip() {
      openUntil = Date.now() + BREAKER_MS;
    },
    reset() {
      openUntil = 0;
    },
  };
}

const guardBreaker = createBreaker();
const clamBreaker = createBreaker();

// The newest verdicts of the guard by the SHA-256 of their text, so identical text is never scored
// twice; a flagged one keeps the text of its chunk that scored highest
const verdicts = new Map<string, Verdict>();

function recall(hash: string) {
  const verdict = verdicts.get(hash);
  if (!verdict) return null;
  // Used again: it moves to the newest end
  verdicts.delete(hash);
  verdicts.set(hash, verdict);
  return verdict;
}

function remember(hash: string, verdict: Verdict) {
  verdicts.set(hash, verdict);
  if (verdicts.size > VERDICT_CACHE_SIZE) verdicts.delete(verdicts.keys().next().value!);
}

/** Forgets the verdicts and closes the circuit breakers. For tests. */
export function resetScanners() {
  verdicts.clear();
  guardBreaker.reset();
  clamBreaker.reset();
}

/**
 * Scans `text` for a prompt injection with the guard. "flagged" means its
 * score is at or above the guard's threshold. Throws only when `signal` aborts.
 */
export async function scanInjection(text: string, { timeoutMs, signal, audit, tool, host }: ScanOptions): Promise<InjectionScan> {
  if (!text.trim()) return { status: "empty" };
  const server = guardServer();

  const hash = contentHash(text);
  const started = Date.now();
  const log = (result: InjectionScan): InjectionScan => {
    const about = { tool, check: "injection" as const, host, contentHash: hash, durationMs: Date.now() - started };
    if (result.status === "clean") audit.add({ ...about, verdict: "allow", reason: "clean", score: result.score });
    else if (result.status === "flagged") audit.add({ ...about, verdict: "block", reason: "injection", score: result.score });
    else audit.add({ ...about, verdict: "block", reason: "unchecked" });
    return result;
  };

  const known = recall(hash);
  if (known) return log(known);
  if (guardBreaker.isOpen()) return log({ status: "unchecked" });
  try {
    const out = await callMcpTool(
      server,
      "guard_scan_text",
      { text },
      { signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]), timeoutMs }
    );
    if (out.isError) {
      // The guard answered that it cannot scan this text, such as one that is too long: it is not broken
      console.error(`The guard could not scan a text: ${out.text.slice(0, 200)}`);
      return log({ status: "unchecked" });
    }
    const answer = JSON.parse(out.text) as { score?: unknown; flagged?: unknown; chunk?: unknown };
    if (typeof answer.score !== "number" || typeof answer.flagged !== "boolean") throw new Error("unexpected answer");
    const chunk = typeof answer.chunk === "string" && answer.chunk ? { chunk: answer.chunk } : {};
    const verdict: Verdict = answer.flagged
      ? { status: "flagged", score: answer.score, ...chunk }
      : { status: "clean", score: answer.score };
    remember(hash, verdict);
    return log(verdict);
  } catch (err) {
    if (signal.aborted) throw err;
    guardBreaker.trip();
    console.error(`The guard did not answer; skipping it for ${BREAKER_MS / 1000} s: ${(err as Error)?.message || err}`);
    return log({ status: "unchecked" });
  }
}

/** Scans `data` for malware with clamd. Throws only when `signal` aborts. */
export async function scanVirus(data: Uint8Array, { timeoutMs, signal, audit, tool, host }: ScanOptions): Promise<VirusScan> {
  const server = clamavServer();

  const started = Date.now();
  const log = (result: VirusScan): VirusScan => {
    const about = { tool, check: "virus" as const, host, contentHash: contentHash(data), durationMs: Date.now() - started };
    if (result.status === "clean") audit.add({ ...about, verdict: "allow", reason: "clean" });
    else if (result.status === "flagged") audit.add({ ...about, verdict: "block", reason: "virus" });
    else audit.add({ ...about, verdict: "block", reason: "unchecked" });
    return result;
  };

  if (clamBreaker.isOpen()) return log({ status: "unchecked" });
  try {
    const result = await clamdScan(data, { ...server, timeoutMs, signal });
    if (!result.infected) return log({ status: "clean" });
    if (result.signature.startsWith(LIMIT_EXCEEDED)) return log({ status: "unchecked" });
    return log({ status: "flagged", signature: result.signature });
  } catch (err) {
    if (signal.aborted) throw err;
    clamBreaker.trip();
    console.error(`The virus scan failed; skipping clamd for ${BREAKER_MS / 1000} s: ${(err as Error)?.message || err}`);
    return log({ status: "unchecked" });
  }
}
