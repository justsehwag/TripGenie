/**
 * Start-date helpers for the planner form and the assistant chat.
 *
 * Pure and total: no React, no network, and no clock reads. "Today" is always
 * passed in by the caller (use `todayIst()` from `lib/ist-time.ts`).
 */
import { MAX_TRIP_DAYS } from "./itinerary/constants";
import { endFromDays, resolveTripDates } from "./itinerary/trip-dates";
import { isIsoDate } from "./quick-form";

export type DateChipId = "this-weekend" | "next-week" | "next-month";

export const DATE_CHIPS: readonly { id: DateChipId; label: string }[] = [
  { id: "this-weekend", label: "This weekend" },
  { id: "next-week", label: "Next week" },
  { id: "next-month", label: "Next month" },
];

const MS_PER_DAY = 86_400_000;

function toUtc(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Build an ISO date from parts, or "" when the calendar date does not exist. */
function buildIso(year: number, month: number, day: number): string {
  if (year < 1000 || year > 9999) return "";
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return "";
  }
  return d.toISOString().slice(0, 10);
}

function nextWeekend(today: string): string {
  const t = toUtc(today);
  const dow = new Date(t).getUTCDay(); // 0 = Sunday
  return fromUtc(t + ((6 - dow + 7) % 7) * MS_PER_DAY);
}

function nextWeekMonday(today: string): string {
  const t = toUtc(today);
  const dow = new Date(t).getUTCDay();
  const add = ((1 - dow + 7) % 7) || 7; // strictly after today
  return fromUtc(t + add * MS_PER_DAY);
}

function nextMonth(today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  const ty = m === 12 ? y + 1 : y;
  const tm = m === 12 ? 1 : m + 1;
  const last = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  return buildIso(ty, tm, Math.min(d, last));
}

/** ISO date for a chip, always on or after `today`. "" when `today` is invalid. */
export function resolveDateChip(id: DateChipId, today: string): string {
  if (!isIsoDate(today)) return "";
  switch (id) {
    case "this-weekend":
      return nextWeekend(today);
    case "next-week":
      return nextWeekMonday(today);
    case "next-month":
      return nextMonth(today);
    default:
      return "";
  }
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};
const MONTH_RE =
  "(january|february|march|april|may|june|july|august|september|october|november|december|sept|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)";
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\b`, "i");
const MONTH_DAY = new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i");

/** Next occurrence of month/day on or after `today` (tries a few years for Feb 29). */
function nextOccurrence(month: number, day: number, today: string): string {
  const year = Number(today.slice(0, 4));
  for (let y = year; y <= year + 8; y++) {
    const iso = buildIso(y, month, day);
    if (iso && iso >= today) return iso;
  }
  return "";
}

/**
 * Parse a typed start date. Returns an ISO date on or after `today`, or null
 * for anything unrecognised, invalid, in the past, or a bare day count.
 */
export function parseStartDateText(text: string, today: string): string | null {
  try {
    if (typeof text !== "string" || !isIsoDate(today)) return null;
    const s = text.trim().toLowerCase();
    if (!s) return null;

    const iso = /\b\d{4}-\d{2}-\d{2}\b/.exec(s);
    if (iso) {
      return isIsoDate(iso[0]) && iso[0] >= today ? iso[0] : null;
    }

    if (/\btomorrow\b/.test(s)) return fromUtc(toUtc(today) + MS_PER_DAY);
    if (/\btoday\b/.test(s)) return today;
    if (/\bthis\s+weekend\b/.test(s)) return nextWeekend(today);
    if (/\bnext\s+month\b/.test(s)) return nextMonth(today) || null;

    let day = NaN;
    let month = NaN;
    const dm = DAY_MONTH.exec(s);
    if (dm) {
      day = Number(dm[1]);
      month = MONTHS[dm[2].toLowerCase()];
    } else {
      const md = MONTH_DAY.exec(s);
      if (md) {
        month = MONTHS[md[1].toLowerCase()];
        day = Number(md[2]);
      }
    }
    if (!Number.isFinite(day) || !Number.isFinite(month)) return null;
    return nextOccurrence(month, day, today) || null;
  } catch {
    return null;
  }
}

export interface DatesWrite {
  departDate: string;
  checkIn: string;
  returnDate?: string;
  checkOut?: string;
}

/**
 * Date keys to write for a start date. null for an invalid start. The end date
 * is added only when `days` is a usable day count (clamped to MAX_TRIP_DAYS).
 */
export function planStartDateWrite(
  start: string,
  days: number | null | undefined,
): DatesWrite | null {
  if (!isIsoDate(start)) return null;
  const write: DatesWrite = { departDate: start, checkIn: start };
  if (typeof days === "number" && Number.isFinite(days) && Math.floor(days) >= 1) {
    const end = endFromDays(start, Math.min(Math.floor(days), MAX_TRIP_DAYS));
    if (end) {
      write.returnDate = end;
      write.checkOut = end;
    }
  }
  return write;
}

/** True when the chat should ask "What date do you start?" (once). */
export function shouldAskStartDate(a: {
  origin?: string;
  destination?: string;
  departDate?: string;
  dismissed: boolean;
  asked: boolean;
}): boolean {
  const has = (v?: string) => typeof v === "string" && v.trim() !== "";
  return has(a.origin) && has(a.destination) && !has(a.departDate) && !a.dismissed && !a.asked;
}

/** True when rehydrated dates should be kept. */
export function keepStoredDates(a: {
  userInitiated?: boolean;
  hasItinerary: boolean;
  departDate?: string;
  today: string;
}): boolean {
  if (a.userInitiated === true || a.hasItinerary) return true;
  return isIsoDate(a.departDate) && isIsoDate(a.today) && a.departDate >= a.today;
}

/** Generate is never blocked once a destination exists; `dated` needs a valid start. */
export function decideGenerate(a: {
  destination?: string;
  startDate?: string;
}): { proceed: boolean; dated: boolean } {
  const proceed = typeof a.destination === "string" && a.destination.trim() !== "";
  const dated = resolveTripDates({ startDate: a.startDate, days: 1 }).startDate !== null;
  return { proceed, dated };
}
