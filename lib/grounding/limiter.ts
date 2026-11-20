/**
 * In-process concurrency limiter for SearXNG requests (Req 14.7-14.9).
 * Pure: no I/O, no framework imports, never throws.
 */

export interface Limiter {
  /** Synchronously take a slot. Returns an idempotent release, or null at capacity. */
  tryAcquire(): (() => void) | null;
  /** Number of slots currently held. */
  inFlight(): number;
}

export function createLimiter(max: number): Limiter {
  const cap = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
  let held = 0;

  return {
    tryAcquire() {
      if (held >= cap) return null;
      held += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        held -= 1;
      };
    },
    inFlight() {
      return held;
    },
  };
}

export const searxngLimiter: Limiter = createLimiter(5);
