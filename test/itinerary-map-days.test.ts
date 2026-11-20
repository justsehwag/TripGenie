import { describe, it, expect } from "vitest";
import { batchStats, isoDatePlus, mapDays, plainDays, polishedDays } from "../lib/itinerary/map-days";
import { buildMapsUrl } from "../lib/itinerary/maps-link";
import { applyPolish, checkPolish, type PolishContext } from "../lib/itinerary/polish-check";
import type { DaySpec, ScheduleResult } from "../lib/itinerary/scheduler";
import { dayLimits } from "../lib/itinerary/pace";
import type { EnrichedStop } from "../lib/itinerary/enrichment";
import type { PlaceCandidate } from "../lib/providers/google-places";

function cand(id: string, o: Partial<PlaceCandidate> = {}): PlaceCandidate {
  return {
    placeId: id,
    name: `Place ${id}`,
    address: "1 Road, Old Town, France",
    location: { lat: 0.001 * id.charCodeAt(id.length - 1), lng: 0 },
    rating: 4,
    userRatingCount: 100,
    hours: null,
    utcOffsetMinutes: null,
    types: [],
    primaryType: "tourist_attraction",
    businessStatus: "OPERATIONAL",
    googleMapsUri: null,
    photos: [],
    ...o,
  };
}

function spec(n: number, total = 2): DaySpec {
  return { day: n, date: null, weekday: null, limits: dayLimits("balanced", n, total), earliestMin: 540 };
}

function schedule(): ScheduleResult {
  return {
    days: [
      {
        day: 1,
        stops: [
          { placeId: "a1", startMin: 540, endMin: 600, visitMin: 60, travelToNextMin: 7, hoursLabel: "Hours not listed", hoursText: null },
          { placeId: "a2", startMin: 607, endMin: 667, visitMin: 60, hoursLabel: null, hoursText: "Monday: 9:00 AM - 5:00 PM" },
        ],
      },
      { day: 2, stops: [{ placeId: "b1", startMin: 545, endMin: 605, visitMin: 60, hoursLabel: null, hoursText: null }] },
    ],
    shortDays: [],
    emptyDays: [],
  };
}

const pool = [
  cand("a1", { photos: ["places/a1/photos/p1", "places/a1/photos/p2", "places/a1/photos/p3", "places/a1/photos/p4"] }),
  cand("a2"),
  cand("b1", { address: "9 Lane, Montmartre, France" }),
];

const price = {
  inr: 500,
  sourceUrl: "https://example.org/tickets",
  sourceHost: "example.org",
  checkedAt: "2025-01-01T00:00:00.000Z",
  basis: "Entry fee on example.org",
  kind: "entry" as const,
};

function enrich(): Map<string, EnrichedStop> {
  return new Map<string, EnrichedStop>([
    [
      "a1",
      {
        placeId: "a1",
        price,
        webDetails: {
          checked: true,
          priceKind: "entry",
          tip: { text: "Arrive early.", sourceUrl: "https://tips.example/x", sourceHost: "tips.example", checkedAt: price.checkedAt },
        },
      },
    ],
    ["a2", { placeId: "a2", webDetails: { checked: false } }],
  ]);
}

describe("isoDatePlus / batchStats", () => {
  it("adds days and rejects bad input", () => {
    expect(isoDatePlus("2025-01-30", 3)).toBe("2025-02-02");
    expect(isoDatePlus(undefined, 1)).toBe("");
    expect(isoDatePlus("nope", 1)).toBe("");
  });
  it("counts proposed, verified and removed", () => {
    const r = mapDays({ days: plainDays(schedule(), pool) });
    expect(batchStats(10, r.days, 123)).toEqual({ proposed: 10, verified: 3, removed: 7, ms: 123 });
    expect(batchStats(1, r.days, 0).removed).toBe(0);
  });
});

describe("mapDays (Plain_Itinerary)", () => {
  const r = mapDays({
    days: plainDays(schedule(), pool),
    enrichment: enrich(),
    sources: [
      { title: "Tickets", url: price.sourceUrl, host: "example.org" },
      { title: "Tips", url: "https://tips.example/x", host: "tips.example" },
      { title: "Unused", url: "https://unused.example/", host: "unused.example" },
    ],
    startDate: "2025-01-06",
    destination: "Paris",
  });

  it("builds dates, area titles and themes", () => {
    expect(r.days.map((d) => d.date)).toEqual(["2025-01-06", "2025-01-07"]);
    expect(r.days[0].title).toBe("Old Town day");
    expect(r.days[1].title).toBe("Montmartre day");
    expect(r.days[0].theme).toBe("Old Town");
  });

  it("sets Places fields from the candidate", () => {
    const a = r.days[0].activities[0];
    expect(a).toMatchObject({
      time: "09:00",
      title: "Place a1",
      placeName: "Place a1",
      placeId: "a1",
      verified: true,
      area: "Old Town",
      description: "",
      travelToNextMin: 7,
      hoursLabel: "Hours not listed",
    });
    expect(a.mapsUrl).toBe(buildMapsUrl("a1", "Place a1"));
    expect(a.location).toEqual(pool[0].location);
    expect(r.days[0].activities[1]).toMatchObject({ time: "10:07", openingHours: "Monday: 9:00 AM - 5:00 PM" });
  });

  it("keeps at most 3 photos and photoRef = photos[0]", () => {
    const a = r.days[0].activities[0];
    expect(a.photos).toEqual(["places/a1/photos/p1", "places/a1/photos/p2", "places/a1/photos/p3"]);
    expect(a.photoRef).toBe("places/a1/photos/p1");
    expect(r.days[0].activities[1].photos).toBeUndefined();
    expect(r.days[0].activities[1].photoRef).toBeUndefined();
  });

  it("uses accepted web prices only and counts the rest", () => {
    const [a, b] = r.days[0].activities;
    expect(a).toMatchObject({ cost: 500, priceSource: "web", sourceHost: "example.org", priceBasis: price.basis, costBasis: "person" });
    expect(a.webDetails?.checked).toBe(true);
    expect(b.cost).toBe(0);
    expect(b.priceSource).toBeUndefined();
    expect(b.sourceUrl).toBeUndefined();
    expect(r.days[0].total).toBe(500);
    expect(r.days[1].total).toBe(0);
    expect(r.days[1].activities[0].webDetails).toBeUndefined();
    expect(r.unpriced).toBe(2);
    expect(r.unpricedByDay).toEqual({ 1: 1, 2: 1 });
  });

  it("never sets a category or an AI estimate", () => {
    for (const d of r.days) {
      for (const a of d.activities) {
        expect(a.category).toBeUndefined();
        expect(a.priceSource === undefined || a.priceSource === "web").toBe(true);
      }
    }
  });

  it("returns only sources the built Stops use", () => {
    expect(r.sources.map((s) => s.url)).toEqual([price.sourceUrl, "https://tips.example/x"]);
  });
});

describe("titles", () => {
  it("falls back to Day N without an area and keeps titles distinct", () => {
    const noArea = [cand("a1", { address: "France" }), cand("a2", { address: "France" }), cand("b1", { address: "France" })];
    const r = mapDays({ days: plainDays(schedule(), noArea) });
    expect(r.days.map((d) => d.title)).toEqual(["Day 1", "Day 2"]);
    const same = [cand("a1"), cand("a2"), cand("b1")];
    const t = mapDays({ days: plainDays(schedule(), same) }).days.map((d) => d.title);
    expect(new Set(t).size).toBe(2);
    expect(t).toEqual(["Old Town day", "Old Town day 2"]);
  });

  it("drops the destination segment when finding the area", () => {
    const p = [cand("a1", { address: "1 Road, Paris, Paris, France" }), cand("a2"), cand("b1")];
    const r = mapDays({ days: plainDays(schedule(), p), destination: "Paris" });
    expect(r.days[0].activities[0].area).toBe("");
    expect(r.days[0].title).toBe("Day 1");
  });

  it("replaces a duplicate polished title and a misplaced Arrival Day", () => {
    const days = plainDays(schedule(), pool).map((d, i) => ({ ...d, title: i === 0 ? "Arrival Day" : "Arrival Day" }));
    const wrong = mapDays({ days, startDate: "2025-01-06", flightDate: "2025-01-09" });
    expect(wrong.days.some((d) => /arrival day|departure day/i.test(d.title))).toBe(false);
    const right = mapDays({ days, startDate: "2025-01-06", flightDate: "2025-01-06" });
    expect(right.days[0].title).toBe("Arrival Day");
    expect(right.days[1].title).not.toBe("Arrival Day");
    const dup = mapDays({ days: days.map((d) => ({ ...d, title: "Same" })) });
    expect(new Set(dup.days.map((d) => d.title)).size).toBe(2);
  });
});

describe("polished input", () => {
  it("maps an accepted, applied polish with sentences and recomputed times", () => {
    const c: PolishContext = {
      days: [
        { spec: spec(1), stops: [cand("a1"), cand("a2")] },
        { spec: spec(2), stops: [cand("b1")] },
      ],
      dates: [null, null],
    };
    const v = checkPolish(c, {
      days: [
        { day: 1, title: "Old Town walk", stops: [{ placeId: "a2", sentence: "Start here." }, { placeId: "a1", sentence: "Then this." }] },
        { day: 2, title: "Quiet day", stops: [{ placeId: "b1", sentence: "Calm." }] },
      ],
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const r = mapDays({ days: polishedDays(applyPolish(c, v)) });
    expect(r.days[0].title).toBe("Old Town walk");
    expect(r.days[0].activities.map((a) => a.placeId)).toEqual(["a2", "a1"]);
    expect(r.days[0].activities[0].description).toBe("Start here.");
    expect(r.days[0].activities[0].time).toBe("09:00");
  });

  it("skips days with no timed Stop", () => {
    const r = mapDays({ days: [{ day: 1, title: null, stops: [] }] });
    expect(r.days).toEqual([]);
  });
});
