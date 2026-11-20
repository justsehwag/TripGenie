/**
 * Trip length (pure, client-safe). The "How long?" field decides the number of
 * planned days. Dates never change it; they only yield `dateSpanDays`.
 */
import { durationFromText } from "@/lib/date-intake";
import { MAX_TRIP_DAYS } from "@/lib/itinerary/constants";
import { inclusiveDays } from "@/lib/quick-form";

const DEFAULT_DAYS = 4;

export interface TripLengthInput {
  field: string;
  contextDays?: number;
  startDate?: string;
  endDate?: string;
}

export interface TripLength {
  days: number;
  capped: boolean;
  dateSpanDays: number | null;
}

function clampDays(n: number): number {
  return Math.min(MAX_TRIP_DAYS, Math.max(1, Math.trunc(n)));
}

export function resolveTripLength(i: TripLengthInput): TripLength {
  const span =
    typeof i.startDate === "string" && typeof i.endDate === "string"
      ? inclusiveDays(i.startDate, i.endDate)
      : 0;
  const dateSpanDays = span >= 1 ? span : null;

  const n = typeof i.field === "string" ? durationFromText(i.field) : null;
  if (n !== null && Number.isFinite(n) && n >= 1) {
    return { days: Math.min(n, MAX_TRIP_DAYS), capped: n > MAX_TRIP_DAYS, dateSpanDays };
  }
  const ctx =
    typeof i.contextDays === "number" && Number.isFinite(i.contextDays) ? i.contextDays : DEFAULT_DAYS;
  return { days: clampDays(ctx), capped: false, dateSpanDays };
}
