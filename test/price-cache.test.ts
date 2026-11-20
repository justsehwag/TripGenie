import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  PriceCache,
  PRICE_CACHE_TTL_MS,
  PRICE_CACHE_MAX_ENTRIES,
  priceCacheKey,
  shouldCache,
  type PriceResult,
} from "../lib/price-cache";
import { handlePriceRequest } from "../lib/activity-pricer";

// Feature: trip-planning-v2, Property 12: Price cache policy
// Validates: Requirements 6.17, 6.18, 6.19

const TTL = PRICE_CACHE_TTL_MS;

function val(tag: number): PriceResult[] {
  return [{ id: `a${tag}`, inr: tag, basis: "b", source: "ai" }];
}

type Op =
  | { t: "set"; key: string; tag: number; dt: number }
  | { t: "get"; key: string; dt: number };

const opArb = fc.oneof(
  fc.record({
    t: fc.constant("set" as const),
    key: fc.constantFrom("k0", "k1", "k2", "k3", "k4", "k5", "k6"),
    tag: fc.integer({ min: 0, max: 1000 }),
    dt: fc.integer({ min: 0, max: 10 * 60 * 60 * 1000 }),
  }),
  fc.record({
    t: fc.constant("get" as const),
    key: fc.constantFrom("k0", "k1", "k2", "k3", "k4", "k5", "k6"),
    dt: fc.integer({ min: 0, max: 10 * 60 * 60 * 1000 }),
  }),
);

/** Reference model: ordered list, oldest first. */
class Model {
  items: { key: string; tag: number; at: number }[] = [];
  constructor(private max: number) {}
  expired(at: number, now: number) {
    return now - at >= TTL;
  }
  set(key: string, tag: number, now: number) {
    this.items = this.items.filter((i) => i.key !== key);
    this.items = this.items.filter((i) => !this.expired(i.at, now));
    while (this.items.length >= this.max) this.items.shift();
    this.items.push({ key, tag, at: now });
  }
  get(key: string, now: number): number | undefined {
    const i = this.items.find((x) => x.key === key);
    if (!i) return undefined;
    if (this.expired(i.at, now)) {
      this.items = this.items.filter((x) => x !== i);
      return undefined;
    }
    return i.tag;
  }
}

describe("Property 12: Price cache policy", () => {
  it("Feature: trip-planning-v2, Property 12 - agrees with reference model (max 4)", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 60 }), (ops) => {
        const max = 4;
        const cache = new PriceCache({ maxEntries: max });
        const model = new Model(max);
        let now = 1_000_000;
        for (const op of ops) {
          now += op.dt;
          if (op.t === "set") {
            cache.set(op.key, val(op.tag), now);
            model.set(op.key, op.tag, now);
          } else {
            const got = cache.get(op.key, now);
            const exp = model.get(op.key, now);
            expect(got === undefined ? undefined : got[0].inr).toBe(exp);
          }
          expect(cache.size).toBeLessThanOrEqual(max);
        }
      }),
      { numRuns: 150 },
    );
  });

  it("Feature: trip-planning-v2, Property 12 - size never exceeds default 200 and oldest evicted first", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 60 }), (extra) => {
        const cache = new PriceCache();
        const total = PRICE_CACHE_MAX_ENTRIES + extra;
        for (let i = 0; i < total; i++) cache.set(`k${i}`, val(i), 5);
        expect(cache.size).toBe(PRICE_CACHE_MAX_ENTRIES);
        expect(cache.get("k0", 5)).toBeUndefined();
        expect(cache.get(`k${extra - 1}`, 5)).toBeUndefined();
        expect(cache.get(`k${extra}`, 5)).toBeDefined();
        expect(cache.get(`k${total - 1}`, 5)).toBeDefined();
      }),
      { numRuns: 100 },
    );
  });

  it("TTL boundary: hit at 24h - 1ms, miss at 24h", () => {
    const c1 = new PriceCache();
    c1.set("k", val(1), 1000);
    expect(c1.get("k", 1000 + TTL - 1)).toEqual(val(1));
    const c2 = new PriceCache();
    c2.set("k", val(1), 1000);
    expect(c2.get("k", 1000 + TTL)).toBeUndefined();
    expect(c2.size).toBe(0);
  });

  it("shouldCache is true iff at least one result is ai", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<"ai" | "estimated">("ai", "estimated"), { maxLength: 10 }),
        (sources) => {
          const prices: PriceResult[] = sources.map((source, i) => ({
            id: `a${i}`,
            inr: i,
            basis: "b",
            source,
          }));
          expect(shouldCache(prices)).toBe(sources.includes("ai"));
        },
      ),
      { numRuns: 100 },
    );
  });

  const actArb = fc
    .uniqueArray(fc.stringMatching(/^[a-z0-9]{1,6}$/), { minLength: 1, maxLength: 8 })
    .chain((ids) =>
      fc.tuple(
        ...ids.map((id) =>
          fc.record({
            id: fc.constant(id),
            title: fc.stringMatching(/^[A-Za-z0-9 ]{1,20}$/),
            time: fc.constantFrom("09:00", "13:30", "18:00"),
            kind: fc.constantFrom("entry-ticket", "meal", "local-transfer", "other" as const),
          }),
        ),
      ),
    );

  it("Feature: trip-planning-v2, Property 12 - priceCacheKey equality and order sensitivity", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z]{1,12}$/), actArb, (dest, acts) => {
        const list = acts as { id: string; title: string; time: string; kind: string }[];
        const k = priceCacheKey(dest, list);
        expect(priceCacheKey(dest, list.map((a) => ({ ...a })))).toBe(k);
        expect(priceCacheKey(`  ${dest.toUpperCase()} `, list)).toBe(k);
        if (list.length >= 2) {
          expect(priceCacheKey(dest, [...list].reverse())).not.toBe(k);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("Feature: trip-planning-v2, Property 12 - failed model call leaves cache unchanged; repeat success makes zero extra calls", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[A-Za-z]{1,12}$/),
        actArb,
        fc.integer({ min: 0, max: 5000 }),
        async (dest, acts, inr) => {
          const activities = acts as { id: string; title: string; time: string; kind: string }[];
          const cache = new PriceCache();
          let t = 10_000;
          let calls = 0;
          const base = { cache, now: () => t, usdInr: async () => 90 };
          const body = { destination: dest, activities };

          // Failed call: rejected invoke, then unusable text; cache unchanged.
          const failing = await handlePriceRequest(body, {
            ...base,
            invoke: async () => {
              calls++;
              throw new Error("boom");
            },
          });
          expect(failing.status).toBe(200);
          if (failing.status === 200) {
            expect(failing.body.cached).toBe(false);
            expect(failing.body.prices.every((p) => p.source === "estimated")).toBe(true);
          }
          expect(cache.size).toBe(0);
          await handlePriceRequest(body, {
            ...base,
            invoke: async () => {
              calls++;
              return "not json at all";
            },
          });
          expect(cache.size).toBe(0);

          // Successful call caches.
          const okText = JSON.stringify({
            prices: activities.map((a) => ({ id: a.id, inr, basis: "typical" })),
          });
          calls = 0;
          const invoke = async () => {
            calls++;
            return okText;
          };
          const first = await handlePriceRequest(body, { ...base, invoke });
          expect(calls).toBe(1);
          expect(cache.size).toBe(1);
          t += 1000;
          const second = await handlePriceRequest(body, { ...base, invoke });
          expect(calls).toBe(1);
          expect(second.status).toBe(200);
          if (first.status === 200 && second.status === 200) {
            expect(first.body.cached).toBe(false);
            expect(second.body.cached).toBe(true);
            expect(second.body.prices).toEqual(first.body.prices);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: web-grounded-pricing, Property 23: Price cache keys separate researched and unresearched requests
// Validates: Requirements 18.9
describe("Property 23: price cache keys separate researched and unresearched requests", () => {
  const acts = fc
    .array(
      fc.record({
        id: fc.stringMatching(/^[a-z0-9]{1,6}$/),
        title: fc.stringMatching(/^[A-Za-z0-9 ]{1,20}$/),
        time: fc.constantFrom("09:00", "13:30", "18:00"),
        kind: fc.constantFrom("entry-ticket", "meal", "local-transfer", "other"),
      }),
      { minLength: 1, maxLength: 6 },
    );
  const dest = fc.stringMatching(/^[A-Za-z]{1,12}$/);
  const sig = fc.uniqueArray(
    fc.record({ k: fc.stringMatching(/^[a-z|]{1,10}$/), at: fc.integer({ min: 1, max: 1e12 }) }),
    { maxLength: 5, selector: (x) => x.k },
  );
  const budget = fc.constantFrom("budget", "mid", "luxury");
  const tier = fc.constantFrom("metro", "tier2", "small");

  it("Feature: web-grounded-pricing, Property 23 - separation of keys", () => {
    fc.assert(
      fc.property(dest, acts, budget, tier, sig, fc.integer({ min: 1, max: 1e6 }), (d, a, b, t, s, dt) => {
        const base = priceCacheKey(d, a);
        // extra undefined equals the pre-spec key
        expect(priceCacheKey(d, a, undefined)).toBe(base);
        const ex = { b, t, o: "X", rf: false, ev: s.map((x) => `${x.k}@${x.at}`) };
        expect(priceCacheKey(d, a, ex)).not.toBe(base);
        // evidence time change -> different key
        const s2 = [{ k: "z", at: 5 }, ...s].map((x) => `${x.k}@${x.at}`);
        const s3 = [{ k: "z", at: 5 + dt }, ...s].map((x) => `${x.k}@${x.at}`);
        expect(priceCacheKey(d, a, { ...ex, ev: s2 })).not.toBe(priceCacheKey(d, a, { ...ex, ev: s3 }));
        // budget / tier change -> different key
        const b2 = b === "mid" ? "luxury" : "mid";
        const t2 = t === "metro" ? "small" : "metro";
        expect(priceCacheKey(d, a, { ...ex, b: b2 })).not.toBe(priceCacheKey(d, a, ex));
        expect(priceCacheKey(d, a, { ...ex, t: t2 })).not.toBe(priceCacheKey(d, a, ex));
      }),
      { numRuns: 100 },
    );
  });

  it("getWithMeta returns stored meta and get still returns the value", () => {
    const c = new PriceCache();
    const meta = { mode: "bus", minInr: 100, maxInr: 300 };
    c.set("k", val(1), 1000, meta);
    expect(c.getWithMeta("k", 1001)).toEqual({ value: val(1), meta });
    expect(c.get("k", 1001)).toEqual(val(1));
    c.set("j", val(2), 1000);
    expect(c.getWithMeta("j", 1001)?.meta).toBeUndefined();
    expect(c.getWithMeta("k", 1000 + TTL)).toBeUndefined();
  });

  it("shouldCache is true for web results", () => {
    expect(shouldCache([{ id: "a", inr: 5, basis: "b", source: "web" }])).toBe(true);
  });
});
