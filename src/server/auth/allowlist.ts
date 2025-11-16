// Email allow list for signups, backed by an environment variable.
//
// Configure via ALLOWED_SIGNUP_EMAILS in your environment, e.g.:
// ALLOWED_SIGNUP_EMAILS="you@example.com,teammate@example.com"
//
// Emails are normalized to lowercase and trimmed before comparison.

let cachedAllowList: Set<string> | null = null;
let cachedIsConfigured: boolean | null = null;

function loadAllowList(): { allowed: Set<string>; isConfigured: boolean } {
  if (cachedAllowList && cachedIsConfigured !== null) {
    return { allowed: cachedAllowList, isConfigured: cachedIsConfigured };
  }

  const raw = process.env.ALLOWED_SIGNUP_EMAILS || "";
  const set = new Set<string>();

  raw
    .split(/[,\n]/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .forEach((entry) => set.add(entry));

  // "Configured" means the env var exists and has at least one non-empty entry.
  const isConfigured = set.size > 0;

  cachedAllowList = set;
  cachedIsConfigured = isConfigured;

  return { allowed: set, isConfigured };
}

/**
 * Returns true if the given email is allowed to sign up.
 *
 * Behavior:
 * - If ALLOWED_SIGNUP_EMAILS is **not configured or empty**, ALL emails are allowed.
 * - If ALLOWED_SIGNUP_EMAILS has entries, only those emails (case-insensitive)
 *   are allowed.
 */
export function isEmailAllowed(email: string): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  const { allowed, isConfigured } = loadAllowList();

  // If there's no configured allow list, do not restrict signups.
  if (!isConfigured) return true;

  return allowed.has(normalized);
}