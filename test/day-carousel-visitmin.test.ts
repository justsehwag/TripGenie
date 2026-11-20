import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { cleanNewActivityFields } from "../lib/itinerary/activity-fields";
import { sanitizeStoredVerification } from "../lib/itinerary/revalidate";
import { mapDays, plainDays } from "../lib/itinerary/map-days";
import type { ScheduleResult } from "../lib/itinerary/scheduler";
import type { PlaceCandidate } from "../lib/providers/google-places";

function cand(id: string): PlaceCandidate {
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
  };
}

const pool = [cand("a1"), cand("a2")];

function schedule(v1: number, v2: number, start1 = 540): ScheduleResult {
  return {
    days: [
      {
        day: 1,
        stops: [
          { placeId: "a1", startMin: start1, endMin: start1 + 30, visitMin: v1, travelToNextMin: 5, hoursLabel: null, hoursText: null },
          { placeId: "a2", startMin: start1 + 60, endMin: start1 + 90, visitMin: v2, hoursLabel: null, hoursText: null },
        ],
      },
    ],
    shortDays: [],
    emptyDays: [],
  };
}

const validVisit = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 1440;

const visitArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.integer({ min: -100, max: 3000 }),
  fc.double({ noNaN: false }),
  fc.constantFrom(0, -0, 1, 1440, 1441, 1.5, NaN, Infinity, -Infinity),
  fc.string(),
  fc.constant(null),
  fc.boolean(),
);

const baseArb = fc.record(
  {
    time: fc.constantFrom("09:00", "13:30"),
    title: fc.string(),
    cost: fc.nat(1000),
    travelToNextMin: fc.integer({ min: 0, max: 600 }),
  },
  { requiredKeys: ["time", "title", "cost"] },
);

describe("Property 7: visitMin validation is idempotent and drops only the bad field", () => {
  it("cleanNewActivityFields keeps valid, drops only visitMin otherwise, and is idempotent", () => {
    fc.assert(
      fc.property(baseArb, visitArb, (base, v) => {
        const a: Record<string, unknown> = { ...base, visitMin: v };
        const out = cleanNewActivityFields(a);
        if (validVisit(v)) {
          expect(out).toBeNull();
        } else {
          expect(out).not.toBeNull();
          expect(out && "visitMin" in out).toBe(false);
          for (const k of Object.keys(a)) if (k !== "visitMin") expect(out![k]).toEqual(a[k]);
          expect(Object.keys(out!).length).toBe(Object.keys(a).length - 1);
          expect(cleanNewActivityFields(out!)).toBeNull();
        }
      }),
      { numRuns: 100 },
    );
  });

  it("sanitizeStoredVerification gives the same result and is idempotent", () => {
    fc.assert(
      fc.property(baseArb, visitArb, (base, v) => {
        const it = { days: [{ day: 1, activities: [{ ...base, visitMin: v }] }] };
        const once = sanitizeStoredVerification(it);
        const act = (once.days[0].activities[0] as unknown) as Record<string, unknown>;
        if (validVisit(v)) {
          expect(once).toBe(it);
          expect(act.visitMin).toBe(v);
        } else {
          expect("visitMin" in act).toBe(false);
          for (const k of Object.keys(base)) expect(act[k]).toEqual((base as Record<string, unknown>)[k]);
        }
        expect(sanitizeStoredVerification(once)).toBe(once);
      }),
      { numRuns: 100 },
    );
  });
});

describe("Property 8: mapDays persists the scheduler visit length", () => {
  it("copies a valid visitMin and keeps time = startMin", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1440 }),
        fc.integer({ min: 1, max: 1440 }),
        fc.integer({ min: 0, max: 600 }),
        (v1, v2, start) => {
          const r = mapDays({ days: plainDays(schedule(v1, v2, start), pool) });
          const [a, b] = r.days[0].activities;
          const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
          expect(a.visitMin).toBe(v1);
          expect(b.visitMin).toBe(v2);
          expect(a.time).toBe(hhmm(start));
          expect(b.time).toBe(hhmm(start + 60));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("leaves visitMin absent for an invalid scheduler value", () => {
    for (const bad of [0, -5, 1441, 2.5, NaN]) {
      const r = mapDays({ days: plainDays(schedule(bad, 60), pool) });
      expect("visitMin" in r.days[0].activities[0]).toBe(false);
      expect(r.days[0].activities[1].visitMin).toBe(60);
    }
  });
});

describe("stops without visitMin pass sanitizeStoredVerification unchanged", () => {
  it("batch-path stop and an old itinerary", () => {
    const batchStop = {
      time: "09:00",
      title: "Louvre",
      description: "Louvre",
      cost: 0,
      area: "1st",
      placeId: "p1",
      placeName: "Louvre",
      verified: true,
      mapsUrl: "https://www.google.com/maps/search/?api=1&query=Louvre&query_place_id=p1",
      location: { lat: 48.86, lng: 2.33 },
      travelToNextMin: 10,
    };
    const it = { days: [{ day: 1, date: "2025-01-06", title: "D", theme: "t", total: 0, activities: [batchStop] }] };
    const out = sanitizeStoredVerification(it);
    expect(out).toBe(it);
    expect("visitMin" in out.days[0].activities[0]).toBe(false);
    expect(cleanNewActivityFields(batchStop)).toBeNull();

    const old = { days: [{ day: 1, activities: [{ time: "10:00", title: "x", cost: 5 }] }] };
    expect(sanitizeStoredVerification(old)).toBe(old);
  });
});
