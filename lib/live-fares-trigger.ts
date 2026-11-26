/**
 * Pure decision helper for the planner's live-fares fetch (flights-coverage-
 * itinerary Req 3). No network, no framework imports.
 *
 * Confirmed root cause it encodes (see components/planner.tsx Live_Fares_Effect):
 *  1. Chat stores origin/destination as free-text labels ("Chennai, India").
 *     resolveAirport() only knows bare names / codes / "City (ABC)", so a label
 *     with a comma suffix classified as "no-airport" and the fare showed as
 *     "not priced" until a manual edit typed a bare city name.
 *     -> resolvablePlace() maps a label to the first form that resolves.
 *  2. The chat start-date flow writes departDate/returnDate (checkIn/checkOut
 *     only follow later), so dates fall back checkIn<-departDate, checkOut<-returnDate.
 *  3. The effect keyed its dedupe ref before the fetch finished, but its cleanup
 *     cancelled the response whenever `state` changed mid-flight (activity
 *     pricing does that); the re-run then early-returned on the same key and
 *     the fetch was never retried. The planner now discards a response only when
 *     the key changed (see isCurrentLiveKey).
 */
import { resolveAirport } from "@/lib/airports";

export interface LiveFaresInput {
  origin: string;
  destination: string;
  checkIn: string;
  checkOut: string;
  /** Fallbacks used when checkIn / checkOut are blank (chat writes these first). */
  departDate?: string;
  returnDate?: string;
  travellers: number;
}

export type LiveFaresDecision =
  | { kind: "wait" }
  | { kind: "fetch"; key: string; origin: string; destination: string; checkIn: string; checkOut: string; travellers: number };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function text(s: unknown): string {
  return typeof s === "string" ? s.trim() : "";
}

/**
 * Map a chat place label to the first form resolveAirport() understands:
 * the label itself, then the part before the first comma, then the label with
 * any parenthetical removed. Falls back to the trimmed label (never invents).
 */
export function resolvablePlace(label: unknown): string {
  const raw = text(label);
  if (!raw) return "";
  if (resolveAirport(raw)) return raw;
  const candidates = [
    raw.split(",")[0],
    raw.replace(/\([^)]*\)/g, ""),
    raw.replace(/\([^)]*\)/g, "").split(",")[0],
  ].map((c) => c.trim()).filter(Boolean);
  for (const c of candidates) if (resolveAirport(c)) return c;
  return raw;
}

/** True when a response for `key` is still wanted (the route/dates did not change meanwhile). */
export function isCurrentLiveKey(currentKey: string, responseKey: string): boolean {
  return currentKey === responseKey;
}

export function decideLiveFaresFetch(input: LiveFaresInput): LiveFaresDecision {
  const destination = resolvablePlace(input.destination);
  const origin = resolvablePlace(input.origin);
  const checkIn = text(input.checkIn) || text(input.departDate);
  const checkOut = text(input.checkOut) || text(input.returnDate);
  if (!destination || !ISO_DATE.test(checkIn) || !ISO_DATE.test(checkOut) || !(checkOut > checkIn)) {
    return { kind: "wait" };
  }
  const n = Number(input.travellers);
  const travellers = Number.isFinite(n) ? Math.max(1, Math.trunc(n)) : 1;
  const key = `${origin}|${destination}|${checkIn}|${checkOut}|${travellers}`;
  return { kind: "fetch", key, origin, destination, checkIn, checkOut, travellers };
}
