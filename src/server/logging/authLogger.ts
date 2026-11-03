import fs from "node:fs";
import path from "node:path";

// A runtime location, not part of the build: tell Turbopack not to trace it.
const LOG_DIR = path.resolve(/*turbopackIgnore: true*/ process.cwd(), process.env.AUTH_LOG_DIR || "logs");
const LOG_FILE = path.join(/*turbopackIgnore: true*/ LOG_DIR, process.env.AUTH_LOG_FILE || "auth.log");

let logDirReady: Promise<unknown> | null = null;

function formatTimestamp(date: Date) {
  // ISO string without milliseconds for compactness
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Values come from user input; collapse whitespace and control characters so
// one event always stays on one line.
function sanitize(value: string) {
  return value.replace(/[\s\p{C}]+/gu, "_");
}

export type AuthEventType = "LOGIN" | "SIGNUP" | "RESET" | "PASSWORD_CHANGE" | "DELETE_ACCOUNT";

export type AuthEvent = {
  type: AuthEventType;
  outcome: "SUCCESS" | "FAILURE";
  email?: string;
  reason?: string;
  ip?: string | null;
};

/**
 * Write a single line to the auth log.
 *
 * Example line:
 * 2025-11-15T18:58:02Z LOGIN SUCCESS email=user@example.com ip=127.0.0.1
 */
export async function logAuthEvent({ type, outcome, email, reason, ip }: AuthEvent) {
  const safeEmail = sanitize((email || "").trim().toLowerCase());

  const parts = [
    formatTimestamp(new Date()),
    type,
    outcome,
    safeEmail ? `email=${safeEmail}` : undefined,
    ip ? `ip=${sanitize(ip)}` : undefined,
    reason ? `reason=${reason}` : undefined,
  ].filter(Boolean);

  try {
    logDirReady ??= fs.promises.mkdir(LOG_DIR, { recursive: true });
    await logDirReady;
    await fs.promises.appendFile(LOG_FILE, parts.join(" ") + "\n", { encoding: "utf8" });
  } catch (err) {
    // Intentionally swallow logging errors so they don't break auth flows.
    logDirReady = null;
    console.error("Failed to write auth log:", err);
  }
}
