// Feature: places-first-itinerary, Property 14: Accepted polish changes only order, day, title, sentence and times
// Validates: Requirements 7.1, 7.8, 7.9
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { applyPolish, checkPolish, type PolishContext } from "@/lib/itinerary/polish-check";
import { fitSequence, type DaySpec } from "@/lib/itinerary/scheduler";
import { dayLimits } from "@/lib/itinerary/pace";
import type { PlaceCandidate } from "@/lib/providers/google-places";

const NUM_RUNS = { numRuns: 200 } as const;

/** Data fields that must survive polish untouched (extra fields ride along on the record). */
const DATA_KEYS = [
  "placeId",
  "name",
  "address",
  "location",
  "hours",
  "hoursLabel",
  "photos",
  "price",
  "cost",
  "priceSource",
  "sourceUrl",
  "sourceHost",
  "checkedAt",
  "sources",
  "webDetails",
] as const;

function project(c: PlaceCandidate): string {
  const r = c as unknown as Record<string, unknown>;
  return JSON.stringify(DATA_KEYS.map((k) => [k, r[k] === undefined ? null : r[k]]));
}

function spec(n: number, total: number): DaySpec {
  return { day: n, date: null, weekday: null, limits: dayLimits("balanced", n, total), earliestMin: 540 };
}

const word = fc.stringMatching(/^[A-Za-z]{1,12}( [A-Za-z]{1,12}){0,3}$/);

const candExtra = fc.record({
  name: word,
  street: fc.integer({ min: 1, max: 99 }),
  photos: fc.array(fc.stringMatching(/^places\/[a-z0-9]{3,8}\/photos\/[a-z0-9]{3,8}$/), { maxLength: 3 }),
  cost: fc.integer({ min: 0, max: 5000 }),
  host: fc.constantFrom("example.com", "tripadvisor.in", "klook.com"),
  detail: word,
});

interface Scenario {
  ctx: PolishContext;
  raw: unknown;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .tuple(fc.integer({ min: 1, max: 3 }), fc.array(candExtra, { minLength: 1, maxLength: 9 }))
  .chain(([nDays, extras]) => {
    const n = extras.length;
    return fc
      .tuple(
        fc.array(fc.integer({ min: 0, max: nDays - 1 }), { minLength: n, maxLength: n }), // original day
        fc.array(fc.integer({ min: 0, max: nDays - 1 }), { minLength: n, maxLength: n }), // polished day
        fc.shuffledSubarray(Array.from({ length: n }, (_, i) => i), { minLength: n, maxLength: n }),
        fc.array(word, { minLength: nDays, maxLength: nDays }),
        fc.array(word, { minLength: n, maxLength: n }),
        fc.boolean(), // keep original assignment (reorder only)
      )
      .map(([orig, pol, perm, titles, sentences, keepDays]): Scenario => {
        const cands: PlaceCandidate[] = extras.map((e, i) => {
          const c = {
            placeId: `p${i}`,
            name: e.name,
            address: `${e.street} Road, Old Town, France`,
            location: { lat: 0.001 * i, lng: 0 },
            rating: 4,
            userRatingCount: 100,
            hours: null,
            utcOffsetMinutes: null,
            types: [],
            primaryType: "tourist_attraction",
            businessStatus: "OPERATIONAL",
            googleMapsUri: null,
            photos: e.photos,
            // extra data fields from later pipeline stages
            cost: e.cost,
            price: { amount: e.cost, currency: "INR" },
            priceSource: "web",
            sourceUrl: `https://${e.host}/p${i}`,
            sourceHost: e.host,
            checkedAt: "2025-01-01T00:00:00Z",
            sources: [{ url: `https://${e.host}/s${i}`, host: e.host }],
            webDetails: { tip: e.detail },
          };
          return c as unknown as PlaceCandidate;
        });
        const dayOf = keepDays ? orig : pol;
        const ctx: PolishContext = {
          days: Array.from({ length: nDays }, (_, d) => ({
            spec: spec(d + 1, nDays),
            stops: cands.filter((_c, i) => orig[i] === d),
          })),
          dates: Array.from({ length: nDays }, () => null),
        };
        const raw = {
          days: Array.from({ length: nDays }, (_, d) => ({
            day: d + 1,
            title: titles[d],
            stops: perm
              .filter((i) => dayOf[i] === d)
              .map((i) => ({ placeId: `p${i}`, sentence: sentences[i] })),
          })),
        };
        return { ctx, raw };
      });
  });

describe("Property 14: accepted polish changes only order, day, title, sentence and times", () => {
  it("keeps every data field and recomputes times with fitSequence", () => {
    let accepted = 0;
    let moved = 0;
    fc.assert(
      fc.property(scenarioArb, ({ ctx, raw }) => {
        const v = checkPolish(ctx, raw);
        if (!v.ok) return true; // only accepted outputs are constrained
        accepted += 1;
        const applied = applyPolish(ctx, v);

        const pre = ctx.days.flatMap((d) => d.stops).map(project).sort();
        const post = applied.days.flatMap((d) => d.stops).map((s) => project(s.candidate)).sort();
        expect(post).toEqual(pre);

        // records come through untouched (same reference as the pre-polish record)
        const byId = new Map(ctx.days.flatMap((d) => d.stops).map((c) => [c.placeId, c]));
        for (const d of applied.days) for (const s of d.stops) expect(s.candidate).toBe(byId.get(s.candidate.placeId));

        // same days, same total Stop count
        expect(applied.days.map((d) => d.day).sort()).toEqual(ctx.days.map((d) => d.spec.day).sort());

        // start times equal fitSequence on the accepted order
        for (const d of applied.days) {
          const sp = ctx.days.find((x) => x.spec.day === d.day)!.spec;
          const expected = d.stops.length === 0 ? [] : fitSequence(sp, d.stops.map((s) => s.candidate));
          expect(expected).not.toBeNull();
          expect(d.stops.map((s) => s.scheduled)).toEqual(expected);
          const pd = ctx.days.find((x) => x.spec.day === d.day)!;
          if (d.stops.map((s) => s.candidate.placeId).join() !== pd.stops.map((s) => s.placeId).join()) moved += 1;
        }
        return true;
      }),
      NUM_RUNS,
    );
    expect(accepted).toBeGreaterThan(20);
    expect(moved).toBeGreaterThan(0);
  });
});
