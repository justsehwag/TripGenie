import { describe, expect, it } from "vitest";
import { buildItineraryPdf } from "@/lib/pdf";
import { applyPriceResults, recomputeTotals, toPricerRequest } from "@/lib/itinerary-inr";
import { computeSummary } from "@/lib/trip-summary";
import type { Itinerary, TripDay, TripPricing } from "@/lib/types";

const act = (title: string, cost: number) => ({ time: "09:00", title, description: "d", cost });

function day(n: number, activities: ReturnType<typeof act>[]): TripDay {
  return {
    day: n,
    date: "2025-01-0" + n,
    title: "Day " + n,
    theme: "t",
    activities,
    total: activities.reduce((s, a) => s + a.cost, 0),
  };
}

const itinerary: Itinerary = {
  title: "Trip",
  totalCost: 500,
  currency: "INR",
  costUnit: "inr",
  days: [day(1, [act("Museum", 500)]), day(2, [])],
};

const pricing: TripPricing = computeSummary({
  itinerary,
  stayInr: 1000,
  flightPerPerson: 2000,
  travellers: 1,
  noFlight: false,
});

describe("days with zero activities", () => {
  it("buildItineraryPdf does not throw and renders the free-day line", () => {
    const bytes = buildItineraryPdf("Trip", "A to B", itinerary.days, pricing);
    expect(bytes.length).toBeGreaterThan(100);
    const text = Buffer.from(bytes).toString("latin1");
    expect(text).toContain("Free day - no planned activities.");
  });

  it("buildItineraryPdf works when every day is empty", () => {
    const days = [day(1, []), day(2, [])];
    expect(() => buildItineraryPdf("Trip", "A to B", days, pricing)).not.toThrow();
  });

  it("toPricerRequest skips empty days", () => {
    const req = toPricerRequest("Paris", itinerary);
    expect(req.activities).toHaveLength(1);
    expect(toPricerRequest("Paris", { ...itinerary, days: [day(1, [])] }).activities).toEqual([]);
  });

  it("applyPriceResults and recomputeTotals keep empty day total at 0 and totals consistent", () => {
    const req = toPricerRequest("Paris", itinerary);
    const out = applyPriceResults(itinerary, [{ id: req.activities[0].id, inr: 700, basis: "b", source: "ai" }]);
    expect(out.days[1].activities).toEqual([]);
    expect(out.days[1].total).toBe(0);
    expect(out.days[0].total).toBe(700);
    expect(out.totalCost).toBe(700);
    expect(recomputeTotals({ ...itinerary, days: [day(1, [])] }).totalCost).toBe(0);
  });

  it("computeSummary gives an activities subtotal of zero for an all-empty itinerary", () => {
    const p = computeSummary({
      itinerary: { ...itinerary, days: [day(1, []), day(2, [])] },
      stayInr: 0,
      flightPerPerson: 0,
      travellers: 2,
      noFlight: true,
    });
    expect(p.activities).toBe(0);
    expect(Number.isFinite(p.gross)).toBe(true);
  });
});
