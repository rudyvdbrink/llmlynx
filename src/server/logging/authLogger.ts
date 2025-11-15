import fs from "fs";
import path from "path";

const LOG_DIR = process.env.AUTH_LOG_DIR || "logs";
const LOG_FILE_NAME = process.env.AUTH_LOG_FILE || "auth.log";

function getLogFilePath() {
  const dir = path.resolve(process.cwd(), LOG_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, LOG_FILE_NAME);
}

function formatTimestamp(date: Date) {
  // ISO string without milliseconds for compactness
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Write a single line to the auth log.
 *
 * Example line:
 * 2025-11-15T18:58:02Z LOGIN SUCCESS email=user@example.com ip=127.0.0.1
 */
export async function logAuthEvent(params: {
  type: "LOGIN" | "SIGNUP" | "RESET";
  outcome: "SUCCESS" | "FAILURE";
  email?: string;
  reason?: string;
  ip?: string | null;
}) {
  const { type, outcome, email, reason, ip } = params;
  const ts = formatTimestamp(new Date());
  const safeEmail = (email || "").trim().toLowerCase();

  const parts = [
    ts,
    type,
    outcome,
    safeEmail ? `email=${safeEmail}` : undefined,
    ip ? `ip=${ip}` : undefined,
    reason ? `reason=${reason}` : undefined,
  ].filter(Boolean);

  const line = parts.join(" ") + "\n";

  try {
    const filePath = getLogFilePath();
    await fs.promises.appendFile(filePath, line, { encoding: "utf8" });
  } catch (err) {
    // Intentionally swallow logging errors so they don't break auth flows.
    console.error("Failed to write auth log:", err);
  }
}