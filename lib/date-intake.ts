import type { DateState } from "./types";

/**
 * Date & Duration resolver (pure) — design section "7. Date & Duration Intake".
 * Ported from TripSaathi lib/itinerary.ts (inclusiveDays, durationFromText).
 * Requirements: 6.1-6.5.
 */

const MIN_DAYS = 1;
const MAX_DAYS = 14;

export type DateInput =
  | { kind: "flexible"; days: number }
  | { kind: "fixed"; startDate: string; endDate: string }
  | { kind: "text"; text: string };

export interface DateResolution {
  state: DateState;
  /** Empty when resolved cleanly; otherwise a human-readable rejection reason. */
  error: string;
}

const isIso = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

const inclusiveBetween = (start: string, end: string): number =>
  Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;

/**
 * Parse a free-text duration into an integer inclusive-day count, or null.
 * "N nights M days" → M; bare "N days" → N; bare "N nights" → N+1 (Req 6.4).
 */
export function durationFromText(text: string): number | null {
  const lower = text.toLowerCase();
  const nightsDays = lower.match(
    /(\d{1,2})\s*nights?\s*(?:and|\/|,)?\s*(\d{1,2})\s*days?/,
  );
  const days = lower.match(/\b(\d{1,2})\s*[- ]?days?(?:\s+trip)?\b/);
  const nights = lower.match(/\b(\d{1,2})\s*[- ]?nights?\b/);
  const value = nightsDays
    ? Number(nightsDays[2])
    : days
    ? Number(days[1])
    : nights
    ? Number(nights[1]) + 1
    : null;
  return value;
}

/**
 * Resolve a DateInput into an updated DateState. Rejections retain prev.tripDays.
 */
export function resolveTripDays(input: DateInput, prev: DateState): DateResolution {
  const keep = (error: string): DateResolution => ({
    state: { ...prev },
    error,
  });

  if (input.kind === "fixed") {
    if (!isIso(input.startDate) || !isIso(input.endDate))
      return keep("Provide valid start and end dates.");
    if (Date.parse(`${input.endDate}T00:00:00Z`) < Date.parse(`${input.startDate}T00:00:00Z`))
      return keep("The end date must be on or after the start date.");
    const days = inclusiveBetween(input.startDate, input.endDate);
    if (days < MIN_DAYS || days > MAX_DAYS)
      return keep("Trip duration must be between 1 and 14 days inclusive.");
    return {
      state: {
        mode: "fixed",
        startDate: input.startDate,
        endDate: input.endDate,
        tripDays: days,
      },
      error: "",
    };
  }

  let days: number | null;
  if (input.kind === "flexible") days = Math.trunc(input.days);
  else days = durationFromText(input.text);

  if (days === null || Number.isNaN(days))
    return keep("Could not understand the trip duration.");
  if (days < MIN_DAYS || days > MAX_DAYS)
    return keep("Trip duration must be between 1 and 14 days inclusive.");
  return {
    state: { mode: "flexible", tripDays: days },
    error: "",
  };
}
