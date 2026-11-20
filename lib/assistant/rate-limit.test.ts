import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { clientKey, createLimiter } from "./rate-limit";

const WINDOW = 60_000;
const MAX = 20;

describe("rate limiter", () => {
  // Feature: trip-assistant-chat, Property 14: The rate limiter allows at most 20 requests per window
  it("never allows more than 20 per 60 s window per key; denials carry positive integer retryAfterSec; keys independent", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            key: fc.constantFrom("a", "b", "c"),
            gap: fc.integer({ min: 0, max: 20_000 }),
          }),
          { maxLength: 150 },
        ),
        (reqs) => {
          let t = 1_000_000;
          const limiter = createLimiter({ max: MAX, windowMs: WINDOW, now: () => t });
          const allowed: Record<string, number[]> = { a: [], b: [], c: [] };
          for (const r of reqs) {
            t += r.gap;
            const res = limiter.allow(r.key);
            if (res.ok) allowed[r.key].push(t);
            else {
              expect(Number.isInteger(res.retryAfterSec)).toBe(true);
              expect(res.retryAfterSec).toBeGreaterThan(0);
            }
          }
          for (const stamps of Object.values(allowed)) {
            for (let i = 0; i < stamps.length; i++) {
              const inWindow = stamps.filter((s) => s >= stamps[i] && s < stamps[i] + WINDOW);
              expect(inWindow.length).toBeLessThanOrEqual(MAX);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("denies the 21st request in a minute and allows one a minute later", () => {
    let t = 5_000;
    const limiter = createLimiter({ max: MAX, windowMs: WINDOW, now: () => t });
    for (let i = 0; i < MAX; i++) expect(limiter.allow("k")).toEqual({ ok: true });
    const denied = limiter.allow("k");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.retryAfterSec).toBeGreaterThan(0);
    expect(limiter.allow("other")).toEqual({ ok: true });
    t += WINDOW;
    expect(limiter.allow("k")).toEqual({ ok: true });
  });
});

describe("clientKey", () => {
  const h = (v: string | null) => ({ get: (n: string) => (n === "x-forwarded-for" ? v : null) });
  it("uses the first trimmed x-forwarded-for entry", () => {
    expect(clientKey(h("  1.2.3.4 , 5.6.7.8"))).toBe("1.2.3.4");
  });
  it("falls back to unknown", () => {
    expect(clientKey(h(null))).toBe("unknown");
    expect(clientKey(h(""))).toBe("unknown");
    expect(clientKey(h("  , 1.1.1.1"))).toBe("unknown");
  });
});
