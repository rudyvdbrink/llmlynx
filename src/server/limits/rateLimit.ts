type LimitKey = string;

type RateLimitConfig = {
  windowMs: number;
  max: number;
};

type Entry = {
  count: number;
  first: number; // timestamp (ms) of first hit in window
};

const DEFAULTS: Record<string, RateLimitConfig> = {
  // 10 attempts per 10 minutes per IP for login
  login: { windowMs: 10 * 60 * 1000, max: 10 },

  // 5 signup attempts per 10 minutes per IP
  signup: { windowMs: 10 * 60 * 1000, max: 5 },

  // 5 recovery attempts per 10 minutes per IP
  recovery: { windowMs: 10 * 60 * 1000, max: 5 },
};

const buckets = new Map<LimitKey, Entry>();

function getKey(kind: keyof typeof DEFAULTS, ip: string | null): LimitKey {
  return `${kind}:${ip || "unknown"}`;
}

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: number; // timestamp in ms when window resets
};

/**
 * Very simple in-memory rate limiter.
 * NOT suitable for multi-instance/cluster without a shared store.
 */
export function checkRateLimit(
  kind: keyof typeof DEFAULTS,
  ip: string | null,
  now = Date.now()
): RateLimitResult {
  const cfg = DEFAULTS[kind];
  const key = getKey(kind, ip);

  const existing = buckets.get(key);
  if (!existing) {
    buckets.set(key, { count: 1, first: now });
    return {
      allowed: true,
      remaining: cfg.max - 1,
      resetAt: now + cfg.windowMs,
    };
  }

  const elapsed = now - existing.first;
  if (elapsed > cfg.windowMs) {
    // window expired -> reset
    existing.count = 1;
    existing.first = now;
    return {
      allowed: true,
      remaining: cfg.max - 1,
      resetAt: now + cfg.windowMs,
    };
  }

  if (existing.count >= cfg.max) {
    // over limit
    return {
      allowed: false,
      remaining: 0,
      resetAt: existing.first + cfg.windowMs,
    };
  }

  existing.count += 1;
  return {
    allowed: true,
    remaining: cfg.max - existing.count,
    resetAt: existing.first + cfg.windowMs,
  };
}