// Response helpers for the auth routes: every failure is logged with its reason
// before the error is returned to the client.

import { jsonError } from "@/server/http";
import { checkRateLimit, type RateLimitKind } from "@/server/limits/rateLimit";
import { logAuthEvent, type AuthEventType } from "@/server/logging/authLogger";

export function createAuthResponder(type: AuthEventType, ip: string | null) {
  return {
    async fail(status: number, message: string, reason: string, email?: string) {
      await logAuthEvent({ type, outcome: "FAILURE", email, reason, ip });
      return jsonError(message, status);
    },

    async succeed(email: string) {
      await logAuthEvent({ type, outcome: "SUCCESS", email, ip });
    },

    /** Returns a 429 response when `ip` is over the limit for `kind`, otherwise null. */
    async rateLimit(kind: RateLimitKind, message: string) {
      const rl = checkRateLimit(kind, ip);
      if (rl.allowed) return null;
      await logAuthEvent({ type, outcome: "FAILURE", reason: "RATE_LIMITED", ip });
      const retryAfter = Math.max(1, Math.round((rl.resetAt - Date.now()) / 1000));
      return jsonError(message, 429, { "Retry-After": retryAfter.toString() });
    },
  };
}
