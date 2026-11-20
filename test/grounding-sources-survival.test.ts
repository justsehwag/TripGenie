import { describe, expect, it } from "vitest";
import { applyPriceResults, normalizeItineraryToInr, recomputeTotals, restampItineraryDates } from "@/lib/itinerary-inr";
import { fromSharedContext, toSharedContext } from "@/lib/history/record-codec";
import { sanitizeItinerarySources } from "@/lib/grounding/sources";
import type { Itinerary } from "@/lib/types";

const SOURCES = [
  { title: "Top sights", url: "https://example.com/a", host: "example.com" },
  { title: "Food guide", url: "https://example.org/b", host: "example.org" },
];

function make(extra: Record<string, unknown> = {}): Itinerary {
  return {
    destination: "Paris",
    currency: "USD",
    totalCost: 10,
    days: [
      {
        day: 1,
        date: "2025-01-01",
        title: "Day 1",
        theme: "t",
        total: 10,
        activities: [{ time: "09:00", title: "Visit Louvre", cost: 10, category: "sight" }],
      },
    ],
    sources: SOURCES,
    ...extra,
  } as unknown as Itinerary;
}

describe("Itinerary.sources survival", () => {
  it("survives INR normalisation, restamp, price results and totals", () => {
    const base = make();
    expect(normalizeItineraryToInr(base, 80).sources).toEqual(SOURCES);
    expect(restampItineraryDates(base, "2025-03-01").sources).toEqual(SOURCES);
    expect(recomputeTotals(base).sources).toEqual(SOURCES);
    expect(applyPriceResults(base, []).sources).toEqual(SOURCES);
    const inr = normalizeItineraryToInr(base, 80);
    expect(applyPriceResults(inr, [{ id: "x", inr: 5, source: "ai" }] as never).sources).toEqual(SOURCES);
  });

  it("survives the record codec round trip", () => {
    const plan = { context: {}, dates: {}, itinerary: make() };
    const back = toSharedContext(JSON.parse(JSON.stringify(fromSharedContext(plan))));
    expect(back.itinerary?.sources).toEqual(SOURCES);
  });

  it("drops invalid stored sources but keeps valid ones", () => {
    const bad = [
      { title: "ok", url: "https://example.com/ok", host: "example.com" },
      { title: "x", url: "javascript:alert(1)", host: "evil" },
      { title: "y", url: "http://example.com/plain", host: "example.com" },
      "junk",
    ];
    const cleaned = sanitizeItinerarySources(make({ sources: bad }));
    expect(cleaned.sources).toEqual([bad[0]]);
    const stored = toSharedContext({ itinerary: make({ sources: bad }) });
    expect(stored.itinerary?.sources).toEqual([bad[0]]);
  });

  it("removes the field when nothing valid remains and leaves others alone", () => {
    expect("sources" in sanitizeItinerarySources(make({ sources: "nope" }))).toBe(false);
    expect("sources" in sanitizeItinerarySources(make({ sources: [] }))).toBe(false);
    const none = make();
    delete (none as { sources?: unknown }).sources;
    expect(sanitizeItinerarySources(none)).toBe(none);
    expect(sanitizeItinerarySources(none).title).toBe(none.title);
  });
});
