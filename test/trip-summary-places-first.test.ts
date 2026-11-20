// @vitest-environment node
// places-first-itinerary 9.4: unpriced Stops are skipped by priceSourceCounts,
// counted by unpricedStopCount, and add nothing to totals (Req 6.8, 6.9, 12.7).
import { describe, it, expect } from "vitest";

import { computeSummary, priceSourceCounts, unpricedStopCount } from "@/lib/trip-summary";
import { normalizeItineraryToInr } from "@/lib/itinerary-inr";
import type { Activity, Itinerary } from "@/lib/types";

const base = { time: "09:00", description: "d" };

const priced: Activity = {
  ...base,
  title: "Fort",
  cost: 500,
  costBasis: "person",
  costClass: "paid-sight",
  priceSource: "web",
  sourceUrl: "https://example.com/p",
  sourceHost: "example.com",
  checkedAt: "2025-01-01T00:00:00.000Z",
  webDetails: { checked: true, priceKind: "entry" },
};
const unpricedChecked: Activity = { ...base, title: "Park", cost: 0, webDetails: { checked: true } };
const unpricedUnchecked: Activity = { ...base, title: "Beach", cost: 0, webDetails: { checked: false } };
const legacy: Activity = { ...base, title: "Museum", cost: 300, category: "sight", priceSource: "estimated" };

function itinerary(acts: Activity[]): Itinerary {
  return {
    title: "T",
    totalCost: 500,
    costUnit: "inr",
    currency: "INR",
    days: [{ day: 1, date: "", title: "Day 1", theme: "t", activities: acts, total: 500 }],
  } as Itinerary;
}

describe("places-first unpriced Stops", () => {
  it("priceSourceCounts skips Stops with webDetails", () => {
    const c = priceSourceCounts(itinerary([priced, unpricedChecked, unpricedUnchecked]));
    expect(c.estimated).toBe(0);
    expect(c.ai).toBe(0);
  });

  it("priceSourceCounts still counts legacy Stops as before", () => {
    const c = priceSourceCounts(itinerary([legacy]));
    expect(c).toEqual({ web: 0, ai: 0, estimated: 1 });
  });

  it("unpricedStopCount counts only places-first Stops without an accepted web price", () => {
    expect(unpricedStopCount([priced, unpricedChecked, unpricedUnchecked, legacy])).toBe(2);
    expect(unpricedStopCount([priced])).toBe(0);
    expect(unpricedStopCount([])).toBe(0);
    expect(unpricedStopCount(undefined)).toBe(0);
  });

  it("totals include only accepted web prices", () => {
    const it = itinerary([priced, unpricedChecked, unpricedUnchecked]);
    const s = computeSummary({ itinerary: it, stayInr: 0, flightPerPerson: 0, travellers: 2, noFlight: true });
    expect(s.activities).toBe(1000);
  });

  it("normalizeItineraryToInr leaves a costUnit inr itinerary without estimates", () => {
    const it = itinerary([priced, unpricedChecked]);
    const out = normalizeItineraryToInr(it, 83);
    expect(out.days[0].activities[1].cost).toBe(0);
    expect(out.days[0].activities[1].priceSource).toBeUndefined();
  });
});
