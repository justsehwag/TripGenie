import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { resolveTripDays } from "@/lib/date-intake";
import type { DateState } from "@/lib/types";

/** Feature: tripgenie - date intake property tests (Properties 7-9). */

const prev: DateState = { mode: "flexible", tripDays: 5 };

describe("Feature: tripgenie, date intake", () => {
  it("Property 7: Inclusive-day resolution and nights-to-days", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 13 }), (n) => {
        const r = resolveTripDays({ kind: "text", text: `${n} nights` }, prev);
        expect(r.error).toBe("");
        expect(r.state.tripDays).toBe(n + 1);
      }),
      { numRuns: 100 },
    );
  });

  it("Property 8: End-before-start is rejected without mutating state", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), (gap) => {
        const start = "2027-06-10";
        const end = `2027-06-0${Math.max(1, 9 - gap)}`;
        const r = resolveTripDays({ kind: "fixed", startDate: start, endDate: end }, prev);
        expect(r.error.length).toBeGreaterThan(0);
        expect(r.state.tripDays).toBe(prev.tripDays);
      }),
      { numRuns: 100 },
    );
  });

  it("Property 9: Resolved trip days are always within 1 to 14 inclusive", () => {
    fc.assert(
      fc.property(fc.integer({ min: -10, max: 50 }), (n) => {
        const r = resolveTripDays({ kind: "flexible", days: n }, prev);
        if (r.error === "") {
          expect(r.state.tripDays).toBeGreaterThanOrEqual(1);
          expect(r.state.tripDays).toBeLessThanOrEqual(14);
        } else {
          expect(r.state.tripDays).toBe(prev.tripDays);
        }
      }),
      { numRuns: 100 },
    );
  });
});
