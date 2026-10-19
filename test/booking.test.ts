import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { BookingService, type OfferLine } from "@/lib/booking";
import { calculateTripPricing } from "@/lib/pricing";

/** Feature: tripgenie - booking property tests (Properties 27, 28, 30). */

describe("Feature: tripgenie, booking", () => {
  it("Property 27: Booking confirmation executes an order at most once per token", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 6 }), (tries) => {
        const svc = new BookingService(false);
        const lines: OfferLine[] = [{ kind: "flight", amount: 10000 }];
        const preview = svc.preview(["o1"], lines);
        const results = Array.from({ length: tries }, () => svc.confirm(preview.confirmationToken));
        const confirmed = results.filter((r) => !("rejected" in r));
        expect(confirmed.length).toBe(1);
      }),
      { numRuns: 100 },
    );
  });

  it("Property 28: Booking preview repricing equals the pricing engine", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50000 }),
        fc.integer({ min: 0, max: 50000 }),
        fc.integer({ min: 0, max: 50000 }),
        (f, s, a) => {
          const svc = new BookingService(false);
          const lines: OfferLine[] = [
            { kind: "flight", amount: f },
            { kind: "stay", amount: s },
            { kind: "activity", amount: a },
          ];
          const preview = svc.preview(["o1"], lines);
          const expected = calculateTripPricing({ flight: f, stay: s, activities: a });
          expect(preview.pricing).toEqual(expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Property 30: Confirmations without credentials are estimated and take no payment", () => {
    fc.assert(
      fc.property(fc.boolean(), (cred) => {
        const svc = new BookingService(cred);
        const preview = svc.preview(["o1"], [{ kind: "flight", amount: 10000 }]);
        const r = svc.confirm(preview.confirmationToken);
        expect("rejected" in r).toBe(false);
        if (!("rejected" in r)) {
          if (!cred) {
            expect(r.status).toBe("estimated");
            expect(r.disclaimer.toLowerCase()).toContain("no payment");
          } else {
            expect(r.status).toBe("confirmed");
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
