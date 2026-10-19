import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { recomputeWorkspace, flightOfferFare, exportItineraryPdf } from "@/lib/workspace";

/** Feature: tripgenie - workspace reactivity (itinerary/pricing/PDF wiring). */

describe("Feature: tripgenie, workspace reactivity", () => {
  it("on resolved-days change, itinerary and wallet stay in lockstep", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 14 }),
        fc.integer({ min: 0, max: 200000 }),
        fc.integer({ min: 0, max: 200000 }),
        (days, flight, stay) => {
          const state = recomputeWorkspace({
            destination: "Goa",
            startDate: "2025-03-01",
            resolvedDays: days,
            flight,
            stay,
          });
          // Itinerary has exactly the resolved number of days.
          expect(state.itinerary.days.length).toBe(days);
          // PDF/pricing activities subtotal = sum of day totals.
          const sumDays = state.itinerary.days.reduce((s, d) => s + d.total, 0);
          expect(state.pricing.activities).toBe(sumDays);
          // Gross = flight + stay + activities; the itinerary total matches the activities line.
          expect(state.pricing.gross).toBe(flight + stay + sumDays);
          expect(state.itinerary.totalCost).toBe(sumDays);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("flight offer fare shows per-person and fare x travellers", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 500000 }),
        fc.integer({ min: 1, max: 9 }),
        (perPerson, travellers) => {
          const f = flightOfferFare(perPerson, travellers);
          expect(f.travellers).toBe(travellers);
          expect(f.party).toBe(f.perPerson * travellers);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("exported PDF is well-formed and embeds the engine total", () => {
    const state = recomputeWorkspace({
      destination: "Goa",
      startDate: "2025-03-01",
      resolvedDays: 3,
      flight: 30000,
      stay: 20000,
    });
    const bytes = exportItineraryPdf(state, "DEL -> GOI");
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith("%PDF-")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    // The final itinerary total from the Pricing Engine is embedded.
    expect(text).toContain(`INR ${state.pricing.finalPayable}`);
  });
});
