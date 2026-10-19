import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { buildItinerary, refineItinerary, selectFlight } from "@/lib/itinerary-engine";

/** Feature: tripgenie - itinerary property tests (Properties 10, 14, 16, 17). */

const dest = "Goa";
const start = "2027-05-01";

describe("Feature: tripgenie, itinerary", () => {
  it("Property 10: Itinerary structure matches resolved days", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 14 }), (days) => {
        const it = buildItinerary({ destination: dest, startDate: start, days });
        expect(it.days.length).toBe(days);
        for (const d of it.days) expect(d.activities.length).toBe(5);
        const sum = it.days.reduce((s, d) => s + d.total, 0);
        expect(it.totalCost).toBe(sum);
      }),
      { numRuns: 100 },
    );
  });

  it("Property 14: Selecting a flight persists its identifying fields", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 2, maxLength: 6 }), (no) => {
        const ctx = selectFlight({}, { flightNo: no, date: start, depart: "08:00", arrive: "11:00" });
        expect(ctx.selectedFlight?.flightNo).toBe(no);
        expect(ctx.selectedFlight?.date).toBe(start);
        expect(ctx.selectedFlight?.depart).toBe("08:00");
      }),
      { numRuns: 100 },
    );
  });

  it("Property 16: Day revision changes only the targeted day and totals", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 10 }), fc.integer({ min: -1000, max: 1000 }), (days, delta) => {
        const base = buildItinerary({ destination: dest, startDate: start, days });
        const target = 2;
        const rev = refineItinerary(base, target, delta);
        for (const d of rev.days) {
          if (d.day !== target) {
            const orig = base.days.find((x) => x.day === d.day)!;
            expect(d.total).toBe(orig.total);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("Property 17: Revised day totals are non-negative", () => {
    fc.assert(
      fc.property(fc.integer({ min: -100000, max: 1000 }), (delta) => {
        const base = buildItinerary({ destination: dest, startDate: start, days: 3 });
        const rev = refineItinerary(base, 1, delta);
        for (const d of rev.days) expect(d.total).toBeGreaterThanOrEqual(0);
        expect(rev.totalCost).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 100 },
    );
  });
});
