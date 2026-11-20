import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyItineraryPlaces } from "@/lib/grounding/verify-places";
import type { GroundingBundle } from "@/lib/grounding/types";
import type { Itinerary } from "@/lib/types";

const act = (title: string, cost: number) => ({ time: "10:00", title, description: "", cost });

function itin(): Itinerary {
  return {
    title: "Goa",
    totalCost: 1000,
    days: [
      {
        day: 1,
        date: "2025-01-01",
        title: "d1",
        theme: "t",
        total: 600,
        activities: [act("Visit Baga Beach", 100), act("Visit Ghost Fort", 200), act("Visit Chapora Fort", 300)],
      },
      { day: 2, date: "2025-01-02", title: "d2", theme: "t", total: 400, activities: [act("Visit Fontainhas", 400)] },
    ],
  };
}

const bundle = (texts: string[] = []): GroundingBundle => ({
  status: "ok",
  droppedCount: 0,
  snippets: texts.map((t, i) => ({ title: t, snippet: t, url: `https://e.com/${i}`, host: "e.com" })),
});

/** Fake Places fetch: resolves a query only if its text contains a known name. */
function fakeFetch(known: string[], calls: string[] = []) {
  return async (_url: string, init?: { body?: string }) => {
    const q = String((JSON.parse(init?.body ?? "{}") as { textQuery?: string }).textQuery);
    calls.push(q);
    const hit = known.some((k) => q.includes(k));
    return { ok: true, status: 200, json: async () => (hit ? { places: [{ id: "p1" }] } : { places: [] }) };
  };
}

const memCache = () => {
  const m = new Map<string, string>();
  return { getPlaceId: (q: string) => m.get(q) ?? null, setPlaceId: (q: string, id: string) => void m.set(q, id) };
};

const base = { destination: "Goa", hasKey: () => true };
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.GOOGLE_PLACES_API_KEY;
  process.env.GOOGLE_PLACES_API_KEY = "test-key";
});
afterEach(() => {
  if (saved === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
  else process.env.GOOGLE_PLACES_API_KEY = saved;
});

describe("verifyItineraryPlaces", () => {
  it("removes unresolved+absent and recomputes totals", async () => {
    const r = await verifyItineraryPlaces(itin(), bundle(), {
      ...base,
      fetchImpl: fakeFetch(["Baga", "Chapora", "Fontainhas"]),
      placeIdCache: memCache(),
    });
    expect(r.applied).toBe(true);
    expect(r.removed).toBe(1);
    expect(r.itinerary.days[0].activities.map((a) => a.title)).toEqual(["Visit Baga Beach", "Visit Chapora Fort"]);
    expect(r.itinerary.days[0].total).toBe(400);
    expect(r.itinerary.totalCost).toBe(800);
  });

  it("keeps unresolved+present with mapVerified:false; resolved untouched", async () => {
    const input = itin();
    const r = await verifyItineraryPlaces(input, bundle(["Ghost Fort is a hidden gem"]), {
      ...base,
      fetchImpl: fakeFetch(["Baga", "Chapora", "Fontainhas"]),
      placeIdCache: memCache(),
    });
    expect(r.applied).toBe(true);
    expect(r.notMapVerified).toBe(1);
    expect(r.itinerary.days[0].activities[1].mapVerified).toBe(false);
    expect(r.itinerary.days[0].activities[0]).toEqual(input.days[0].activities[0]);
    expect(r.itinerary.totalCost).toBe(1000);
  });

  it("does not mutate the input", async () => {
    const input = itin();
    const snap = JSON.parse(JSON.stringify(input));
    await verifyItineraryPlaces(input, bundle(), {
      ...base,
      fetchImpl: fakeFetch(["Baga", "Chapora", "Fontainhas"]),
      placeIdCache: memCache(),
    });
    expect(input).toEqual(snap);
  });

  it("returns the original on a tracked failure", async () => {
    const input = itin();
    const r = await verifyItineraryPlaces(input, bundle(), {
      ...base,
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
      placeIdCache: memCache(),
    });
    expect(r.applied).toBe(false);
    expect(r.itinerary).toBe(input);
  });

  it("returns the original on a thrown fetch and on json() failure", async () => {
    const input = itin();
    const t = await verifyItineraryPlaces(input, bundle(), {
      ...base,
      fetchImpl: async () => {
        throw new Error("boom");
      },
      placeIdCache: memCache(),
    });
    const j = await verifyItineraryPlaces(input, bundle(), {
      ...base,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("bad");
        },
      }),
      placeIdCache: memCache(),
    });
    expect(t.itinerary).toBe(input);
    expect(j.itinerary).toBe(input);
    expect(t.applied || j.applied).toBe(false);
  });

  it("returns the original when the key is missing (no requests)", async () => {
    const input = itin();
    const calls: string[] = [];
    const r = await verifyItineraryPlaces(input, bundle(), {
      ...base,
      hasKey: () => false,
      fetchImpl: fakeFetch([], calls),
      placeIdCache: memCache(),
    });
    expect(r.applied).toBe(false);
    expect(r.itinerary).toBe(input);
    expect(calls).toHaveLength(0);
  });

  it("returns the original when the deadline passes", async () => {
    const input = itin();
    const r = await verifyItineraryPlaces(input, bundle(), {
      ...base,
      deadlineMs: 20,
      fetchImpl: () => new Promise(() => {}),
      placeIdCache: memCache(),
    });
    expect(r.applied).toBe(false);
    expect(r.itinerary).toBe(input);
  });

  it("returns the original when more than half would be removed", async () => {
    const input = itin();
    const r = await verifyItineraryPlaces(input, bundle(), {
      ...base,
      fetchImpl: fakeFetch(["Fontainhas"]),
      placeIdCache: memCache(),
    });
    expect(r.applied).toBe(false);
    expect(r.itinerary).toBe(input);
  });

  it("caps lookups at 40 and keeps the rest unchanged", async () => {
    const acts = Array.from({ length: 50 }, (_, i) => act(`Visit Place${String.fromCharCode(65 + (i % 26))}${"x".repeat(i)} Park`, 10));
    const input: Itinerary = {
      title: "x",
      totalCost: 500,
      days: [{ day: 1, date: "d", title: "t", theme: "t", total: 500, activities: acts }],
    };
    const calls: string[] = [];
    const r = await verifyItineraryPlaces(input, bundle(), {
      ...base,
      fetchImpl: fakeFetch(["Place"], calls),
      placeIdCache: memCache(),
    });
    expect(calls.length).toBeLessThanOrEqual(40);
    expect(r.itinerary.days[0].activities).toHaveLength(50);
  });
});
