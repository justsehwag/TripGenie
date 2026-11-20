import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fc from "fast-check";
import type { BatchRequest } from "@/lib/itinerary/batch-wire";
import { createCandidateCache } from "@/lib/itinerary/candidate-search";
import { runPlacesFirstBatch, type PlacesFirstDeps } from "@/lib/itinerary/places-first-batch";
import { areaOfAddress } from "@/lib/itinerary/polish-check";
import { clearPolishMemo } from "@/lib/itinerary/polish";
import type { ModelPrompt } from "@/lib/bedrock-model";
import type { ResearchConfig } from "@/lib/web-pricing/service";

// Feature: places-first-itinerary, Property 1: Stops come only from the candidates of the batch
// **Validates: Requirements 1.2, 1.3, 1.11, 4.1, 4.2, 9.7, 12.1, 12.2, 12.3**

const SEARX_OFF: ResearchConfig = { enabled: false, baseUrl: "", secretHeader: null };
const CENTRE = { lat: 15.4989, lng: 73.8278 };
const REQ: BatchRequest = {
  action: "itinerary-batch",
  context: { destination: "Goa", durationDays: 2, pace: "balanced", interests: [] },
  fromDay: 1,
  dayCount: 2,
  usedPlaces: [],
};

// ---- generators ------------------------------------------------------------

interface PlaceSpec {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  type: string;
  hours: { weekdayDescriptions: string[]; periods: unknown[] } | null;
  photos: string[];
}

const WORDS = ["Fort", "Beach", "Temple", "Market", "Museum", "Garden", "Cafe", "Kitchen", "Church", "Lake"];
const AREAS = ["Calangute", "Panaji", "Old Goa", "Candolim", "Margao"];
const TYPES = ["tourist_attraction", "museum", "park", "restaurant", "cafe", "church"];

const placeSpec = (i: number): fc.Arbitrary<PlaceSpec> =>
  fc
    .record({
      w1: fc.constantFrom(...WORDS),
      w2: fc.constantFrom(...WORDS),
      area: fc.constantFrom(...AREAS),
      dlat: fc.integer({ min: -8, max: 8 }),
      dlng: fc.integer({ min: -8, max: 8 }),
      type: fc.constantFrom(...TYPES),
      hasHours: fc.boolean(),
      allDay: fc.boolean(),
      photoCount: fc.integer({ min: 0, max: 5 }),
    })
    .map((r) => {
      const id = `pid${i}`;
      const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
      const periods: unknown[] = [];
      for (let d = 0; d < 7; d++) periods.push({ open: { day: d, hour: 9, minute: 0 }, close: { day: d, hour: 18, minute: 0 } });
      return {
        id,
        name: `${r.w1} ${r.w2} ${i}`,
        address: `Road ${i}, ${r.area}, Goa 403001, India`,
        lat: CENTRE.lat + r.dlat * 0.003,
        lng: CENTRE.lng + r.dlng * 0.003,
        type: r.type,
        hours: r.hasHours
          ? {
              weekdayDescriptions: days.map((d) => `${d}: ${r.allDay ? "Open 24 hours" : "9:00 AM \u2013 6:00 PM"} (${id})`),
              periods,
            }
          : null,
        photos: Array.from({ length: r.photoCount }, (_, k) => `places/${id}/photos/ph${k}`),
      };
    });

type Fail = "ok" | "http500" | "http429" | "badbody" | "throw";

const universeArb = fc.tuple(...Array.from({ length: 12 }, (_, i) => placeSpec(i)));

const scenarioArb = fc.record({
  universe: universeArb,
  // which universe indices each of the (up to 8) requests returns, and how it fails
  picks: fc.array(fc.array(fc.integer({ min: 0, max: 11 }), { maxLength: 8 }), { minLength: 8, maxLength: 8 }),
  fails: fc.array(
    fc.oneof(
      { weight: 6, arbitrary: fc.constant<Fail>("ok") },
      { weight: 1, arbitrary: fc.constant<Fail>("http500") },
      { weight: 1, arbitrary: fc.constant<Fail>("http429") },
      { weight: 1, arbitrary: fc.constant<Fail>("badbody") },
      { weight: 1, arbitrary: fc.constant<Fail>("throw") },
    ),
    { minLength: 8, maxLength: 8 },
  ),
  centreFails: fc.boolean(),
  polish: fc.record({
    mode: fc.constantFrom("good", "mutated", "invented", "reordered", "garbage", "notjson", "throws", "empty", "duplicated"),
    junk: fc.string({ maxLength: 40 }),
    price: fc.integer({ min: 0, max: 100000 }),
    swap: fc.integer({ min: 0, max: 5 }),
  }),
  usedIdx: fc.array(fc.integer({ min: 0, max: 11 }), { maxLength: 4 }),
  pace: fc.constantFrom("relaxed", "balanced", "packed", "bogus"),
});

type Scenario = typeof scenarioArb extends fc.Arbitrary<infer T> ? T : never;

// ---- harness ---------------------------------------------------------------

interface Returned {
  id: string;
  spec: PlaceSpec;
}

function toPlace(s: PlaceSpec) {
  return {
    id: s.id,
    displayName: { text: s.name },
    formattedAddress: s.address,
    location: { latitude: s.lat, longitude: s.lng },
    businessStatus: "OPERATIONAL",
    types: [s.type, "point_of_interest"],
    primaryType: s.type,
    rating: 4.4,
    userRatingCount: 500,
    ...(s.hours ? { regularOpeningHours: s.hours } : {}),
    photos: s.photos.map((name) => ({ name })),
  };
}

function res(status: number, json: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => json };
}

function makeFetch(sc: Scenario, returned: Returned[]) {
  let n = 0;
  return async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    const mask = init?.headers?.["X-Goog-FieldMask"] ?? "";
    if (!url.endsWith(":searchNearby") && mask === "places.id,places.location") {
      if (sc.centreFails) return res(500, {});
      return res(200, { places: [{ id: "centre", location: { latitude: CENTRE.lat, longitude: CENTRE.lng } }] });
    }
    const k = n++ % sc.picks.length;
    const fail = sc.fails[k];
    if (fail === "throw") throw new Error("network down");
    if (fail === "http500") return res(500, {});
    if (fail === "http429") return res(429, { error: { status: "RESOURCE_EXHAUSTED" } });
    if (fail === "badbody") return res(200, { places: "nope" });
    const specs = sc.picks[k].map((i) => sc.universe[i]);
    for (const s of specs) returned.push({ id: s.id, spec: s });
    return res(200, { places: specs.map(toPlace) });
  };
}

// Planner input as sent by buildPlannerInput (lib/itinerary/planner.ts).
interface PlannerIn {
  days: Array<{ day: number; earliestStart: string; minStops: number; maxStops: number }>;
  candidates: Array<{ placeId: string }>;
}

function makeModel(p: Scenario["polish"]) {
  return async (prompt: ModelPrompt): Promise<string> => {
    const input = JSON.parse(prompt.user) as PlannerIn;
    // Planner-shaped assignment: hand out the sent candidates to the days in order, up to maxStops each.
    const assigned = new Map<number, Array<{ placeId: string }>>();
    let next = 0;
    for (const d of input.days) {
      const take = Math.max(0, d.maxStops);
      assigned.set(d.day, input.candidates.slice(next, next + take));
      next += take;
    }
    const stopOut = (s: { placeId: string }, extra: Record<string, unknown> = {}) => ({
      placeId: s.placeId,
      sentence: "A pleasant place to spend a while.",
      ...extra,
    });
    const hostile = {
      name: `Renamed ${p.junk}`,
      placeName: "Totally Fake Palace",
      address: "1 Invented Lane, Nowhere",
      location: { lat: 1, lng: 2 },
      price: p.price,
      cost: p.price,
      url: "https://evil.example.test/buy",
      sourceUrl: "https://evil.example.test/price",
      photos: ["places/evil/photos/evil"],
      photoRef: "places/evil/photos/evil",
      openingHours: "Open 24 hours, invented",
    };
    const byDay = (extra: (s: { placeId: string }) => Record<string, unknown>, add: boolean) => ({
      days: input.days.map((d) => ({
        day: d.day,
        startTime: d.earliestStart,
        title: `Day plan ${p.junk}`,
        stops: [
          ...(assigned.get(d.day) ?? []).map((s) => stopOut(s, extra(s))),
          ...(add ? [stopOut({ placeId: `invented-${d.day}-${p.junk}` }, hostile)] : []),
        ],
      })),
    });
    switch (p.mode) {
      case "good":
        return JSON.stringify(byDay(() => ({}), false));
      case "mutated":
        return JSON.stringify(byDay(() => hostile, false));
      case "invented":
        return JSON.stringify(byDay(() => hostile, true));
      case "reordered": {
        const o = byDay(() => hostile, false);
        for (const d of o.days) d.stops.reverse();
        return JSON.stringify(o);
      }
      case "duplicated": {
        const o = byDay(() => hostile, false);
        for (const d of o.days) d.stops = [...d.stops, ...d.stops];
        return JSON.stringify(o);
      }
      case "empty":
        return JSON.stringify({ days: [] });
      case "garbage":
        return JSON.stringify({ days: [{ day: "x", stops: [{ placeId: 7 }, null, p.junk] }], extra: hostile });
      case "notjson":
        return `{{${p.junk} not json`;
      default:
        throw new Error("model failure");
    }
  };
}

// ---- the property ----------------------------------------------------------

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.GOOGLE_PLACES_API_KEY;
  vi.stubEnv("GOOGLE_PLACES_API_KEY", "test-key");
});
afterEach(() => {
  vi.unstubAllEnvs();
  if (savedKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
  else process.env.GOOGLE_PLACES_API_KEY = savedKey;
});

describe("Property 1: Stops come only from the candidates of the batch", () => {
  it("every Stop equals a candidate returned in the batch, whatever the Places failures and Polisher output", async () => {
    let checkedStops = 0;
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (sc) => {
        clearPolishMemo();
        const returned: Returned[] = [];
        const deps: PlacesFirstDeps = {
          hasKey: () => true,
          now: () => 1_000_000,
          logger: () => {},
          diagLogger: () => {},
          candidateCache: createCandidateCache(),
          enrichment: { config: SEARX_OFF },
          fetchImpl: makeFetch(sc, returned),
          invokeModel: makeModel(sc.polish),
        };
        const req: BatchRequest = {
          ...REQ,
          context: { ...REQ.context, pace: sc.pace as never },
          usedPlaces: sc.usedIdx.map((i) => sc.universe[i].name),
        };
        const r = await runPlacesFirstBatch(req, 2, deps);

        const byId = new Map<string, PlaceSpec>();
        for (const c of returned) if (!byId.has(c.id)) byId.set(c.id, c.spec);

        const stops = r.days.flatMap((d) => d.activities);
        checkedStops += stops.length;
        if (returned.length === 0) expect(stops).toEqual([]);
        for (const a of stops) {
          const c = byId.get(a.placeId as string);
          expect(c, `placeId ${String(a.placeId)} is not a returned candidate`).toBeDefined();
          if (!c) continue;
          expect(a.placeName).toBe(c.name);
          expect(a.title).toBe(c.name);
          expect(a.area).toBe(areaOfAddress(c.address, "Goa"));
          expect(a.location).toEqual({ lat: c.lat, lng: c.lng });
          if (a.openingHours !== undefined) {
            expect(c.hours?.weekdayDescriptions ?? []).toContain(a.openingHours);
          }
          const expectPhotos = c.photos.slice(0, 3);
          if (expectPhotos.length === 0) {
            expect(a.photos).toBeUndefined();
            expect(a.photoRef).toBeUndefined();
          } else {
            expect(a.photos).toEqual(expectPhotos);
            expect(a.photoRef).toBe(expectPhotos[0]);
          }
          // Polisher prices, URLs and text never reach the Stop's data fields.
          expect(a.cost).toBe(0);
          expect(a.priceSource).toBeUndefined();
          expect(a.sourceUrl).toBeUndefined();
          expect(a.verified).toBe(true);
        }
      }),
      { numRuns: 150 },
    );
    // Guard against a vacuous pass: the generated scenarios must have produced Stops.
    expect(checkedStops).toBeGreaterThan(50);
  }, 120_000);
});
