import type { PlaceCandidate } from "../providers/google-places";
import type { HoursLabel } from "../types";
import {
  DAY_WINDOW_END_MIN,
  DAY_WINDOW_START_MIN,
  DINNER_WINDOW_MIN,
  LUNCH_WINDOW_MIN,
  MAX_DAY_TRAVEL_MIN,
  MAX_LEG_TRAVEL_MIN,
  UNLISTED_HOURS_END_MIN,
  UNLISTED_HOURS_START_MIN,
} from "./constants";
import { haversineKm, legMinutesUp, reorderIfShorter } from "./geo";
import {
  earliestStart,
  periodsFor,
  typicalWeekday,
  weekdayDescription,
  type Interval,
} from "./hours";
import { resolvePace, type DayLimits, type Pace } from "./pace";
import { DEFAULT_VISIT_MINUTES, MEAL_TYPES, VISIT_MINUTES } from "./place-categories";
import { HOURS_NOT_LISTED, TYPICAL_HOURS } from "./labels";

/**
 * Pure, total, deterministic scheduler for the places-first itinerary.
 * No clock, no randomness, no I/O. `fitSequence` is the single place where
 * start times are decided.
 */

export type { HoursLabel };

export interface DaySpec {
  /** Absolute day number in the trip. */
  day: number;
  /** yyyy-mm-dd or null without a start date. */
  date: string | null;
  /** 0..6 (0 = Sunday) from the date, null without a start date. */
  weekday: number | null;
  limits: DayLimits;
  /** 540 (09:00), or the flight arrival time on day 1. */
  earliestMin: number;
}

export interface ScheduledStop {
  placeId: string;
  startMin: number;
  endMin: number;
  visitMin: number;
  /** ceil legMinutes to the next Stop of the day (absent on the last Stop). */
  travelToNextMin?: number;
  hoursLabel: HoursLabel | null;
  /** Google's weekday description, verbatim, or null. */
  hoursText: string | null;
}

export interface ScheduledDay {
  day: number;
  stops: ScheduledStop[];
}

export interface ScheduleInput {
  days: readonly DaySpec[];
  /** Already filtered. Order is the tie-break order. */
  pool: readonly PlaceCandidate[];
  interests: readonly unknown[] | undefined;
  pace: Pace;
}

export interface ScheduleResult {
  days: ScheduledDay[];
  /** Fewer Stops than limits.min but at least 1. */
  shortDays: number[];
  /** 0 Stops. */
  emptyDays: number[];
}

const DAY_WINDOW: Interval = [DAY_WINDOW_START_MIN, DAY_WINDOW_END_MIN];
const UNLISTED_WINDOW: Interval = [UNLISTED_HOURS_START_MIN, UNLISTED_HOURS_END_MIN];
const MEAL_WINDOWS: readonly Interval[] = [
  [LUNCH_WINDOW_MIN[0], LUNCH_WINDOW_MIN[1]],
  [DINNER_WINDOW_MIN[0], DINNER_WINDOW_MIN[1]],
];

function has(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** Visit length in minutes: by primary type, then the first matching type, else 60. */
export function visitMinutes(c: PlaceCandidate): number {
  if (!c) return DEFAULT_VISIT_MINUTES;
  if (typeof c.primaryType === "string" && has(VISIT_MINUTES, c.primaryType)) {
    return VISIT_MINUTES[c.primaryType];
  }
  if (Array.isArray(c.types)) {
    for (const t of c.types) {
      if (typeof t === "string" && has(VISIT_MINUTES, t)) return VISIT_MINUTES[t];
    }
  }
  return DEFAULT_VISIT_MINUTES;
}

/** True when the primary type is restaurant-like, so meal windows apply. */
export function mealKind(c: PlaceCandidate): boolean {
  return !!c && typeof c.primaryType === "string" && MEAL_TYPES.includes(c.primaryType);
}

const ARRIVAL_RE =
  /^(?:\d{4}-\d{2}-\d{2}[T ])?(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/** "HH:MM", "YYYY-MM-DD HH:MM" or ISO with T, read as destination wall-clock minutes. Else null. */
export function parseArrivalMin(arrive: unknown): number | null {
  if (typeof arrive !== "string") return null;
  const m = ARRIVAL_RE.exec(arrive.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}

function intersect(windows: readonly Interval[], bound: Interval): Interval[] {
  const out: Interval[] = [];
  for (const w of windows) {
    const s = Math.max(w[0], bound[0]);
    const e = Math.min(w[1], bound[1]);
    if (e > s) out.push([s, e]);
  }
  return out;
}

interface Placement {
  windows: Interval[];
  weekday: number | null;
  label: HoursLabel | null;
}

function windowsFor(day: DaySpec, c: PlaceCandidate): Placement {
  if (!c.hours) {
    return {
      windows: intersect([UNLISTED_WINDOW], DAY_WINDOW),
      weekday: null,
      label: HOURS_NOT_LISTED as HoursLabel,
    };
  }
  const dated =
    typeof day.weekday === "number" && Number.isInteger(day.weekday) && day.weekday >= 0 && day.weekday <= 6;
  const weekday = dated ? (day.weekday as number) : typicalWeekday(c.hours);
  const windows = weekday === null ? [] : periodsFor(c.hours, weekday);
  return {
    windows: intersect(windows, DAY_WINDOW),
    weekday,
    label: dated ? null : (TYPICAL_HOURS as HoursLabel),
  };
}

/**
 * Times a fixed order, or null when any Stop does not fit (opening hours,
 * meal windows, day window, travel limits, arrival time, mixed UTC offsets).
 */
export function fitSequence(day: DaySpec, ordered: readonly PlaceCandidate[]): ScheduledStop[] | null {
  try {
    if (!day || !Array.isArray(ordered)) return null;
    const earliest = Number.isFinite(day.earliestMin) ? day.earliestMin : DAY_WINDOW_START_MIN;
    const out: ScheduledStop[] = [];
    const usedMeal = new Set<number>();
    let offset: number | null = null;
    let cursor = earliest;
    let travelSum = 0;
    let prev: PlaceCandidate | null = null;

    for (const c of ordered) {
      if (!c) return null;
      if (typeof c.utcOffsetMinutes === "number") {
        if (offset !== null && offset !== c.utcOffsetMinutes) return null;
        offset = c.utcOffsetMinutes;
      }
      let travel = 0;
      if (prev) {
        travel = legMinutesUp(prev.location, c.location);
        if (travel > MAX_LEG_TRAVEL_MIN) return null;
        travelSum += travel;
        if (travelSum > MAX_DAY_TRAVEL_MIN) return null;
      }
      const notBefore = Math.max(cursor + travel, earliest);
      const visit = visitMinutes(c);
      const place = windowsFor(day, c);

      let start: number | null = null;
      if (mealKind(c)) {
        let pick = -1;
        let bestStart = Number.POSITIVE_INFINITY;
        for (let w = 0; w < MEAL_WINDOWS.length; w++) {
          if (usedMeal.has(w)) continue;
          const s = earliestStart(intersect(place.windows, MEAL_WINDOWS[w]), notBefore, visit);
          if (s !== null && s < bestStart) {
            bestStart = s;
            pick = w;
          }
        }
        if (pick < 0) return null;
        start = bestStart;
        usedMeal.add(pick);
      } else {
        start = earliestStart(place.windows, notBefore, visit);
        if (start === null) return null;
      }

      const s = start as number;
      const stop: ScheduledStop = {
        placeId: c.placeId,
        startMin: s,
        endMin: s + visit,
        visitMin: visit,
        hoursLabel: place.label,
        hoursText:
          c.hours && place.weekday !== null ? weekdayDescription(c.hours, place.weekday) : null,
      };
      if (out.length > 0) out[out.length - 1].travelToNextMin = travel;
      out.push(stop);
      cursor = s + visit;
      prev = c;
    }
    return out;
  } catch {
    return null;
  }
}

function cmpNullDesc(a: number | null, b: number | null): number {
  const x = typeof a === "number" && Number.isFinite(a) ? a : null;
  const y = typeof b === "number" && Number.isFinite(b) ? b : null;
  if (x === y) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return y - x;
}

function rank(pool: readonly PlaceCandidate[]): PlaceCandidate[] {
  const seen = new Set<string>();
  const unique: { c: PlaceCandidate; i: number }[] = [];
  pool.forEach((c, i) => {
    if (!c || typeof c.placeId !== "string" || seen.has(c.placeId)) return;
    seen.add(c.placeId);
    unique.push({ c, i });
  });
  unique.sort(
    (a, b) =>
      cmpNullDesc(a.c.rating, b.c.rating) ||
      cmpNullDesc(a.c.userRatingCount, b.c.userRatingCount) ||
      (a.c.placeId < b.c.placeId ? -1 : a.c.placeId > b.c.placeId ? 1 : 0) ||
      a.i - b.i,
  );
  return unique.map((u) => u.c);
}

function wantsFood(interests: readonly unknown[] | undefined): boolean {
  const list = Array.isArray(interests)
    ? interests
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s !== "")
    : [];
  return list.length === 0 || list.includes("food");
}

function distKm(a: PlaceCandidate, b: PlaceCandidate): number {
  const d = haversineKm(a.location, b.location);
  return Number.isFinite(d) ? d : Number.POSITIVE_INFINITY;
}

function scheduleDay(
  day: DaySpec,
  available: PlaceCandidate[],
  food: boolean,
  pace: Pace,
): { picked: PlaceCandidate[]; stops: ScheduledStop[] } {
  const limits = day.limits;
  const n = Math.max(1, Math.min(limits.max, Math.max(limits.min, limits.target)));
  let mealTarget = 0;
  if (food) {
    if (pace === "relaxed") mealTarget = 1;
    else if (n >= 4) mealTarget = 2;
  }
  const sightPool = available.filter((c) => !mealKind(c));
  const mealPool = available.filter((c) => mealKind(c));
  mealTarget = Math.min(mealTarget, n - 1, mealPool.length);

  // Anchor: the best-ranked sight that fits on its own.
  const sights: PlaceCandidate[] = [];
  const anchor = sightPool.find((c) => fitSequence(day, [c]) !== null);
  if (anchor) sights.push(anchor);

  // Grow by distance from the last Stop.
  const wantSights = n - mealTarget;
  while (sights.length > 0 && sights.length < wantSights) {
    const last = sights[sights.length - 1];
    let best: PlaceCandidate | null = null;
    let bestKm = Number.POSITIVE_INFINITY;
    for (const c of sightPool) {
      if (sights.includes(c)) continue;
      const km = distKm(last, c);
      if (best !== null && !(km < bestKm)) continue;
      if (fitSequence(day, [...sights, c]) === null) continue;
      best = c;
      bestKm = km;
    }
    if (!best) break;
    sights.push(best);
  }

  // Tour order: keep a shorter order only when it still fits.
  let ordered: PlaceCandidate[] = sights;
  if (sights.length >= 3) {
    const alt = reorderIfShorter(sights);
    if (alt.some((c, i) => c !== sights[i]) && fitSequence(day, alt) !== null) ordered = alt;
  }

  // Meals: earliest insertion index that keeps the day feasible.
  let meals = 0;
  const usedMeals = new Set<PlaceCandidate>();
  const insertMeals = (target: number) => {
    for (const m of mealPool) {
      if (meals >= target || ordered.length >= limits.max) break;
      if (usedMeals.has(m)) continue;
      for (let idx = 0; idx <= ordered.length; idx++) {
        const trial = [...ordered.slice(0, idx), m, ...ordered.slice(idx)];
        if (fitSequence(day, trial) !== null) {
          ordered = trial;
          usedMeals.add(m);
          meals += 1;
          break;
        }
      }
    }
  };
  if (ordered.length > 0 || mealTarget > 0) insertMeals(mealTarget);
  if (food && ordered.length < limits.min) insertMeals(MEAL_WINDOWS.length);

  const stops = fitSequence(day, ordered) ?? [];
  return stops.length === ordered.length ? { picked: ordered, stops } : { picked: [], stops: [] };
}

export function scheduleBatch(i: ScheduleInput): ScheduleResult {
  const result: ScheduleResult = { days: [], shortDays: [], emptyDays: [] };
  try {
    const days = Array.isArray(i?.days) ? i.days : [];
    const pace = resolvePace(i?.pace);
    const food = wantsFood(i?.interests);
    let available = rank(Array.isArray(i?.pool) ? i.pool : []);

    for (const day of days) {
      const { picked, stops } = scheduleDay(day, available, food, pace);
      const used = new Set(picked.map((c) => c.placeId));
      available = available.filter((c) => !used.has(c.placeId));
      result.days.push({ day: day.day, stops });
      if (stops.length === 0) result.emptyDays.push(day.day);
      else if (stops.length < day.limits.min) result.shortDays.push(day.day);
    }
  } catch {
    // Total function: whatever was built stays; remaining days are reported empty.
  }
  return result;
}
