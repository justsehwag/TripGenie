import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { dayTravelLimit, evaluateDay, type VerifiedStop } from "../lib/itinerary/structure";
import { dayLimits, type DayLimits } from "../lib/itinerary/pace";
import { legMinutes } from "../lib/itinerary/geo";
import {
  MAX_DAY_TRAVEL_MIN,
  MAX_DAY_TRIP_LEG_MIN,
  MAX_LEG_TRAVEL_MIN,
} from "../lib/itinerary/constants";

const NUM_RUNS = 100;
const KM_PER_DEG_LAT = 111.195;

function stop(i: number, lat: number, lng = 0): VerifiedStop {
  return {
    key: `p${i}`,
    placeId: `p${i}`,
    placeName: `Place ${i}`,
    mapsUrl: `https://maps.google.com/?q=place_id:p${i}`,
    location: { lat, lng },
    time: "10:00",
    place: `Place ${i}`,
    area: "Centre",
    kind: "sight",
    description: "A place",
    cost: 0,
    slot: i,
  };
}

const keysOf = (xs: readonly { key: string }[]) => xs.map((s) => s.key);

// Feature: trustworthy-itinerary, Property 8: Day evaluation applies the withhold rule
describe("Property 8: Day evaluation applies the withhold rule", () => {
  // up to ~3 degrees of spread so both short and over-limit legs occur
  const stopsArb = fc
    .array(
      fc.record({
        lat: fc.double({ min: -1.5, max: 1.5, noNaN: true, noDefaultInfinity: true }),
        lng: fc.double({ min: -1.5, max: 1.5, noNaN: true, noDefaultInfinity: true }),
      }),
      { minLength: 0, maxLength: 9 },
    )
    .map((pts) => pts.map((p, i) => stop(i, p.lat, p.lng)));

  const limitsArb: fc.Arbitrary<DayLimits> = fc
    .record({ min: fc.integer({ min: 1, max: 5 }), extra: fc.integer({ min: 0, max: 3 }) })
    .map(({ min, extra }) => ({ target: min + 1, min, max: min + extra, partial: false }));

  it("satisfies the withhold rule for any stops, limits and day-trip flag", () => {
    fc.assert(
      fc.property(stopsArb, limitsArb, fc.boolean(), (stops, limits, dayTrip) => {
        const res = evaluateDay(stops, limits, { dayTrip });
        const inputKeys = new Set(keysOf(stops));

        // subset of input, at most max, no stop both kept and removed
        for (const k of keysOf(res.stops)) expect(inputKeys.has(k)).toBe(true);
        for (const k of keysOf(res.removed)) expect(inputKeys.has(k)).toBe(true);
        expect(res.stops.length).toBeLessThanOrEqual(limits.max);
        const kept = new Set(keysOf(res.stops));
        for (const k of keysOf(res.removed)) expect(kept.has(k)).toBe(false);

        if (res.status === "verified") {
          expect(res.stops.length).toBeGreaterThanOrEqual(limits.min);
          let sum = 0;
          let long = 0;
          for (let i = 1; i < res.stops.length; i++) {
            const leg = legMinutes(res.stops[i - 1].location, res.stops[i].location);
            sum += leg;
            if (leg > MAX_LEG_TRAVEL_MIN) {
              long += 1;
              expect(dayTrip).toBe(true);
              expect(leg).toBeLessThanOrEqual(MAX_DAY_TRIP_LEG_MIN);
            }
            expect(res.stops[i - 1].travelToNextMin).toBe(leg);
          }
          expect(long).toBeLessThanOrEqual(1);
          expect(sum).toBeLessThanOrEqual(dayTravelLimit(dayTrip));
          for (let i = 0; i < res.stops.length - 1; i++) {
            expect(typeof res.stops[i].travelToNextMin).toBe("number");
          }
          // evaluating the result again returns the same day
          const again = evaluateDay(res.stops, limits, { dayTrip });
          expect(again.status).toBe("verified");
          expect(again.stops).toEqual(res.stops);
          expect(again.removed).toEqual([]);
        } else {
          // withheld: too few stops or travel
          expect(res.reason === "too-few" || res.reason === "travel").toBe(true);
          if (res.reason === "too-few") {
            expect(res.stops.length).toBeLessThan(limits.min);
          } else {
            expect(res.removed.length).toBeGreaterThan(0);
          }
        }

        // deterministic
        expect(evaluateDay(stops, limits, { dayTrip })).toEqual(res);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("dayTravelLimit grants a day trip exactly one longer leg", () => {
    expect(dayTravelLimit(false)).toBe(MAX_DAY_TRAVEL_MIN);
    expect(dayTravelLimit(true)).toBe(
      MAX_DAY_TRAVEL_MIN + (MAX_DAY_TRIP_LEG_MIN - MAX_LEG_TRAVEL_MIN),
    );
  });

  it("withholds a day with too few stops", () => {
    const limits = dayLimits("balanced", 2, 5); // min 3, max 5
    const res = evaluateDay([stop(0, 0), stop(1, 0.01)], limits, { dayTrip: false });
    expect(res.status).toBe("withheld");
    expect(res.reason).toBe("too-few");
    expect(res.removed).toEqual([]);
  });

  it("removes a stop 120 km away and keeps the day verified when enough stops remain", () => {
    const limits = dayLimits("balanced", 2, 5); // min 3, max 5
    const far = stop(4, 120 / KM_PER_DEG_LAT);
    const stops = [stop(0, 0), stop(1, 0.01), stop(2, 0.02), stop(3, 0.03), far];
    const res = evaluateDay(stops, limits, { dayTrip: false });
    expect(res.status).toBe("verified");
    expect(keysOf(res.removed)).toEqual(["p4"]);
    expect(keysOf(res.stops)).toEqual(["p0", "p1", "p2", "p3"]);
  });

  it("tolerates one 150-minute leg on a day-trip day but not otherwise", () => {
    const limits = dayLimits("balanced", 2, 5); // min 3, max 5
    const legKm = (150 * 25) / 60; // 62.5 km at 25 km/h
    const stops = [
      stop(0, 0),
      stop(1, 0.01),
      stop(2, 0.01 + legKm / KM_PER_DEG_LAT),
      stop(3, 0.02 + legKm / KM_PER_DEG_LAT),
    ];
    const trip = evaluateDay(stops, limits, { dayTrip: true });
    expect(trip.status).toBe("verified");
    expect(trip.removed).toEqual([]);
    expect(keysOf(trip.stops)).toEqual(["p0", "p1", "p2", "p3"]);
    expect(trip.stops[1].travelToNextMin).toBeGreaterThan(MAX_LEG_TRAVEL_MIN);

    const normal = evaluateDay(stops, limits, { dayTrip: false });
    expect(normal.removed.length).toBeGreaterThan(0);
  });
});
