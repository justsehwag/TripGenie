// Feature: places-first-itinerary, Property 2: Candidate filter keeps only operational, local, unique candidates
// Validates: Requirements 1.7, 1.8, 1.9, 9.2
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { filterCandidates, type FilterContext } from "@/lib/itinerary/candidate-filter";
import { haversineKm } from "@/lib/itinerary/geo";
import { DESTINATION_RADIUS_KM } from "@/lib/itinerary/constants";
import { NON_VISIT_TYPES } from "@/lib/itinerary/place-categories";
import { nameKey } from "@/lib/itinerary/place-key";
import type { PlaceCandidate } from "@/lib/providers/google-places";

const NUM_RUNS = { numRuns: 100 } as const;
const DEST = "Goa";
const CENTRE = { lat: 15.3, lng: 74.0 };
const VISIT_TYPES = ["tourist_attraction", "museum", "park", "restaurant", "church", "beach"];
const NAMES = [
  "Fort Aguada",
  "fort  aguada!",
  "Basilica of Bom Jesus",
  "Café Mondegar",
  "Cafe Mondegar",
  "Baga Beach",
  "Anjuna Market",
  "Dudhsagar Falls",
  "Spice Farm",
  "Chapora Fort",
  "",
  "!!!",
];

interface Place {
  placeId: string;
  name: string;
}

// A fixed universe: a placeId always carries the same name, as in real Places data.
const UNIVERSE: Place[] = Array.from({ length: 14 }, (_, i) => ({
  placeId: `pid-${i}`,
  name: NAMES[i % NAMES.length],
}));

const candidateArb: fc.Arbitrary<PlaceCandidate> = fc
  .record({
    place: fc.constantFrom(...UNIVERSE),
    status: fc.constantFrom<string | null>("OPERATIONAL", "OPERATIONAL", "OPERATIONAL", "CLOSED_TEMPORARILY", "CLOSED_PERMANENTLY", null),
    types: fc.array(fc.constantFrom(...VISIT_TYPES, ...NON_VISIT_TYPES), { maxLength: 3 }),
    primary: fc.option(fc.constantFrom(...VISIT_TYPES, ...NON_VISIT_TYPES), { nil: null }),
    inAddress: fc.boolean(),
    dLat: fc.double({ min: -1.5, max: 1.5, noNaN: true }),
    dLng: fc.double({ min: -1.5, max: 1.5, noNaN: true }),
    noId: fc.integer({ min: 0, max: 24 }),
  })
  .map((r) => ({
    placeId: r.noId === 0 ? "" : r.place.placeId,
    name: r.place.name,
    address: r.inAddress ? `1 Main Road, ${DEST}, India` : "Somewhere Else, India",
    location: { lat: CENTRE.lat + r.dLat, lng: CENTRE.lng + r.dLng },
    rating: null,
    userRatingCount: null,
    hours: null,
    utcOffsetMinutes: null,
    types: r.types,
    primaryType: r.primary,
    businessStatus: r.status,
    googleMapsUri: null,
    photos: [],
  }));

const poolArb = fc.array(candidateArb, { maxLength: 30 });
const usedKeysArb = fc.array(fc.constantFrom(...NAMES.map(nameKey)), { maxLength: 4 });
const usedIdsArb = fc.array(fc.constantFrom(...UNIVERSE.map((p) => p.placeId)), { maxLength: 4 });
const centreArb = fc.constantFrom<typeof CENTRE | null>(CENTRE, null);

function ctxOf(centre: typeof CENTRE | null, keys: string[], ids: string[], categories?: string[]): FilterContext {
  return {
    destination: DEST,
    centre,
    usedKeys: new Set(keys),
    usedPlaceIds: new Set(ids),
    categories,
  };
}

describe("filterCandidates (Property 2)", () => {
  it("keeps only operational, allowed-type, local, unique candidates absent from the used keys", () => {
    fc.assert(
      fc.property(poolArb, centreArb, usedKeysArb, usedIdsArb, (pool, centre, keys, ids) => {
        const ctx = ctxOf(centre, keys, ids);
        const { kept } = filterCandidates(pool, ctx);
        const nonVisit = new Set<string>(NON_VISIT_TYPES);
        const seenIds = new Set<string>();
        const seenNames = new Set<string>();
        for (const c of kept) {
          expect(c.businessStatus).toBe("OPERATIONAL");
          expect(c.placeId).toBeTruthy();
          const types = [...(c.primaryType ? [c.primaryType] : []), ...c.types];
          expect(types.some((t) => nonVisit.has(t))).toBe(false);
          const inAddress = nameKey(c.address).includes(nameKey(DEST));
          const near = centre !== null && haversineKm(centre, c.location) <= DESTINATION_RADIUS_KM;
          expect(inAddress || near).toBe(true);
          expect(seenIds.has(c.placeId)).toBe(false);
          seenIds.add(c.placeId);
          expect(ctx.usedPlaceIds!.has(c.placeId)).toBe(false);
          const k = nameKey(c.name);
          if (k !== "") {
            expect(seenNames.has(k)).toBe(false);
            seenNames.add(k);
            expect(keys.includes(k)).toBe(false);
          }
        }
      }),
      NUM_RUNS,
    );
  });

  it("keeps only candidates matching the selected categories when given", () => {
    fc.assert(
      fc.property(poolArb, fc.subarray(VISIT_TYPES, { minLength: 1 }), (pool, cats) => {
        const { kept } = filterCandidates(pool, ctxOf(CENTRE, [], [], cats));
        for (const c of kept) {
          const types = [...(c.primaryType ? [c.primaryType] : []), ...c.types];
          expect(types.some((t) => cats.includes(t))).toBe(true);
        }
      }),
      NUM_RUNS,
    );
  });

  it("is order-preserving, accounts for every candidate and does not mutate its input", () => {
    fc.assert(
      fc.property(poolArb, centreArb, usedKeysArb, (pool, centre, keys) => {
        const snapshot = JSON.stringify(pool);
        const { kept, dropped } = filterCandidates(pool, ctxOf(centre, keys, []));
        expect(JSON.stringify(pool)).toBe(snapshot);
        expect(kept.length + dropped.closed + dropped.outside + dropped.duplicate + dropped.excludedType).toBe(pool.length);
        let from = 0;
        for (const c of kept) {
          const idx = pool.indexOf(c, from);
          expect(idx).toBeGreaterThanOrEqual(from);
          from = idx + 1;
        }
      }),
      NUM_RUNS,
    );
  });

  it("is idempotent: filtering its own output returns the same list", () => {
    fc.assert(
      fc.property(poolArb, centreArb, usedKeysArb, usedIdsArb, (pool, centre, keys, ids) => {
        const ctx = ctxOf(centre, keys, ids);
        const once = filterCandidates(pool, ctx).kept;
        const twice = filterCandidates(once, ctx).kept;
        expect(twice).toEqual(once);
      }),
      NUM_RUNS,
    );
  });

  it("never repeats a placeId across batches that feed Stop names back as used places", () => {
    fc.assert(
      fc.property(fc.array(poolArb, { minLength: 1, maxLength: 5 }), centreArb, (batches, centre) => {
        const usedKeys = new Set<string>();
        const allIds = new Set<string>();
        for (const pool of batches) {
          const ctx: FilterContext = { destination: DEST, centre, usedKeys };
          // Real Stops always have a name; an empty nameKey cannot be fed back.
          const { kept } = filterCandidates(pool.filter((c) => nameKey(c.name) !== ""), ctx);
          for (const c of kept) {
            expect(allIds.has(c.placeId)).toBe(false);
            allIds.add(c.placeId);
          }
          for (const c of kept) {
            const k = nameKey(c.name);
            if (k) usedKeys.add(k);
          }
        }
      }),
      NUM_RUNS,
    );
  });
});
