import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { seedSights, resolveSights } from "@/lib/sights";
import {
  emptyXp,
  award,
  awardMany,
  levelFor,
  earnedBadges,
  questProgress,
  summarize,
  XP_POINTS,
  type XpEvent,
} from "@/lib/gamification";
import { summarizeReviews, noVerifiedReviews } from "@/lib/reviews";
import {
  customizeFlight,
  previewRouting,
  routingOf,
} from "@/lib/flight-customize";
import type { FlightOffer } from "@/lib/types";

/** Feature: tripsaathi-parity - sights / gamification / reviews / flight customize. */

const ALL_EVENTS: XpEvent[] = [
  "concierge_started", "route_set", "dates_set", "profile_completed",
  "itinerary_generated", "day_refined", "flight_selected", "stay_selected",
  "trip_confirmed", "pdf_downloaded",
];

function sampleFlight(over: Partial<FlightOffer> = {}): FlightOffer {
  return {
    id: "FL-1",
    meta: {
      provider: "TripGenie estimator",
      mode: "estimated",
      retrievedAt: new Date(0).toISOString(),
      expiresAt: new Date(1).toISOString(),
      disclaimer: "Estimated - no payment or ticket.",
    },
    origin: "Delhi",
    destination: "Dubai",
    cabin: "Economy",
    stops: 0,
    flightNo: "EK 512",
    date: "2026-11-01",
    depart: "09:00",
    arrive: "12:00",
    farePerPerson: 12000,
    ...over,
  };
}

describe("Feature: tripsaathi-parity, sights", () => {
  it("always returns exactly six sights for any destination", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 40 }), (city) => {
        expect(seedSights(city)).toHaveLength(6);
      }),
      { numRuns: 40 },
    );
  });

  it("restricts curated sights to the requested destination and labels them curated", () => {
    const out = seedSights("Dubai");
    expect(out).toHaveLength(6);
    for (const s of out) {
      expect(s.destination).toBe("Dubai");
      expect(s.mode).toBe("curated");
      expect(s.image.kind).toBe("attraction");
    }
  });

  it("resolveSights without enrichment returns curated mode; enrichment upgrades to live", async () => {
    const curated = await resolveSights("Tokyo");
    expect(curated.sights).toHaveLength(6);
    expect(curated.sights.every((s) => s.mode === "curated")).toBe(true);
    expect(curated.restriction).toContain("Tokyo");

    const enriched = await resolveSights("Tokyo", async (s) => ({ description: `${s.name} (live)`, sourceUrl: "https://example.org" }));
    expect(enriched.sights.every((s) => s.mode === "live")).toBe(true);
    expect(enriched.sights[0].sourceUrl).toBe("https://example.org");
  });

  it("enrichment failure leaves the curated seed intact (labelled fallback, never throws)", async () => {
    const out = await resolveSights("Paris", async () => { throw new Error("wiki down"); });
    expect(out.sights).toHaveLength(6);
    expect(out.sights.every((s) => s.mode === "curated")).toBe(true);
  });
});

describe("Feature: tripsaathi-parity, gamification", () => {
  it("awarding is idempotent per event (no double counting)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_EVENTS), (event) => {
        const once = award(emptyXp(), event);
        const twice = award(once, event);
        expect(twice).toBe(once); // same reference, unchanged
        expect(twice.total).toBe(XP_POINTS[event]);
      }),
      { numRuns: 30 },
    );
  });

  it("total equals the sum of distinct awarded event points regardless of order", () => {
    fc.assert(
      fc.property(fc.shuffledSubarray(ALL_EVENTS), (events) => {
        const state = awardMany(emptyXp(), events);
        const expected = [...new Set(events)].reduce((sum, e) => sum + XP_POINTS[e], 0);
        expect(state.total).toBe(expected);
      }),
      { numRuns: 50 },
    );
  });

  it("level bands and progress are monotonic in total XP", () => {
    expect(levelFor(0).level).toBe(1);
    expect(levelFor(25).level).toBe(2);
    expect(levelFor(1000).nextAt).toBeNull();
    expect(levelFor(1000).toNext).toBe(0);
  });

  it("badges unlock only when all required events are present", () => {
    const partial = awardMany(emptyXp(), ["route_set"]);
    expect(earnedBadges(partial).some((b) => b.id === "route-ready")).toBe(false);
    const full = awardMany(partial, ["dates_set"]);
    expect(earnedBadges(full).some((b) => b.id === "route-ready")).toBe(true);
  });

  it("quest progress counts awarded steps and summary is internally consistent", () => {
    const state = awardMany(emptyXp(), ["concierge_started", "route_set"]);
    const planQuest = questProgress(state).find((q) => q.id === "plan-a-trip")!;
    expect(planQuest.done).toBe(2);
    expect(planQuest.complete).toBe(false);
    const summary = summarize(state);
    expect(summary.total).toBe(state.total);
    expect(summary.level.level).toBeGreaterThanOrEqual(1);
  });
});

describe("Feature: tripsaathi-parity, reviews", () => {
  it("absent or unverified provider data yields the no-verified-reviews state", () => {
    expect(summarizeReviews(null).hasReviews).toBe(false);
    expect(summarizeReviews(undefined).score).toBeNull();
    expect(summarizeReviews({ verified: false, reviews: [] }).hasReviews).toBe(false);
    // verified flag but no attributable items -> still no reviews
    expect(summarizeReviews({ verified: true, reviews: [] }).hasReviews).toBe(false);
    expect(noVerifiedReviews().count).toBe(0);
  });

  it("never fabricates a score for estimated inventory", () => {
    const r = summarizeReviews({ provider: "X", score: 4.5, count: 10, verified: false, reviews: [{ author: "A", rating: 5, text: "ok" }] });
    expect(r.hasReviews).toBe(false);
    expect(r.score).toBeNull();
  });

  it("surfaces attributable reviews only when verified with valid items", () => {
    const r = summarizeReviews({
      provider: "Verified OTA",
      score: 4.6,
      count: 128,
      verified: true,
      reviews: [
        { author: "Asha", rating: 5, text: "Great stay", publishedAt: "2026-01-02T00:00:00.000Z" },
        { author: "Ben", rating: 4, text: "Good value", publishedAt: "2026-02-02T00:00:00.000Z" },
        { author: "", rating: 3, text: "invalid - no author" },
      ],
    });
    expect(r.hasReviews).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.score).toBe(4.6);
    expect(r.count).toBe(128);
    // invalid review dropped; newest first
    expect(r.items).toHaveLength(2);
    expect(r.items[0].author).toBe("Ben");
  });
});

describe("Feature: tripsaathi-parity, flight customize", () => {
  it("never mutates the input offer", () => {
    const base = sampleFlight();
    const snapshot = JSON.stringify(base);
    customizeFlight(base, "one-stop");
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it("direct is non-stop and one-stop has a stop; routingOf round-trips", () => {
    const base = sampleFlight();
    expect(routingOf(base)).toBe("direct");
    const oneStop = customizeFlight(base, "one-stop");
    expect(oneStop.stops).toBe(1);
    expect(routingOf(oneStop)).toBe("one-stop");
    const direct = customizeFlight(oneStop, "direct");
    expect(direct.stops).toBe(0);
  });

  it("one-stop is cheaper and longer than direct for the same base offer", () => {
    fc.assert(
      fc.property(fc.integer({ min: 5000, max: 80000 }), (fare) => {
        const base = sampleFlight({ farePerPerson: fare, stops: 0 });
        const direct = previewRouting(base, "direct");
        const oneStop = previewRouting(base, "one-stop");
        expect(oneStop.farePerPerson).toBeLessThanOrEqual(direct.farePerPerson);
        expect(oneStop.durationMinutes).toBeGreaterThan(direct.durationMinutes);
      }),
      { numRuns: 40 },
    );
  });
});