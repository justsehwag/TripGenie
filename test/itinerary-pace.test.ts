// @vitest-environment node
// Feature: trustworthy-itinerary, Property 1: Pace limits are total and ordered
// Feature: trustworthy-itinerary, Property 2: Batches partition the trip
// Feature: trustworthy-itinerary, Property 9: Day-trip allowance
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { acceptDayTrips, batchRanges, dayLimits, maxDayTrips } from "@/lib/itinerary/pace";
import { BATCH_DAYS, MAX_BATCHES, MAX_TRIP_DAYS, STOP_TARGET } from "@/lib/itinerary/constants";

const NUM_RUNS = 100;

const paceArb = fc.oneof(
  fc.constantFrom("relaxed", "balanced", "packed"),
  fc.string(),
  fc.constant(""),
  fc.constantFrom(undefined, null),
  fc.integer(),
  fc.boolean(),
  fc.object(),
);

function expectedTarget(pace: unknown): number {
  if (pace === "relaxed") return STOP_TARGET.relaxed;
  if (pace === "packed") return STOP_TARGET.packed;
  return STOP_TARGET.balanced;
}

describe("itinerary pace properties", () => {
  // Feature: trustworthy-itinerary, Property 1: Pace limits are total and ordered
  it("Property 1: Pace limits are total and ordered", () => {
    fc.assert(
      fc.property(
        paceArb,
        fc.integer({ min: 1, max: MAX_TRIP_DAYS }).chain((total) =>
          fc.record({ total: fc.constant(total), day: fc.integer({ min: 1, max: total }) }),
        ),
        (pace, { total, day }) => {
          const a = dayLimits(pace, day, total);
          const b = dayLimits(pace, day, total);
          expect(a).toEqual(b);

          const target = expectedTarget(pace);
          expect([3, 4, 5]).toContain(a.target);
          expect(a.target).toBe(target);
          expect(a.min).toBeLessThanOrEqual(a.max);

          const partialDay = total >= 2 && (day === 1 || day === total);
          if (partialDay) {
            const max = Math.max(1, target - 2);
            expect(a.max).toBe(max);
            expect(a.min).toBe(Math.min(target - 1, max));
            expect(a.min).toBeGreaterThanOrEqual(1);
          } else {
            expect(a.min).toBe(target - 1);
            expect(a.max).toBe(target + 1);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: trustworthy-itinerary, Property 2: Batches partition the trip
  it("Property 2: Batches partition the trip", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX_TRIP_DAYS }), (n) => {
        const ranges = batchRanges(n);
        expect(ranges.length).toBe(Math.ceil(n / BATCH_DAYS));
        expect(ranges.length).toBeLessThanOrEqual(MAX_BATCHES);
        const days: number[] = [];
        let next = 1;
        for (const r of ranges) {
          expect(r.dayCount).toBeGreaterThanOrEqual(1);
          expect(r.dayCount).toBeLessThanOrEqual(BATCH_DAYS);
          expect(r.fromDay).toBe(next); // contiguous and ascending
          for (let i = 0; i < r.dayCount; i++) days.push(r.fromDay + i);
          next = r.fromDay + r.dayCount;
        }
        expect(days).toEqual(Array.from({ length: n }, (_, i) => i + 1));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: trustworthy-itinerary, Property 9: Day-trip allowance
  it("Property 9: Day-trip allowance", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: MAX_TRIP_DAYS }),
        fc.array(fc.boolean(), { minLength: MAX_TRIP_DAYS, maxLength: MAX_TRIP_DAYS }),
        (n, flagPool) => {
          const allowance = maxDayTrips(n);
          expect(allowance).toBe(Math.floor(n / 5));

          // monotone in N
          if (n > 1) expect(maxDayTrips(n)).toBeGreaterThanOrEqual(maxDayTrips(n - 1));

          // sequence of batches: remaining allowance shrinks as trips are accepted
          let remaining = allowance;
          let accepted = 0;
          for (const r of batchRanges(n)) {
            const flags = flagPool.slice(r.fromDay - 1, r.fromDay - 1 + r.dayCount);
            const out = acceptDayTrips(flags, remaining);
            expect(out.length).toBe(flags.length);
            const got = out.filter(Boolean).length;
            // only accepts flagged days, never more than the remaining allowance
            out.forEach((v, i) => {
              if (v) expect(flags[i]).toBe(true);
            });
            expect(got).toBeLessThanOrEqual(remaining);
            accepted += got;
            remaining -= got;
          }
          expect(accepted).toBeLessThanOrEqual(allowance);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("maxDayTrips is non-decreasing over the whole range", () => {
    for (let n = 2; n <= MAX_TRIP_DAYS; n++) {
      expect(maxDayTrips(n)).toBeGreaterThanOrEqual(maxDayTrips(n - 1));
    }
  });
});
