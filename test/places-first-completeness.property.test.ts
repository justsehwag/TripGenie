import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fc from "fast-check";
import type { BatchRequest, BatchResponse } from "@/lib/itinerary/batch-wire";
import { createCandidateCache } from "@/lib/itinerary/candidate-search";
import { mergeBatch } from "@/lib/itinerary/completeness";
import { batchReducer, buildRequest, initBatchState, nextSlot, type BatchState } from "@/lib/itinerary/planner-batches";
import { runPlacesFirstBatch, type PlacesFirstDeps } from "@/lib/itinerary/places-first-batch";
import { clearPolishMemo } from "@/lib/itinerary/polish";
import type { ResearchConfig } from "@/lib/web-pricing/service";
import type { Itinerary, TripContext, TripDay } from "@/lib/types";

// Feature: places-first-itinerary, Property 18: Requested days are always covered, and the partition stays disjoint
// **Validates: Requirements 8.8, 8.9**

const SEARX_OFF: ResearchConfig = { enabled: false, baseUrl: "", secretHeader: null };
const CENTRE = { lat: 15.4989, lng: 73.8278 };
const NUM_PLACES = 24;

type Outcome = "ok" | "http500" | "http429" | "badbody" | "throw" | "empty";

function res(status: number, json: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => json };
}

function place(i: number) {
  return {
    id: `pid${i}`,
    displayName: { text: `Spot ${["Fort", "Beach", "Temple", "Market", "Museum", "Garden"][i % 6]} ${i}` },
    formattedAddress: `Road ${i}, ${["Calangute", "Panaji", "Old Goa"][i % 3]}, Goa 403001, India`,
    location: { latitude: CENTRE.lat + (i % 5) * 0.003, longitude: CENTRE.lng + (i % 4) * 0.003 },
    businessStatus: "OPERATIONAL",
    types: ["tourist_attraction", "point_of_interest"],
    primaryType: "tourist_attraction",
    rating: 4.4,
    userRatingCount: 500,
  };
}

/** Each Places search consumes the next outcome (cycling); `count` places are returned on success. */
function makeFetch(outcomes: Outcome[], counts: number[], centreFails: boolean) {
  let n = 0;
  return async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    const mask = init?.headers?.["X-Goog-FieldMask"] ?? "";
    if (!url.endsWith(":searchNearby") && mask === "places.id,places.location") {
      if (centreFails) return res(500, {});
      return res(200, { places: [{ id: "centre", location: { latitude: CENTRE.lat, longitude: CENTRE.lng } }] });
    }
    const k = n++;
    const o = outcomes[k % outcomes.length];
    if (o === "throw") throw new Error("network down");
    if (o === "http500") return res(500, {});
    if (o === "http429") return res(429, { error: { status: "RESOURCE_EXHAUSTED" } });
    if (o === "badbody") return res(200, { places: "nope" });
    if (o === "empty") return res(200, { places: [] });
    const count = counts[k % counts.length];
    const start = (k * 5) % NUM_PLACES;
    return res(200, { places: Array.from({ length: count }, (_, j) => place((start + j) % NUM_PLACES)) });
  };
}

const outcomeArb: fc.Arbitrary<Outcome> = fc.oneof(
  { weight: 5, arbitrary: fc.constant<Outcome>("ok") },
  { weight: 1, arbitrary: fc.constant<Outcome>("http500") },
  { weight: 1, arbitrary: fc.constant<Outcome>("http429") },
  { weight: 1, arbitrary: fc.constant<Outcome>("badbody") },
  { weight: 1, arbitrary: fc.constant<Outcome>("throw") },
  { weight: 1, arbitrary: fc.constant<Outcome>("empty") },
);

const placesArb = fc.record({
  outcomes: fc.array(outcomeArb, { minLength: 1, maxLength: 6 }),
  counts: fc.array(fc.integer({ min: 0, max: NUM_PLACES }), { minLength: 1, maxLength: 4 }),
  centreFails: fc.boolean(),
  noKey: fc.integer({ min: 0, max: 9 }).map((n) => n === 0),
});
type PlacesScenario = typeof placesArb extends fc.Arbitrary<infer T> ? T : never;

function depsFor(sc: PlacesScenario): PlacesFirstDeps {
  return {
    hasKey: () => !sc.noKey,
    now: () => 1_000_000,
    logger: () => {},
    diagLogger: () => {},
    candidateCache: createCandidateCache(),
    enrichment: { config: SEARX_OFF },
    fetchImpl: makeFetch(sc.outcomes, sc.counts, sc.centreFails),
  };
}

function ctxFor(total: number): TripContext {
  return { destination: "Goa", durationDays: total, pace: "balanced", interests: [] } as TripContext;
}

const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);
const sortedNum = (a: readonly number[]) => [...a].sort((x, y) => x - y);

beforeEach(() => {
  vi.stubEnv("GOOGLE_PLACES_API_KEY", "test-key");
  clearPolishMemo();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Property 18: Requested days are always covered, and the partition stays disjoint", () => {
  it("batch level: verifiedDays and withheldDays are disjoint and cover fromDay..fromDay+dayCount-1", async () => {
    await fc.assert(
      fc.asyncProperty(
        placesArb,
        fc.integer({ min: 1, max: 14 }).chain((total) =>
          fc.record({
            total: fc.constant(total),
            fromDay: fc.integer({ min: 1, max: total }),
          }),
        ),
        fc.integer({ min: 1, max: 3 }),
        fc.array(fc.string({ maxLength: 12 }), { maxLength: 4 }),
        async (sc, trip, rawCount, used) => {
          clearPolishMemo();
          const dayCount = Math.min(rawCount, trip.total - trip.fromDay + 1);
          const req: BatchRequest = {
            action: "itinerary-batch",
            context: ctxFor(trip.total),
            fromDay: trip.fromDay,
            dayCount,
            usedPlaces: used,
          };
          const r = await runPlacesFirstBatch(req, trip.total, depsFor(sc));
          const requested = range(trip.fromDay, dayCount);
          const all = [...r.verifiedDays, ...r.withheldDays];
          // disjoint
          expect(new Set(all).size).toBe(all.length);
          // cover exactly the requested range
          expect(sortedNum(all)).toEqual(requested);
          // verified days are exactly the returned days
          expect(sortedNum(r.verifiedDays)).toEqual(sortedNum(r.days.map((d) => d.day)));
        },
      ),
      { numRuns: 100 },
    );
  });

  function checkState(s: BatchState, total: number) {
    const all = [...s.verified, ...s.withheld, ...s.pending];
    expect(new Set(all).size).toBe(all.length);
    expect(sortedNum(all)).toEqual(range(1, total));
    expect(s.totalDays).toBe(total);
  }

  function checkItinerary(it: Itinerary, total: number) {
    const c = it.completeness!;
    const all = [...c.verifiedDays, ...c.withheldDays, ...(c.pendingDays ?? [])];
    expect(new Set(all).size).toBe(all.length);
    expect(sortedNum(all)).toEqual(range(1, total));
    expect(c.requestedDays).toBe(total);
  }

  it("trip level: reducer, mergeBatch and runPlacesFirstBatch keep the partition disjoint and covering 1..requestedDays", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 14 }),
        fc.array(placesArb, { minLength: 1, maxLength: 4 }),
        fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 1, maxLength: 8 }),
        async (total, scenarios, dice) => {
          const tripKey = `trip-${total}`;
          const ctx = ctxFor(total);
          let s = batchReducer(initBatchState(), { type: "start", tripKey, totalDays: total });
          checkState(s, total);
          let it: Itinerary | null = null;
          // Seed the itinerary the way the planner does: all days pending.
          it = mergeBatch(
            null,
            { title: "Goa", totalCost: 0, days: [] } as unknown as Itinerary,
            { verifiedDays: [], withheldDays: [] },
            total,
          );
          checkItinerary(it, total);

          let step = 0;
          for (let guard = 0; guard < 40; guard++) {
            const slot = nextSlot(s);
            if (!slot) {
              const retried = batchReducer(s, { type: "auto-retry" });
              if (retried === s) break;
              s = retried;
              checkState(s, total);
              continue;
            }
            const req = buildRequest(s, slot, ctx);
            s = batchReducer(s, { type: "request", slotId: slot.id });
            checkState(s, total);
            const sc = scenarios[step % scenarios.length];
            const die = dice[step % dice.length];
            step++;
            clearPolishMemo();

            let resp: BatchResponse | null = null;
            if (die !== 0) resp = await runPlacesFirstBatch(req, total, depsFor(sc));
            // die === 0 simulates a network error.
            const event = resp
              ? ({ type: "response", slotId: slot.id, tripKey, resp } as const)
              : ({ type: "network-error", slotId: slot.id, tripKey } as const);
            s = batchReducer(s, event);
            checkState(s, total);
            const batchDays: TripDay[] = resp && resp.source === "model" ? resp.days : [];
            // The planner merges with the withheld days reported by the reducer.
            const batchOnly = {
              title: "Goa",
              totalCost: 0,
              days: batchDays,
              completeness: {
                requestedDays: total,
                verifiedDays: batchDays.map((d) => d.day),
                withheldDays: s.withheld,
              },
            } as unknown as Itinerary;
            it = mergeBatch(it, batchOnly, { verifiedDays: batchDays.map((d) => d.day), withheldDays: s.withheld }, total);
            checkItinerary(it, total);
            // The merged itinerary agrees with the reducer on which days are verified.
            expect(it.completeness!.verifiedDays).toEqual(s.verified);

            s = batchReducer(s, { type: "auto-retry" });
            checkState(s, total);
          }
          checkState(s, total);
          expect(it!.completeness!.requestedDays).toBe(total);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("mergeBatch level: any sequence of batch responses keeps the three sets disjoint and covering 1..requestedDays", () => {
    const dayArb = fc.integer({ min: -2, max: 17 }); // includes out-of-range days
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 14 }),
        fc.array(
          fc.record({
            days: fc.array(dayArb, { maxLength: 6 }),
            respVerified: fc.array(dayArb, { maxLength: 6 }),
            respWithheld: fc.array(dayArb, { maxLength: 6 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (total, steps) => {
          let it: Itinerary | null = null;
          for (const st of steps) {
            const batch = {
              title: "T",
              totalCost: 0,
              days: st.days.map((d) => ({ day: d, title: `D${d}`, activities: [], total: 0 })),
            } as unknown as Itinerary;
            it = mergeBatch(it, batch, { verifiedDays: st.respVerified, withheldDays: st.respWithheld }, total);
            const c = it.completeness!;
            const all = [...c.verifiedDays, ...c.withheldDays, ...(c.pendingDays ?? [])];
            expect(new Set(all).size).toBe(all.length);
            expect(sortedNum(all)).toEqual(range(1, total));
            expect(c.requestedDays).toBe(total);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
