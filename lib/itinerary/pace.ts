import {
  BATCH_DAYS,
  DAY_TRIP_PER_DAYS,
  MAX_TRIP_DAYS,
  STOP_TARGET,
  TOKENS_BASE,
  TOKENS_MAX,
  TOKENS_MIN,
  TOKENS_PER_DAY,
  TOKENS_PER_STOP,
} from "./constants";

export type Pace = "relaxed" | "balanced" | "packed";

export interface DayLimits {
  target: number;
  min: number;
  max: number;
  partial: boolean;
}

/** Whole number from any input, clamped to lo..hi. NaN and non-numbers give lo. */
function clampInt(raw: unknown, lo: number, hi: number): number {
  const n = typeof raw === "number" ? Math.floor(raw) : Number.NaN;
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/** Unknown or missing pace resolves to "balanced". */
export function resolvePace(raw: unknown): Pace {
  return raw === "relaxed" || raw === "balanced" || raw === "packed" ? raw : "balanced";
}

/**
 * Stop limits for one day. Arrival (day 1) and departure (last day) of a trip of
 * at least 2 days are partial days; everything else is a full day.
 */
export function dayLimits(pace: unknown, day: number, totalDays: number): DayLimits {
  const target = STOP_TARGET[resolvePace(pace)];
  const total = clampInt(totalDays, 1, MAX_TRIP_DAYS);
  const d = clampInt(day, 1, total);
  if (total >= 2 && (d === 1 || d === total)) {
    const max = Math.max(1, target - 2);
    const min = Math.min(target - 1, max);
    return { target, min, max, partial: true };
  }
  return { target, min: target - 1, max: target + 1, partial: false };
}

/** Contiguous ranges of at most BATCH_DAYS days covering 1..N (N clamped to 1..MAX_TRIP_DAYS). */
export function batchRanges(totalDays: number): Array<{ fromDay: number; dayCount: number }> {
  const total = clampInt(totalDays, 1, MAX_TRIP_DAYS);
  const out: Array<{ fromDay: number; dayCount: number }> = [];
  for (let from = 1; from <= total; from += BATCH_DAYS) {
    out.push({ fromDay: from, dayCount: Math.min(BATCH_DAYS, total - from + 1) });
  }
  return out;
}

/** At most 1 day trip per DAY_TRIP_PER_DAYS trip days. */
export function maxDayTrips(totalDays: number): number {
  const total = clampInt(totalDays, 0, Number.MAX_SAFE_INTEGER);
  return Math.floor(total / DAY_TRIP_PER_DAYS);
}

/** Keeps the first `allowed` flagged days (in day order) and clears the rest. */
export function acceptDayTrips(flags: readonly boolean[], allowed: number): boolean[] {
  const list = Array.isArray(flags) ? flags : [];
  const limit = clampInt(allowed, 0, Number.MAX_SAFE_INTEGER);
  let used = 0;
  return list.map((f) => {
    if (f !== true) return false;
    if (used >= limit) return false;
    used += 1;
    return true;
  });
}

/** Token budget for a batch: clamp(BASE + days * (PER_DAY + (target + 1) * PER_STOP), MIN, MAX). */
export function maxTokensFor(dayCount: number, pace: unknown): number {
  const target = STOP_TARGET[resolvePace(pace)];
  const days = clampInt(dayCount, 0, MAX_TRIP_DAYS);
  const raw = TOKENS_BASE + days * (TOKENS_PER_DAY + (target + 1) * TOKENS_PER_STOP);
  return Math.min(TOKENS_MAX, Math.max(TOKENS_MIN, raw));
}
