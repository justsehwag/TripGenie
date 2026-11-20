import type { OpeningPeriod, OpeningPoint, PlaceHours } from "../providers/google-places";

/**
 * Pure opening-hours helpers for the itinerary scheduler. Client-safe, total,
 * never throws. Weekdays use Google's numbering: 0 = Sunday ... 6 = Saturday.
 */

/** Minutes from local midnight, end exclusive. */
export type Interval = readonly [startMin: number, endMin: number];

const DAY_MIN = 1440;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Monday-first order used to break ties in `typicalWeekday`. */
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0] as const;

function isWeekday(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 6;
}

function isPoint(p: unknown): p is OpeningPoint {
  if (!p || typeof p !== "object") return false;
  const { day, hour, minute } = p as Record<string, unknown>;
  return (
    isWeekday(day) &&
    typeof hour === "number" && Number.isInteger(hour) && hour >= 0 && hour <= 23 &&
    typeof minute === "number" && Number.isInteger(minute) && minute >= 0 && minute <= 59
  );
}

/** yyyy-mm-dd to 0..6 (0 = Sunday), UTC arithmetic. null for a bad date. */
export function weekdayOf(date: string): number | null {
  if (typeof date !== "string") return null;
  const m = DATE_RE.exec(date);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (
    !Number.isFinite(t) ||
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return dt.getUTCDay();
}

/** yyyy-mm-dd plus n whole days (n may be negative). null for a bad date or n. */
export function addDays(date: string, n: number): string | null {
  if (weekdayOf(date) === null) return null;
  if (typeof n !== "number" || !Number.isInteger(n)) return null;
  const m = DATE_RE.exec(date) as RegExpExecArray;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + n * 86_400_000;
  const dt = new Date(t);
  if (!Number.isFinite(t) || Number.isNaN(dt.getTime())) return null;
  const y = dt.getUTCFullYear();
  if (y < 0 || y > 9999) return null;
  const pad = (v: number, w: number) => String(v).padStart(w, "0");
  return `${pad(y, 4)}-${pad(dt.getUTCMonth() + 1, 2)}-${pad(dt.getUTCDate(), 2)}`;
}

function periodInterval(p: OpeningPeriod): Interval | null {
  if (!p || !isPoint(p.open)) return null;
  const start = p.open.hour * 60 + p.open.minute;
  if (p.close === undefined || p.close === null) return [0, DAY_MIN]; // open 24 hours
  if (!isPoint(p.close)) return null;
  const end = p.close.hour * 60 + p.close.minute;
  const sameDay = p.close.day === p.open.day;
  if (sameDay && end > start) return [start, end];
  // 00:00 to 00:00 (any day) is open all day.
  if (start === 0 && end === 0) return [0, DAY_MIN];
  // Crosses midnight (or ends at or before it opens): belongs to the opening weekday,
  // so it runs to the end of that day. The part after midnight is not carried over.
  return [start, DAY_MIN];
}

/**
 * Google documents "always open" as ONE period: open day 0 at 00:00, no close.
 * That means open every weekday, not only Sunday.
 */
function isAlwaysOpen(periods: readonly OpeningPeriod[]): boolean {
  if (periods.length !== 1) return false;
  const p = periods[0];
  return (
    !!p &&
    isPoint(p.open) &&
    p.open.day === 0 &&
    p.open.hour === 0 &&
    p.open.minute === 0 &&
    (p.close === undefined || p.close === null)
  );
}

/**
 * Opening intervals of a weekday, sorted, merged and clipped to [0, 1440].
 * A period belongs to the weekday it opens on.
 */
export function periodsFor(h: PlaceHours, weekday: number): Interval[] {
  if (!h || !Array.isArray(h.periods) || !isWeekday(weekday)) return [];
  if (isAlwaysOpen(h.periods)) return [[0, DAY_MIN]];
  const raw: [number, number][] = [];
  for (const p of h.periods) {
    if (!p || !isPoint(p.open) || p.open.day !== weekday) continue;
    const iv = periodInterval(p);
    if (!iv) continue;
    const s = Math.max(0, iv[0]);
    const e = Math.min(DAY_MIN, iv[1]);
    if (e > s) raw.push([s, e]);
  }
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const iv of raw) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  return merged;
}

/**
 * The weekday whose interval list is shared by the most weekdays; ties go to
 * the earliest weekday in Monday-to-Sunday order. Weekdays with no periods
 * are not candidates (a closed day is never "typical"), so a place with any
 * valid period gets an open weekday. null when no weekday has a period.
 */
export function typicalWeekday(h: PlaceHours): number | null {
  if (!h || !Array.isArray(h.periods)) return null;
  const keys = new Map<number, string>();
  const counts = new Map<string, number>();
  for (const d of MONDAY_FIRST) {
    const ivs = periodsFor(h, d);
    if (ivs.length === 0) continue;
    const key = ivs.map((iv) => `${iv[0]}-${iv[1]}`).join(",");
    keys.set(d, key);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const d of MONDAY_FIRST) {
    const key = keys.get(d);
    if (key === undefined) continue;
    const c = counts.get(key) ?? 0;
    if (c > bestCount) {
      best = d;
      bestCount = c;
    }
  }
  return best;
}

/** Google's description string for a weekday, verbatim. Index is (weekday + 6) % 7 (Monday first). */
export function weekdayDescription(h: PlaceHours, weekday: number): string | null {
  if (!h || !Array.isArray(h.weekdayDescriptions) || !isWeekday(weekday)) return null;
  const s = h.weekdayDescriptions[(weekday + 6) % 7];
  return typeof s === "string" && s.trim() !== "" ? s : null;
}

/**
 * Earliest whole minute s >= notBeforeMin such that [s, s + visitMin] lies
 * inside one window. null when none fits or an input is not finite.
 */
export function earliestStart(
  windows: readonly Interval[],
  notBeforeMin: number,
  visitMin: number,
): number | null {
  if (!Array.isArray(windows)) return null;
  if (typeof notBeforeMin !== "number" || !Number.isFinite(notBeforeMin)) return null;
  if (typeof visitMin !== "number" || !Number.isFinite(visitMin) || visitMin < 0) return null;
  const sorted = windows
    .filter(
      (w) =>
        Array.isArray(w) && Number.isFinite(w[0]) && Number.isFinite(w[1]),
    )
    .slice()
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const nb = Math.ceil(notBeforeMin);
  for (const [open, close] of sorted) {
    const s = Math.max(Math.ceil(open), nb);
    if (s + visitMin <= close) return s;
  }
  return null;
}
