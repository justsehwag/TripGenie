// Feature: chat-images-bedrock-planner, Property 13: Plan feasibility
// Validates: Requirements 8.6, 8.7, 8.8, 8.9, 8.17
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { applyPlan, checkPlan, type PlanContext } from "@/lib/itinerary/plan-check";
import { mealKind, scheduleBatch, visitMinutes, type DaySpec } from "@/lib/itinerary/scheduler";
import { legMinutesUp } from "@/lib/itinerary/geo";
import { typicalWeekday } from "@/lib/itinerary/hours";
import { dayLimits } from "@/lib/itinerary/pace";
import {
  DAY_WINDOW_END_MIN,
  DAY_WINDOW_START_MIN,
  DINNER_WINDOW_MIN,
  LUNCH_WINDOW_MIN,
  MAX_DAY_TRAVEL_MIN,
  MAX_LEG_TRAVEL_MIN,
  UNLISTED_HOURS_END_MIN,
  UNLISTED_HOURS_START_MIN,
} from "@/lib/itinerary/constants";
import type { OpeningPeriod, PlaceCandidate, PlaceHours } from "@/lib/providers/google-places";

const DAY_MIN = 1440;
type Iv = [number, number];

/* ----------------------------- generators ----------------------------- */

const pointArb = (day: number) =>
  fc.record({ day: fc.constant(day), hour: fc.integer({ min: 0, max: 23 }), minute: fc.constantFrom(0, 15, 30, 45) });

function periodsForDayArb(d: number): fc.Arbitrary<OpeningPeriod[]> {
  const next = (d + 1) % 7;
  const sameDay = fc.tuple(pointArb(d), pointArb(d)).map(([open, close]): OpeningPeriod => ({ open, close }));
  const crossing = fc.tuple(pointArb(d), pointArb(next)).map(([open, close]): OpeningPeriod => ({ open, close }));
  const wide = fc.constant<OpeningPeriod[]>([
    { open: { day: d, hour: 8, minute: 0 }, close: { day: d, hour: 22, minute: 0 } },
  ]);
  const midnightCross = fc.constant<OpeningPeriod[]>([
    { open: { day: d, hour: 18, minute: 0 }, close: { day: next, hour: 2, minute: 0 } },
  ]);
  return fc.oneof(
    { weight: 1, arbitrary: fc.constant<OpeningPeriod[]>([]) },
    { weight: 4, arbitrary: wide },
    { weight: 2, arbitrary: midnightCross },
    { weight: 2, arbitrary: fc.array(fc.oneof(sameDay, crossing), { minLength: 1, maxLength: 2 }) },
  );
}

const hoursArb: fc.Arbitrary<PlaceHours | null> = fc.oneof(
  { weight: 2, arbitrary: fc.constant(null) },
  {
    weight: 6,
    arbitrary: fc.tuple(...[0, 1, 2, 3, 4, 5, 6].map(periodsForDayArb)).map(
      (per): PlaceHours => ({
        periods: per.flat(),
        weekdayDescriptions: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((s) => `${s}: text`),
      }),
    ),
  },
  {
    // 24/7: Google's single "always open" period.
    weight: 2,
    arbitrary: fc.constant<PlaceHours>({
      periods: [{ open: { day: 0, hour: 0, minute: 0 } }],
      weekdayDescriptions: [],
    }),
  },
  {
    weight: 1,
    arbitrary: fc.constant<PlaceHours>({
      periods: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
        open: { day: d, hour: 0, minute: 0 },
        close: { day: (d + 1) % 7, hour: 0, minute: 0 },
      })),
      weekdayDescriptions: [],
    }),
  },
);

const TYPES = ["restaurant", "restaurant", "museum", "tourist_attraction", "park", "beach", "temple", "weird"];

function candArb(i: number): fc.Arbitrary<PlaceCandidate> {
  return fc
    .record({
      hours: hoursArb,
      primaryType: fc.constantFrom(...TYPES),
      lat: fc.double({ min: 0, max: 0.4, noNaN: true }),
      lng: fc.double({ min: 0, max: 0.4, noNaN: true }),
    })
    .map(
      (r): PlaceCandidate => ({
        placeId: `p${i}`,
        name: `Spot${String.fromCharCode(97 + i)}${String.fromCharCode(110 + i)}`,
        address: "Somewhere, Old Town",
        location: { lat: r.lat, lng: r.lng },
        rating: 4,
        userRatingCount: 100,
        hours: r.hours,
        utcOffsetMinutes: null,
        types: [],
        primaryType: r.primaryType,
        businessStatus: "OPERATIONAL",
        googleMapsUri: null,
        photos: [],
      }),
    );
}

const poolArb = fc
  .integer({ min: 1, max: 10 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => candArb(i))));

const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

const scenarioArb = fc
  .record({
    pool: poolArb,
    totalDays: fc.integer({ min: 1, max: 3 }),
    startWeekday: fc.option(fc.integer({ min: 0, max: 6 }), { nil: null }),
    pace: fc.constantFrom("relaxed", "balanced", "packed"),
    arrival: fc.option(fc.integer({ min: 540, max: 720 }), { nil: null }),
    mode: fc.constantFrom("scheduler", "scheduler", "random"),
    // random mode: per candidate a day index (-1 = unused) and an order key
    assign: fc.array(fc.tuple(fc.integer({ min: -1, max: 2 }), fc.integer({ min: 0, max: 100 })), {
      minLength: 10,
      maxLength: 10,
    }),
    detCounts: fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 3, maxLength: 3 }),
    startOffsets: fc.array(fc.integer({ min: 0, max: 8 }), { minLength: 3, maxLength: 3 }),
    reverseDays: fc.boolean(),
  })
  .filter((s) => s.pool.length > 0);

/* ------------------------------- oracle ------------------------------- */

/** Independent reading of the hours rules: a period belongs to its opening weekday. */
function openIntervals(h: PlaceHours, weekday: number): Iv[] {
  if (h.periods.length === 1) {
    const p = h.periods[0];
    if (p.open.day === 0 && p.open.hour === 0 && p.open.minute === 0 && !p.close) return [[0, DAY_MIN]];
  }
  const raw: Iv[] = [];
  for (const p of h.periods) {
    if (p.open.day !== weekday) continue;
    const s = p.open.hour * 60 + p.open.minute;
    if (!p.close) {
      raw.push([0, DAY_MIN]);
      continue;
    }
    const e = p.close.hour * 60 + p.close.minute;
    if (p.close.day === p.open.day && e > s) raw.push([s, e]);
    else if (s === 0 && e === 0) raw.push([0, DAY_MIN]);
    else raw.push([s, DAY_MIN]);
  }
  return raw;
}

const inside = (ivs: Iv[], s: number, e: number) => ivs.some(([a, b]) => s >= a && e <= b);
const MEALS: Iv[] = [
  [LUNCH_WINDOW_MIN[0], LUNCH_WINDOW_MIN[1]],
  [DINNER_WINDOW_MIN[0], DINNER_WINDOW_MIN[1]],
];

/** True when the visit lies inside an opening period of the scheduled weekday (or 09:00-18:00 without hours). */
function openWindowsOn(day: DaySpec, c: PlaceCandidate, startMin: number, endMin: number): boolean {
  if (!c.hours) return startMin >= UNLISTED_HOURS_START_MIN && endMin <= UNLISTED_HOURS_END_MIN;
  if (day.weekday !== null) return inside(openIntervals(c.hours, day.weekday), startMin, endMin);
  // Undated: the scheduled weekday is the place's typical weekday.
  const wd = typicalWeekday(c.hours);
  return wd !== null && inside(openIntervals(c.hours, wd), startMin, endMin);
}

/* ------------------------------- builders ------------------------------ */

interface Built {
  ctx: PlanContext;
  plan: { days: Array<{ day: number; startTime: string; title: string; stops: Array<{ placeId: string; sentence: string }> }> };
}

type ArbValue<A> = A extends fc.Arbitrary<infer T> ? T : never;
type Scenario = ArbValue<typeof scenarioArb>;

function build(s: Scenario): Built {
  const specs: DaySpec[] = Array.from({ length: s.totalDays }, (_, k): DaySpec => {
    const n = k + 1;
    return {
      day: n,
      date: null,
      weekday: s.startWeekday === null ? null : (s.startWeekday + k) % 7,
      limits: dayLimits(s.pace, n, s.totalDays),
      earliestMin: n === 1 && s.arrival !== null ? s.arrival : DAY_WINDOW_START_MIN,
    };
  });
  let perDay: string[][];
  if (s.mode === "scheduler") {
    const res = scheduleBatch({ days: specs, pool: s.pool, interests: ["food"], pace: s.pace as never });
    perDay = res.days.map((d) => d.stops.map((st) => st.placeId));
  } else {
    perDay = specs.map(() => []);
    const keyed: Array<{ id: string; day: number; key: number }> = [];
    s.pool.forEach((c, i) => {
      const [d, key] = s.assign[i];
      if (d >= 0 && d < specs.length) keyed.push({ id: c.placeId, day: d, key });
    });
    keyed.sort((a, b) => a.key - b.key);
    for (const k of keyed) perDay[k.day].push(k.id);
  }
  const det = specs.map((_, i) =>
    s.mode === "scheduler" ? perDay[i].length : s.detCounts[i],
  );
  const days = specs.map((spec, i) => ({
    day: spec.day,
    startTime: fmt(Math.min(DAY_WINDOW_END_MIN - 1, spec.earliestMin + s.startOffsets[i] * 15)),
    title: `Outing number ${String.fromCharCode(97 + i)}${String.fromCharCode(97 + i)}`,
    stops: perDay[i].map((id) => ({ placeId: id, sentence: "A pleasant place to spend time." })),
  }));
  if (s.reverseDays) days.reverse();
  return {
    ctx: {
      days: specs.map((spec, i) => ({ spec, deterministicCount: det[i] })),
      sent: s.pool,
      dates: specs.map(() => null),
    },
    plan: { days },
  };
}

/* -------------------------------- tests -------------------------------- */

describe("Property 13: plan feasibility", () => {
  it("every plan the checker accepts is feasible on hours, window, meals, pace, travel and days", () => {
    const seen = { accepted: 0, rejected: 0, stops: 0, meals: 0, unlisted: 0, always: 0 };
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const { ctx, plan } = build(s);
        const v = checkPlan(ctx, plan);
        if (!v.ok) {
          seen.rejected += 1;
          return;
        }
        seen.accepted += 1;

        // every day is present, once
        const wanted = ctx.days.map((d) => d.spec.day).sort((a, b) => a - b);
        expect(v.days.map((d) => d.day).sort((a, b) => a - b)).toEqual(wanted);

        const applied = applyPlan(ctx, v);
        expect(applied.days.map((d) => d.day).sort((a, b) => a - b)).toEqual(wanted);

        for (const day of applied.days) {
          const { spec, deterministicCount } = ctx.days.find((d) => d.spec.day === day.day)!;
          const n = day.stops.length;

          // pace limits
          const lower = deterministicCount <= 0 ? 0 : Math.max(1, Math.min(spec.limits.min, deterministicCount));
          expect(n).toBeGreaterThanOrEqual(lower);
          expect(n).toBeLessThanOrEqual(spec.limits.max);

          const startPref = v.startMin.get(day.day) as number;
          const usedMeal = new Set<number>();
          let travelSum = 0;
          let prevEnd = -1;
          let prev: PlaceCandidate | null = null;

          day.stops.forEach((st) => {
            const c = st.candidate;
            const t = st.scheduled;
            expect(t).not.toBeNull();
            if (!t) return;
            seen.stops += 1;
            expect(t.placeId).toBe(c.placeId);
            expect(t.endMin).toBe(t.startMin + visitMinutes(c));

            // inside an opening period of the scheduled weekday
            expect(openWindowsOn(spec, c, t.startMin, t.endMin)).toBe(true);
            if (!c.hours) seen.unlisted += 1;
            else if (c.hours.periods.length === 1 && !c.hours.periods[0].close) seen.always += 1;

            // inside the day window and not before the start of the day
            expect(t.startMin).toBeGreaterThanOrEqual(DAY_WINDOW_START_MIN);
            expect(t.endMin).toBeLessThanOrEqual(DAY_WINDOW_END_MIN);
            expect(t.startMin).toBeGreaterThanOrEqual(spec.earliestMin);
            expect(t.startMin).toBeGreaterThanOrEqual(startPref);

            // meal windows for restaurants, each window used at most once
            if (mealKind(c)) {
              seen.meals += 1;
              const w = MEALS.findIndex(([a, b]) => t.startMin >= a && t.endMin <= b);
              expect(w).toBeGreaterThanOrEqual(0);
              expect(usedMeal.has(w)).toBe(false);
              usedMeal.add(w);
            }

            // travel limits
            if (prev) {
              const leg = legMinutesUp(prev.location, c.location);
              expect(leg).toBeLessThanOrEqual(MAX_LEG_TRAVEL_MIN);
              travelSum += leg;
              expect(travelSum).toBeLessThanOrEqual(MAX_DAY_TRAVEL_MIN);
              expect(t.startMin).toBeGreaterThanOrEqual(prevEnd + leg);
            }
            prevEnd = t.endMin;
            prev = c;
          });
        }
      }),
      { numRuns: 300 },
    );
    // The property must not hold vacuously.
    expect(seen.accepted).toBeGreaterThan(20);
    expect(seen.rejected).toBeGreaterThan(0);
    expect(seen.stops).toBeGreaterThan(50);
  });
});
