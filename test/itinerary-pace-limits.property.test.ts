import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { scheduleBatch, type DaySpec } from "../lib/itinerary/scheduler";
import { dayLimits } from "../lib/itinerary/pace";
import type { PlaceCandidate } from "../lib/providers/google-places";

// Feature: places-first-itinerary, Property 5: Day sizes respect the pace limits
// Validates: Requirements 2.9, 2.10, 2.11, 9.5

function cand(id: string, lat: number, lng: number, primaryType: string, rating: number): PlaceCandidate {
  return {
    placeId: id,
    name: id,
    address: "Somewhere",
    location: { lat, lng },
    rating,
    userRatingCount: 100,
    hours: null,
    utcOffsetMinutes: null,
    types: [],
    primaryType,
    businessStatus: "OPERATIONAL",
    googleMapsUri: null,
    photos: [],
  };
}

const paceArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constantFrom("relaxed", "balanced", "packed"),
  fc.constantFrom(undefined, null, "", "fast", "PACKED", 3, {}, [], true),
  fc.string(),
);

// Tight cluster (about 1 km) so travel caps never decide the outcome.
const placeArb = (kinds: readonly string[]) =>
  fc.record({
    lat: fc.double({ min: 0, max: 0.01, noNaN: true }),
    lng: fc.double({ min: 0, max: 0.01, noNaN: true }),
    kind: fc.constantFrom(...kinds),
    rating: fc.integer({ min: 1, max: 5 }),
  });

function buildPool(items: Array<{ lat: number; lng: number; kind: string; rating: number }>): PlaceCandidate[] {
  return items.map((p, i) => cand(`p${i}`, p.lat, p.lng, p.kind, p.rating));
}

const SIGHT_KINDS = ["tourist_attraction", "museum", "park"] as const;
const ANY_KINDS = ["tourist_attraction", "museum", "park", "restaurant", "cafe"] as const;
const INTERESTS = [undefined, [], ["food"], ["history"], ["history", "food"]] as const;

function daysFor(from: number, count: number, total: number, pace: unknown): DaySpec[] {
  return Array.from({ length: count }, (_, k) => ({
    day: from + k,
    date: null,
    weekday: null,
    limits: dayLimits(pace, from + k, total),
    earliestMin: 540,
  }));
}

describe("Property 5: Day sizes respect the pace limits", () => {
  it("never schedules more than dayLimits(...).max, and reports short/empty days consistently", () => {
    fc.assert(
      fc.property(
        paceArb,
        fc.integer({ min: 1, max: 14 }),
        fc.integer({ min: 1, max: 3 }),
        fc.array(placeArb(ANY_KINDS), { maxLength: 40 }),
        fc.constantFrom(...INTERESTS),
        (pace, total, count, items, interests) => {
          const from = Math.max(1, Math.min(total - count + 1, 1 + Math.floor(total / 2)));
          const n = Math.min(count, total - from + 1);
          const days = daysFor(from, n, total, pace);
          const res = scheduleBatch({
            days,
            pool: buildPool(items),
            interests: interests as unknown[] | undefined,
            pace: pace as never,
          });
          expect(res.days).toHaveLength(days.length);
          const ids = new Set<string>();
          res.days.forEach((d, i) => {
            const lim = days[i].limits;
            expect(d.stops.length).toBeLessThanOrEqual(lim.max);
            for (const s of d.stops) {
              expect(ids.has(s.placeId)).toBe(false);
              ids.add(s.placeId);
            }
            expect(res.emptyDays.includes(d.day)).toBe(d.stops.length === 0);
            expect(res.shortDays.includes(d.day)).toBe(d.stops.length >= 1 && d.stops.length < lim.min);
          });
        },
      ),
      { numRuns: 200 },
    );
  });

  it("keeps the count within [min, max] when the pool has enough schedulable sights", () => {
    fc.assert(
      fc.property(
        paceArb,
        fc.integer({ min: 1, max: 14 }),
        fc.integer({ min: 1, max: 14 }),
        fc.array(placeArb(SIGHT_KINDS), { minLength: 6, maxLength: 12 }),
        fc.constantFrom(...INTERESTS),
        (pace, total, dayRaw, items, interests) => {
          const d = Math.min(dayRaw, total);
          const days = daysFor(d, 1, total, pace);
          const lim = days[0].limits;
          const res = scheduleBatch({
            days,
            pool: buildPool(items),
            interests: interests as unknown[] | undefined,
            pace: pace as never,
          });
          const count = res.days[0].stops.length;
          expect(count).toBeLessThanOrEqual(lim.max);
          expect(count).toBeGreaterThanOrEqual(lim.min);
          expect(res.emptyDays).toEqual([]);
          expect(res.shortDays).toEqual([]);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("treats an invalid or missing pace as balanced", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(undefined, null, "", "fast", "PACKED", 3, {}, []),
        fc.integer({ min: 1, max: 14 }),
        fc.integer({ min: 1, max: 14 }),
        fc.array(placeArb(ANY_KINDS), { maxLength: 20 }),
        (bad, total, dayRaw, items) => {
          const d = Math.min(dayRaw, total);
          expect(dayLimits(bad, d, total)).toEqual(dayLimits("balanced", d, total));
          const pool = buildPool(items);
          const a = scheduleBatch({
            days: daysFor(d, 1, total, bad),
            pool,
            interests: undefined,
            pace: bad as never,
          });
          const b = scheduleBatch({
            days: daysFor(d, 1, total, "balanced"),
            pool,
            interests: undefined,
            pace: "balanced",
          });
          expect(a).toEqual(b);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("reports a day with 0 Stops as empty and not short", () => {
    const res = scheduleBatch({
      days: daysFor(1, 2, 3, "balanced"),
      pool: [],
      interests: undefined,
      pace: "balanced",
    });
    expect(res.emptyDays).toEqual([1, 2]);
    expect(res.shortDays).toEqual([]);
  });
});
