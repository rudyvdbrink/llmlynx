// Email allow list for signups, backed by an environment variable.
//
// Configure via ALLOWED_SIGNUP_EMAILS in your environment, e.g.:
// ALLOWED_SIGNUP_EMAILS="you@example.com,teammate@example.com"
//
// Emails are normalized to lowercase and trimmed before comparison.

import { normalizeEmail } from "@/lib/authRules";

let cachedAllowList: Set<string> | null = null;

function loadAllowList(): Set<string> {
  cachedAllowList ??= new Set(
    (process.env.ALLOWED_SIGNUP_EMAILS || "")
      .split(/[,\n]/)
      .map(normalizeEmail)
      .filter((entry) => entry.length > 0)
  );
  return cachedAllowList;
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
  const allowed = loadAllowList();
  return allowed.size === 0 || allowed.has(normalizeEmail(email));
}
