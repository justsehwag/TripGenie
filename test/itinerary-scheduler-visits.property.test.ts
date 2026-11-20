// Feature: places-first-itinerary, Property 6: Scheduled visits lie inside opening hours, windows and travel limits
// Validates: Requirements 2.7, 2.8, 3.1, 3.2, 3.5, 3.6, 3.7, 3.9, 3.10
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  fitSequence,
  mealKind,
  scheduleBatch,
  visitMinutes,
  type DaySpec,
  type ScheduledStop,
} from "@/lib/itinerary/scheduler";
import { typicalWeekday } from "@/lib/itinerary/hours";
import { legMinutesUp } from "@/lib/itinerary/geo";
import { dayLimits } from "@/lib/itinerary/pace";
import { HOURS_NOT_LISTED, TYPICAL_HOURS } from "@/lib/itinerary/labels";
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

const NUM_RUNS = { numRuns: 200 } as const;
const DAY_MIN = 1440;
type Iv = [number, number];

/* ----------------------------- generators ----------------------------- */

const pointArb = (day: number) =>
  fc.record({ day: fc.constant(day), hour: fc.integer({ min: 0, max: 23 }), minute: fc.constantFrom(0, 15, 30, 45) });

/** One weekday's periods: closed, 24 hours, 00:00-00:00, same-day, midnight-crossing. */
function periodsForDayArb(d: number): fc.Arbitrary<OpeningPeriod[]> {
  const next = (d + 1) % 7;
  const sameDay = fc
    .tuple(pointArb(d), pointArb(d))
    .map(([open, close]): OpeningPeriod => ({ open, close }));
  const crossing = fc
    .tuple(pointArb(d), pointArb(next))
    .map(([open, close]): OpeningPeriod => ({ open, close }));
  const allDayNoClose = fc.constant<OpeningPeriod[]>([{ open: { day: d, hour: 0, minute: 0 } }]);
  const allDayZero = fc.constant<OpeningPeriod[]>([
    { open: { day: d, hour: 0, minute: 0 }, close: { day: next, hour: 0, minute: 0 } },
  ]);
  return fc.oneof(
    { weight: 2, arbitrary: fc.constant<OpeningPeriod[]>([]) },
    { weight: 1, arbitrary: allDayNoClose },
    { weight: 1, arbitrary: allDayZero },
    { weight: 4, arbitrary: fc.array(fc.oneof(sameDay, crossing), { minLength: 1, maxLength: 2 }) },
  );
}

const hoursArb: fc.Arbitrary<PlaceHours | null> = fc.oneof(
  { weight: 1, arbitrary: fc.constant(null) },
  {
    weight: 5,
    arbitrary: fc
      .tuple(...[0, 1, 2, 3, 4, 5, 6].map(periodsForDayArb))
      .map((per): PlaceHours => ({
        periods: per.flat(),
        weekdayDescriptions: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((s) => `${s}: text`),
      })),
  },
  {
    // 24-hour place: every weekday open all day, no close.
    weight: 1,
    arbitrary: fc.constant<PlaceHours>({
      periods: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ open: { day: d, hour: 0, minute: 0 } })),
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
      lat: fc.double({ min: 0, max: 0.6, noNaN: true }),
      lng: fc.double({ min: 0, max: 0.6, noNaN: true }),
      rating: fc.option(fc.integer({ min: 10, max: 50 }).map((n) => n / 10), { nil: null }),
      count: fc.option(fc.integer({ min: 0, max: 5000 }), { nil: null }),
    })
    .map(
      (r): PlaceCandidate => ({
        placeId: `p${i}`,
        name: `Place ${i}`,
        address: "Somewhere",
        location: { lat: r.lat, lng: r.lng },
        rating: r.rating,
        userRatingCount: r.count,
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
  .integer({ min: 0, max: 14 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => candArb(i))));

const scenarioArb = fc.record({
  pool: poolArb,
  totalDays: fc.integer({ min: 1, max: 4 }),
  startWeekday: fc.option(fc.integer({ min: 0, max: 6 }), { nil: null }),
  pace: fc.constantFrom("relaxed", "balanced", "packed", "bogus"),
  interests: fc.constantFrom<string[] | undefined>(undefined, [], ["food"], ["museums"], ["nature", "food"]),
  arrival: fc.option(fc.integer({ min: 0, max: DAY_MIN - 1 }), { nil: null }),
});

/* ------------------------------- oracle ------------------------------- */

/** Independent reading of the rules: a period belongs to its opening weekday. */
function openIntervals(h: PlaceHours, weekday: number): Iv[] {
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
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Iv[] = [];
  for (const iv of raw) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  return merged;
}

const inside = (ivs: Iv[], s: number, e: number) => ivs.some(([a, b]) => s >= a && e <= b);
const LUNCH: Iv = [LUNCH_WINDOW_MIN[0], LUNCH_WINDOW_MIN[1]];
const DINNER: Iv = [DINNER_WINDOW_MIN[0], DINNER_WINDOW_MIN[1]];
const MEALS: Iv[] = [LUNCH, DINNER];
const DAY_WIN: Iv = [DAY_WINDOW_START_MIN, DAY_WINDOW_END_MIN];

function weekdayForStop(day: DaySpec, c: PlaceCandidate): number | null {
  if (!c.hours) return null;
  return day.weekday !== null ? day.weekday : typicalWeekday(c.hours);
}

/** Opening windows (before meal restriction) from the oracle. */
function baseWindows(day: DaySpec, c: PlaceCandidate): Iv[] {
  let ivs: Iv[];
  if (!c.hours) ivs = [[UNLISTED_HOURS_START_MIN, UNLISTED_HOURS_END_MIN]];
  else {
    const wd = weekdayForStop(day, c);
    ivs = wd === null ? [] : openIntervals(c.hours, wd);
  }
  return ivs
    .map(([a, b]): Iv => [Math.max(a, DAY_WIN[0]), Math.min(b, DAY_WIN[1])])
    .filter(([a, b]) => b > a);
}

/** Checks every clause of Property 6 for one scheduled day. Returns after expect failures throw. */
function checkDay(day: DaySpec, stops: ScheduledStop[], byId: Map<string, PlaceCandidate>): void {
  expect(stops.length).toBeLessThanOrEqual(day.limits.max);
  const usedMeal = new Set<number>();
  let travelSum = 0;
  let prevEnd = -1;
  let prev: PlaceCandidate | null = null;

  stops.forEach((st, idx) => {
    const c = byId.get(st.placeId) as PlaceCandidate;
    expect(c).toBeDefined();
    const visit = visitMinutes(c);
    expect(st.visitMin).toBe(visit);
    expect(st.endMin).toBe(st.startMin + visit);
    expect(Number.isInteger(st.startMin)).toBe(true);

    // inside opening period of the weekday, day window, arrival
    const base = baseWindows(day, c);
    expect(inside(base, st.startMin, st.endMin)).toBe(true);
    expect(st.startMin).toBeGreaterThanOrEqual(DAY_WIN[0]);
    expect(st.endMin).toBeLessThanOrEqual(DAY_WIN[1]);
    expect(st.startMin).toBeGreaterThanOrEqual(day.earliestMin);

    // no hours: label and 09:00-18:00
    if (!c.hours) {
      expect(st.hoursLabel).toBe(HOURS_NOT_LISTED);
      expect(st.startMin).toBeGreaterThanOrEqual(UNLISTED_HOURS_START_MIN);
      expect(st.endMin).toBeLessThanOrEqual(UNLISTED_HOURS_END_MIN);
    } else {
      expect(st.hoursLabel).toBe(day.weekday === null ? TYPICAL_HOURS : null);
    }

    // restaurants only in an unused meal window
    let allowed: Iv[] = base;
    if (mealKind(c)) {
      const w = MEALS.findIndex(([a, b]) => st.startMin >= a && st.endMin <= b);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(usedMeal.has(w)).toBe(false);
      const free = MEALS.filter((_, k) => !usedMeal.has(k));
      allowed = free.flatMap((m) =>
        base
          .map(([a, b]): Iv => [Math.max(a, m[0]), Math.min(b, m[1])])
          .filter(([a, b]) => b > a),
      );
      usedMeal.add(w);
    }

    // travel legs
    let notBefore = day.earliestMin;
    if (prev) {
      const travel = legMinutesUp(prev.location, c.location);
      expect(travel).toBeLessThanOrEqual(MAX_LEG_TRAVEL_MIN);
      expect(stops[idx - 1].travelToNextMin).toBe(travel);
      travelSum += travel;
      expect(travelSum).toBeLessThanOrEqual(MAX_DAY_TRAVEL_MIN);
      expect(st.startMin).toBeGreaterThanOrEqual(prevEnd + travel);
      notBefore = Math.max(notBefore, prevEnd + travel);
    }

    // earliest whole-minute start: brute-force minute scan
    for (let m = Math.ceil(notBefore); m < st.startMin; m++) {
      if (inside(allowed, m, m + visit)) {
        throw new Error(
          `Start ${st.startMin} for ${st.placeId} is not the earliest; ${m} also fits (notBefore ${notBefore})`,
        );
      }
    }

    prevEnd = st.endMin;
    prev = c;
  });
  if (stops.length > 0) expect(stops[stops.length - 1].travelToNextMin).toBeUndefined();
}

function daysFor(s: { totalDays: number; startWeekday: number | null; pace: string; arrival: number | null }): DaySpec[] {
  return Array.from({ length: s.totalDays }, (_, k): DaySpec => {
    const n = k + 1;
    return {
      day: n,
      date: null,
      weekday: s.startWeekday === null ? null : (s.startWeekday + k) % 7,
      limits: dayLimits(s.pace, n, s.totalDays),
      earliestMin: n === 1 && s.arrival !== null ? s.arrival : DAY_WINDOW_START_MIN,
    };
  });
}

/* -------------------------------- tests -------------------------------- */

const coverage = { stops: 0, meals: 0, unlisted: 0 };

describe("Property 6: scheduled visits lie inside opening hours, windows and travel limits", () => {
  it("scheduleBatch honours hours, windows, meal windows, travel limits and earliest start", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const days = daysFor(s);
        const res = scheduleBatch({ days, pool: s.pool, interests: s.interests, pace: s.pace as never });
        const byId = new Map(s.pool.map((c) => [c.placeId, c]));
        expect(res.days.length).toBe(days.length);
        const seen = new Set<string>();
        res.days.forEach((d, i) => {
          checkDay(days[i], d.stops, byId);
          for (const st of d.stops) {
            coverage.stops += 1;
            if (mealKind(byId.get(st.placeId) as PlaceCandidate)) coverage.meals += 1;
            if (st.hoursLabel === HOURS_NOT_LISTED) coverage.unlisted += 1;
            expect(seen.has(st.placeId)).toBe(false);
            seen.add(st.placeId);
          }
        });
      }),
      NUM_RUNS,
    );
  });

  it("the generated scenarios actually schedule stops, meals and unlisted-hours places", () => {
    expect(coverage.stops).toBeGreaterThan(100);
    expect(coverage.meals).toBeGreaterThan(0);
    expect(coverage.unlisted).toBeGreaterThan(0);
  });

  it("fitSequence on arbitrary orders: a returned fit satisfies every clause", () => {
    fc.assert(
      fc.property(scenarioArb, fc.integer({ min: 0, max: 1_000_000 }), (s, seed) => {
        const days = daysFor(s);
        const day = days[0];
        // deterministic shuffle, at most 5 candidates
        const order = s.pool
          .map((c, i) => ({ c, k: (i * 2654435761 + seed) % 9973 }))
          .sort((a, b) => a.k - b.k)
          .slice(0, 5)
          .map((x) => x.c);
        const fit = fitSequence(day, order);
        if (fit === null) return;
        expect(fit.map((x) => x.placeId)).toEqual(order.map((c) => c.placeId));
        // fitSequence itself is not capped by limits.max, so lift the cap for this check
        const byId = new Map(order.map((c) => [c.placeId, c]));
        checkDay({ ...day, limits: { ...day.limits, max: 99 } }, fit, byId);
      }),
      NUM_RUNS,
    );
  });

  it("a place with no period on the weekday is never scheduled that day", () => {
    fc.assert(
      fc.property(scenarioArb.filter((s) => s.startWeekday !== null), (s) => {
        const days = daysFor(s);
        const res = scheduleBatch({ days, pool: s.pool, interests: s.interests, pace: s.pace as never });
        const byId = new Map(s.pool.map((c) => [c.placeId, c]));
        res.days.forEach((d, i) => {
          for (const st of d.stops) {
            const c = byId.get(st.placeId) as PlaceCandidate;
            if (c.hours) expect(openIntervals(c.hours, days[i].weekday as number).length).toBeGreaterThan(0);
          }
        });
      }),
      NUM_RUNS,
    );
  });
});
