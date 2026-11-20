import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  haversineKm,
  travelMinutes,
  isWithinDestination,
  reorderIfShorter,
  travelLabel,
  type LatLng,
} from "../lib/itinerary/geo";
import { DAY_TRIP_RADIUS_KM, DESTINATION_RADIUS_KM } from "../lib/itinerary/constants";

const NUM_RUNS = 100;

const latLng = fc.record({
  lat: fc.double({ min: -85, max: 85, noNaN: true, noDefaultInfinity: true }),
  lng: fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }),
});

const word = fc.stringMatching(/^[a-z]{3,10}$/);

function totalKm(stops: readonly { location: LatLng }[]): number {
  let s = 0;
  for (let i = 1; i < stops.length; i++) s += haversineKm(stops[i - 1].location, stops[i].location);
  return s;
}

describe("itinerary geo properties", () => {
  // Feature: trustworthy-itinerary, Property 6: Destination-area rule
  // **Validates: Requirements 2.4, 3.9**
  describe("Property 6: Destination-area rule", () => {
    it("an address containing the destination is always accepted", () => {
      fc.assert(
        fc.property(
          word,
          word,
          word,
          fc.option(latLng, { nil: null }),
          fc.option(latLng, { nil: null }),
          fc.boolean(),
          (dest, pre, post, location, centre, dayTrip) => {
            const address = `${pre} ${dest.toUpperCase()}, ${post}`;
            expect(isWithinDestination({ address, location }, dest, centre, dayTrip)).toBe(true);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it("without an address match, accepted exactly when within the radius", () => {
      fc.assert(
        fc.property(latLng, fc.option(latLng, { nil: null }), fc.boolean(), (centre, location, dayTrip) => {
          // destination and address share no letters, so no address match
          const got = isWithinDestination({ address: "zzzz", location }, "qqqq", centre, dayTrip);
          const limit = dayTrip ? DAY_TRIP_RADIUS_KM : DESTINATION_RADIUS_KM;
          const expected = location !== null && haversineKm(centre, location) <= limit;
          expect(got).toBe(expected);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it("a missing location or centre with no address match is rejected", () => {
      fc.assert(
        fc.property(latLng, fc.boolean(), (p, dayTrip) => {
          expect(isWithinDestination({ address: "zzzz", location: null }, "qqqq", p, dayTrip)).toBe(false);
          expect(isWithinDestination({ address: "zzzz", location: p }, "qqqq", null, dayTrip)).toBe(false);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it("widening to the day-trip radius never rejects an accepted result", () => {
      fc.assert(
        fc.property(
          fc.option(latLng, { nil: null }),
          fc.option(latLng, { nil: null }),
          fc.constantFrom("zzzz", "visit qqqq town"),
          (location, centre, address) => {
            const normal = isWithinDestination({ address, location }, "qqqq", centre, false);
            const wide = isWithinDestination({ address, location }, "qqqq", centre, true);
            if (normal) expect(wide).toBe(true);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it("radius boundaries: just inside accepted, just outside rejected, per mode", () => {
      fc.assert(
        fc.property(
          fc.double({ min: -60, max: 60, noNaN: true, noDefaultInfinity: true }),
          fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }),
          fc.boolean(),
          (lat, lng, dayTrip) => {
            const centre = { lat, lng };
            const limit = dayTrip ? DAY_TRIP_RADIUS_KM : DESTINATION_RADIUS_KM;
            const degPerKm = 180 / (Math.PI * 6371);
            const inside = { lat: lat + (limit - 1) * degPerKm, lng };
            const outside = { lat: lat + (limit + 1) * degPerKm, lng };
            expect(isWithinDestination({ address: "zzzz", location: inside }, "qqqq", centre, dayTrip)).toBe(true);
            expect(isWithinDestination({ address: "zzzz", location: outside }, "qqqq", centre, dayTrip)).toBe(false);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it("a point between the two radii is rejected normally but accepted for a day trip", () => {
      fc.assert(
        fc.property(
          fc.double({ min: -60, max: 60, noNaN: true, noDefaultInfinity: true }),
          fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }),
          fc.double({ min: DESTINATION_RADIUS_KM + 2, max: DAY_TRIP_RADIUS_KM - 2, noNaN: true }),
          (lat, lng, km) => {
            const centre = { lat, lng };
            const location = { lat: lat + (km * 180) / (Math.PI * 6371), lng };
            expect(isWithinDestination({ address: "zzzz", location }, "qqqq", centre, false)).toBe(false);
            expect(isWithinDestination({ address: "zzzz", location }, "qqqq", centre, true)).toBe(true);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });

  // Feature: trustworthy-itinerary, Property 7: Travel estimates and reordering
  // **Validates: Requirements 1.5, 2.4, 3.6, 3.7, 3.8, 3.9**
  describe("Property 7: Travel estimates and reordering", () => {
    it("haversineKm is non-negative, symmetric and zero for equal points", () => {
      fc.assert(
        fc.property(latLng, latLng, (a, b) => {
          const d = haversineKm(a, b);
          expect(d).toBeGreaterThanOrEqual(0);
          expect(d).toBeCloseTo(haversineKm(b, a), 9);
          expect(haversineKm(a, { ...a })).toBe(0);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it("haversineKm satisfies the triangle inequality within tolerance", () => {
      fc.assert(
        fc.property(latLng, latLng, latLng, (a, b, c) => {
          expect(haversineKm(a, c)).toBeLessThanOrEqual(haversineKm(a, b) + haversineKm(b, c) + 1e-6);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it("travelMinutes is a non-negative integer and never decreases as distance grows", () => {
      fc.assert(
        fc.property(
          fc.double({ min: 0, max: 20000, noNaN: true }),
          fc.double({ min: 0, max: 20000, noNaN: true }),
          (x, y) => {
            const lo = Math.min(x, y);
            const hi = Math.max(x, y);
            const mLo = travelMinutes(lo);
            const mHi = travelMinutes(hi);
            expect(Number.isInteger(mLo)).toBe(true);
            expect(mLo).toBeGreaterThanOrEqual(0);
            expect(Number.isInteger(mHi)).toBe(true);
            expect(mHi).toBeGreaterThanOrEqual(mLo);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it("travelLabel always contains 'estimate' and the number", () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 100000 }), (m) => {
          const label = travelLabel(m);
          expect(label).toContain("estimate");
          expect(label).toContain(String(m));
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it("reorderIfShorter returns a permutation, keeps the first stop and never lengthens the route", () => {
      const stops = fc
        .array(latLng, { minLength: 0, maxLength: 12 })
        .map((pts) => pts.map((location, id) => ({ id, location })));
      fc.assert(
        fc.property(stops, (input) => {
          const out = reorderIfShorter(input);
          expect(out).toHaveLength(input.length);
          expect(out.map((s) => s.id).sort((a, b) => a - b)).toEqual(input.map((s) => s.id));
          if (input.length > 0) expect(out[0]).toBe(input[0]);
          expect(totalKm(out)).toBeLessThanOrEqual(totalKm(input) + 1e-9);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });
});
