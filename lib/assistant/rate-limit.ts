// Sliding-window rate limiter with an injected clock. Server only, in memory.

export const MAX_TRACKED_KEYS = 5000;

export type LimiterOptions = {
  max: number;
  windowMs: number;
  now?: () => number;
};

export type LimiterResult = { ok: true } | { ok: false; retryAfterSec: number };

export type Limiter = {
  allow: (key: string) => LimiterResult;
};

export type HeadersLike = { get(name: string): string | null | undefined };

export function createLimiter(opts: LimiterOptions): Limiter {
  const max = Math.max(1, Math.floor(opts.max));
  const windowMs = Math.max(1, opts.windowMs);
  const now = opts.now ?? Date.now;
  const hits = new Map<string, number[]>();

  function prune(t: number): void {
    for (const [k, stamps] of hits) {
      if (stamps.length === 0 || stamps[stamps.length - 1] <= t - windowMs) {
        hits.delete(k);
      }
    }
    // Still too many live keys: drop the oldest-inserted ones.
    if (hits.size > MAX_TRACKED_KEYS) {
      let excess = hits.size - MAX_TRACKED_KEYS;
      for (const k of hits.keys()) {
        if (excess-- <= 0) break;
        hits.delete(k);
      }
    }
  }

  function allow(key: string): LimiterResult {
    const t = now();
    const cutoff = t - windowMs;
    const existing = hits.get(key);
    const stamps = existing ? existing.filter((s) => s > cutoff) : [];

    if (stamps.length >= max) {
      hits.set(key, stamps);
      const waitMs = stamps[0] + windowMs - t;
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil(waitMs / 1000)) };
    }

    stamps.push(t);
    // Re-insert so recently active keys sit last in insertion order.
    hits.delete(key);
    hits.set(key, stamps);
    if (hits.size > MAX_TRACKED_KEYS) prune(t);
    return { ok: true };
  }

  return { allow };
}

/** First `x-forwarded-for` entry, trimmed; `"unknown"` when absent or empty. */
export function clientKey(headers: HeadersLike): string {
  const raw = headers.get("x-forwarded-for");
  if (!raw) return "unknown";
  const first = raw.split(",")[0]?.trim();
  return first ? first : "unknown";
}
