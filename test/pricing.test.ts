import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { calculateTripPricing, partyFare } from "@/lib/pricing";
import { applyPromotion } from "@/lib/promotions";

/** Feature: tripgenie - pricing/promotions property tests (Properties 12, 13, 15). */

const amount = fc.integer({ min: 0, max: 500000 });

describe("Feature: tripgenie, pricing", () => {
  it("Property 12: Pricing is a single consistent source across surfaces", () => {
    fc.assert(
      fc.property(amount, amount, amount, (f, s, a) => {
        const p = calculateTripPricing({ flight: f, stay: s, activities: a });
        expect(p.gross).toBe(p.flight + p.stay + p.activities);
        expect(p.finalPayable).toBe(p.gross - p.discount);
        expect(p.finalPayable).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 100 },
    );
  });

  it("Property 13: Party fare equals per-person fare times travelers", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100000 }),
        fc.integer({ min: 1, max: 9 }),
        (fare, n) => {
          expect(partyFare(fare, n)).toBe(fare * n);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Property 15: Promotions are deterministic and never alter base fares", () => {
    fc.assert(
      fc.property(
        amount,
        fc.constantFrom("GENIE500", "FREQ750", "PRICE1000", "DELIGHT300", "NOPE", undefined),
        (gross, code) => {
          const a = applyPromotion(gross, code);
          const b = applyPromotion(gross, code);
          expect(a.discount).toBe(b.discount);
          expect(a.total).toBe(gross);
          expect(a.discount).toBeGreaterThanOrEqual(0);
          expect(a.discount).toBeLessThanOrEqual(gross);
          expect(a.payable).toBe(gross - a.discount);
        },
      ),
      { numRuns: 100 },
    );
  });
});
