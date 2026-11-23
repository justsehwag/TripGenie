import { MAX_TRIP_DAYS } from "./constants";
import { inclusiveDays, isIsoDate } from "../quick-form";

export interface TripDatesInput {
  startDate?: string;
  endDate?: string;
  days?: number;
}

export interface TripDates {
  startDate: string | null;
  endDate: string | null;
  /** null only when nothing usable is known. */
  days: number | null;
  /** MAX_TRIP_DAYS truncated the count. */
  capped: boolean;
  /** A day count is known but no start date. */
  needsStartDate: boolean;
  source: "dates" | "days" | "none";
}

const MS_PER_DAY = 86_400_000;

function cleanDays(n: unknown): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const v = Math.floor(n);
  return v >= 1 ? v : null;
}

function addDays(iso: string, offset: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)!;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + offset * MS_PER_DAY;
  return new Date(t).toISOString().slice(0, 10);
}

/** Date of day N (1-based): start + N - 1. Returns "" for an invalid start. */
export function dayDate(startDate: string, n: number): string {
  if (!isIsoDate(startDate) || !Number.isFinite(n)) return "";
  return addDays(startDate, Math.floor(n) - 1);
}

/** End date for a trip of `days` days from `startDate`: start + days - 1. */
export function endFromDays(startDate: string, days: number): string {
  return dayDate(startDate, days);
}

const NONE: TripDates = {
  startDate: null,
  endDate: null,
  days: null,
  capped: false,
  needsStartDate: false,
  source: "none",
};

export function resolveTripDates(i: TripDatesInput): TripDates {
  try {
    const input = i ?? {};
    const start = isIsoDate(input.startDate) ? input.startDate : null;
    const end = isIsoDate(input.endDate) ? input.endDate : null;
    const days = cleanDays(input.days);

    if (start && end) {
      const span = inclusiveDays(start, end);
      if (span >= 1) {
        return {
          startDate: start,
          endDate: end,
          days: Math.min(MAX_TRIP_DAYS, span),
          capped: span > MAX_TRIP_DAYS,
          needsStartDate: false,
          source: "dates",
        };
      }
      return NONE; // reversed
    }

    if (days !== null) {
      if (start) {
        const d = Math.min(MAX_TRIP_DAYS, days);
        return {
          startDate: start,
          endDate: endFromDays(start, d),
          days: d,
          capped: days > MAX_TRIP_DAYS,
          needsStartDate: false,
          source: "days",
        };
      }
      return {
        startDate: null,
        endDate: null,
        days: Math.min(MAX_TRIP_DAYS, days),
        capped: days > MAX_TRIP_DAYS,
        needsStartDate: true,
        source: "days",
      };
    }
    return NONE;
  } catch {
    return NONE;
  }
}
