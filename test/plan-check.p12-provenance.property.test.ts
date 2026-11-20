import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { applyPlan, checkPlan, type PlanContext } from "../lib/itinerary/plan-check";
import { dayLimits } from "../lib/itinerary/pace";
import type { DaySpec } from "../lib/itinerary/scheduler";
import type { PlaceCandidate } from "../lib/providers/google-places";

// Feature: chat-images-bedrock-planner, Property 12: Plan provenance
// **Validates: Requirements 8.3, 8.4, 8.5, 8.15, 8.17**

const NUM_RUNS = 100;

const OPEN_ALL_DAY = {
  periods: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
    open: { day: d, hour: 8, minute: 0 },
    close: { day: d, hour: 20, minute: 0 },
  })),
  weekdayDescriptions: ["Monday: 8:00 AM - 8:00 PM"],
};

function cand(id: string, name: string, o: Partial<PlaceCandidate> = {}): PlaceCandidate {
  return {
    placeId: id,
    name,
    address: `${id} Road, Old Town, France`,
    location: { lat: 0.001 * id.charCodeAt(id.length - 1), lng: 0.002 * id.charCodeAt(0) - 0.19 },
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

const A1 = cand("a1", "Alpha Fort", { hours: OPEN_ALL_DAY, photos: ["places/a1/photos/p1", "places/a1/photos/p2"], rating: 4.6 });
const A2 = cand("a2", "Beta Garden", { photos: ["places/a2/photos/p1"], rating: null });
const B1 = cand("b1", "Gamma Museum", { hours: OPEN_ALL_DAY, rating: 3.9 });
const B2 = cand("b2", "Delta Bridge", { photos: ["places/b2/photos/p9"] });
const SENT = [A1, A2, B1, B2];
const IDS = SENT.map((c) => c.placeId);
const BY_ID = new Map(SENT.map((c) => [c.placeId, c] as const));

function spec(n: number): DaySpec {
  return { day: n, date: null, weekday: null, limits: dayLimits("balanced", n, 2), earliestMin: 540 };
}

function ctx(): PlanContext {
  return {
    days: [
      { spec: spec(1), deterministicCount: 2 },
      { spec: spec(2), deterministicCount: 2 },
    ],
    sent: SENT,
    dates: ["2025-01-06", "2025-01-07"],
  };
}

interface RawStop {
  placeId: string;
  sentence: string;
  [k: string]: unknown;
}
interface RawDay {
  day: number;
  startTime: string;
  title: string;
  stops: RawStop[];
  [k: string]: unknown;
}
interface RawPlan {
  days: RawDay[];
  [k: string]: unknown;
}

const SENTENCES = ["Start with the old walls.", "A quiet green space.", "Worth a slow look.", "A calm stop nearby."];
const TITLES = ["Old Town walk", "Quiet morning"];
const START_TIMES = ["09:00", "09:30", "10:00", "10:30"];

/** A plan the checker should accept: the four sent places in any order, two per day. */
const validPlan: fc.Arbitrary<RawPlan> = fc
  .record({
    order: fc.shuffledSubarray(IDS, { minLength: 4, maxLength: 4 }),
    starts: fc.tuple(fc.constantFrom(...START_TIMES), fc.constantFrom(...START_TIMES)),
    sentences: fc.array(fc.constantFrom(...SENTENCES), { minLength: 4, maxLength: 4 }),
  })
  .map(({ order, starts, sentences }) => ({
    days: [0, 1].map((i) => ({
      day: i + 1,
      startTime: starts[i],
      title: TITLES[i],
      stops: [0, 1].map((j) => ({ placeId: order[i * 2 + j], sentence: sentences[i * 2 + j] })),
    })),
  }));

const junkKey = (allowed: string[]) =>
  fc
    .oneof(
      fc.constantFrom("name", "address", "location", "hours", "photos", "rating", "lat", "lng", "website", "price"),
      fc.string({ minLength: 1, maxLength: 8 }),
    )
    .filter((k) => !allowed.includes(k) && k !== "__proto__");

const junkValue = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null), fc.array(fc.string(), { maxLength: 3 }));

const hostile: fc.Arbitrary<{ label: string; plan: RawPlan }> = fc
  .tuple(validPlan, fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 1 }), fc.integer({ min: 0, max: 1 }), fc.integer({ min: 0, max: 3 }))
  .chain(([plan, kind, di, si, other]) =>
    fc
      .tuple(
        fc.string({ minLength: 1, maxLength: 12 }).filter((s) => !IDS.includes(s)),
        junkKey(["placeId", "sentence"]),
        junkKey(["day", "startTime", "title", "stops"]),
        junkKey(["days"]),
        junkValue,
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.constantFrom("name", "address", "location", "hours", "photos"),
      )
      .map(([fakeId, stopKey, dayKey, topKey, val, newName, field]) => {
        const p: RawPlan = JSON.parse(JSON.stringify(plan));
        const stop = p.days[di].stops[si];
        let label = "";
        switch (kind) {
          case 0: // invented placeId
            stop.placeId = fakeId;
            label = "invented-id";
            break;
          case 1: {
            // duplicate placeId (same day or across days)
            const target = p.days[(di + other) % 2].stops[(si + other + 1) % 2];
            if (target === stop) {
              p.days[1 - di].stops[si].placeId = stop.placeId;
            } else {
              target.placeId = stop.placeId;
            }
            label = "duplicate";
            break;
          }
          case 2: // renamed / overridden stop data, or extra stop field
            stop[field] = field === "name" ? newName : val;
            if (other % 2 === 1) stop[stopKey] = val;
            label = "renamed-stop";
            break;
          default: // extra fields at day or top level
            if (other % 2 === 0) p.days[di][dayKey] = val;
            else p[topKey] = val;
            label = "extra-field";
        }
        return { label, plan: p };
      }),
  );

describe("Property 12: plan provenance", () => {
  it("rejects every hostile plan (invented ids, duplicates, renamed stops, extra fields)", () => {
    fc.assert(
      fc.property(hostile, ({ plan }) => {
        const v = checkPlan(ctx(), plan);
        expect(v.ok).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("every accepted plan carries the sent candidate's placeId, name, address, location, hours and photos", () => {
    fc.assert(
      fc.property(validPlan, (plan) => {
        const c = ctx();
        const v = checkPlan(c, plan);
        expect(v.ok).toBe(true);
        if (!v.ok) return;
        const applied = applyPlan(c, v);
        const seen = new Set<string>();
        for (const day of applied.days) {
          for (const s of day.stops) {
            const sent = BY_ID.get(s.candidate.placeId);
            expect(sent).toBeDefined();
            if (!sent) continue;
            expect(seen.has(sent.placeId)).toBe(false);
            seen.add(sent.placeId);
            expect(s.candidate.placeId).toBe(sent.placeId);
            expect(s.candidate.name).toBe(sent.name);
            expect(s.candidate.address).toBe(sent.address);
            expect(s.candidate.location).toEqual(sent.location);
            expect(s.candidate.hours).toEqual(sent.hours);
            expect(s.candidate.photos).toEqual(sent.photos);
          }
        }
        // Same stops, same order as the plan sent in.
        expect(applied.days.map((d) => d.stops.map((s) => s.candidate.placeId))).toEqual(
          plan.days.map((d) => d.stops.map((s) => s.placeId)),
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("hostile plans never survive: a check that accepts must satisfy provenance", () => {
    fc.assert(
      fc.property(hostile, ({ plan }) => {
        const c = ctx();
        const v = checkPlan(c, plan);
        if (!v.ok) return;
        const applied = applyPlan(c, v);
        for (const d of applied.days) for (const s of d.stops) expect(s.candidate).toBe(BY_ID.get(s.candidate.placeId));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
