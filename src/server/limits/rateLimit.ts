type RateLimitConfig = {
  windowMs: number;
  max: number;
};

type Entry = {
  count: number;
  first: number; // timestamp (ms) of first hit in window
};

const LIMITS = {
  // 10 attempts per 10 minutes per IP for login
  login: { windowMs: 10 * 60 * 1000, max: 10 },

  // 5 signup attempts per 10 minutes per IP
  signup: { windowMs: 10 * 60 * 1000, max: 5 },

  // 5 recovery attempts per 10 minutes per IP
  recovery: { windowMs: 10 * 60 * 1000, max: 5 },
} satisfies Record<string, RateLimitConfig>;

export type RateLimitKind = keyof typeof LIMITS;

// Above this many tracked keys, expired entries are swept on the next check.
const PRUNE_THRESHOLD = 1000;

const buckets = new Map<string, Entry>();

function pruneExpired(now: number) {
  for (const [key, entry] of buckets) {
    const kind = key.slice(0, key.indexOf(":")) as RateLimitKind;
    if (now - entry.first > LIMITS[kind].windowMs) buckets.delete(key);
  }
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
export function checkRateLimit(kind: RateLimitKind, ip: string | null, now = Date.now()): RateLimitResult {
  const cfg = LIMITS[kind];
  const key = `${kind}:${ip || "unknown"}`;

  if (buckets.size > PRUNE_THRESHOLD) pruneExpired(now);

  const existing = buckets.get(key);
  if (!existing || now - existing.first > cfg.windowMs) {
    // first hit, or window expired -> start a new window
    buckets.set(key, { count: 1, first: now });
    return { allowed: true, remaining: cfg.max - 1, resetAt: now + cfg.windowMs };
  }

  const resetAt = existing.first + cfg.windowMs;
  if (existing.count >= cfg.max) {
    return { allowed: false, remaining: 0, resetAt };
  }

  existing.count += 1;
  return { allowed: true, remaining: cfg.max - existing.count, resetAt };
}
