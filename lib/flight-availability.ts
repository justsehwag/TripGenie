/**
 * Flight availability classification (trip-planning-v2 Req 9).
 *
 * Pure module: no network, no framework imports. Total: never throws.
 */

import { resolveAirport } from "@/lib/airports";

export type FlightAvailability = "available" | "no-airport" | "no-flights";

/** Structural, so this pure module does not import the server-only adapter. */
export interface FlightSearchOutcome {
  status: string;
  flightCount: number;
}

export const GROUND_TRANSPORT_NOTE = "No flights on this route — travel by road or rail";
export const NO_FLIGHTS_FOR_DATES = "No flights found for these dates";

/** Safe resolve: any thrown error or non-string input counts as unresolved. */
function safeResolve(text: unknown): string | null {
  try {
    if (typeof text !== "string") return null;
    return resolveAirport(text);
  } catch {
    return null;
  }
}

/**
 * Classify a route. Rules in order:
 * 1. Origin or destination does not resolve -> "no-airport" (Req 9.2).
 * 2. Outcome status "live" with exactly zero flights -> "no-flights" (Req 9.3).
 * 3. Everything else (flights found, no outcome, error/unconfigured/timeout,
 *    NaN or negative counts) -> "available" (Req 9.4-9.6).
 */
export function classifyFlightAvailability(
  origin: unknown,
  destination: unknown,
  outcome?: FlightSearchOutcome | null,
): FlightAvailability {
  try {
    if (safeResolve(origin) === null || safeResolve(destination) === null) {
      return "no-airport";
    }
    if (
      outcome !== null &&
      outcome !== undefined &&
      outcome.status === "live" &&
      typeof outcome.flightCount === "number" &&
      outcome.flightCount === 0
    ) {
      return "no-flights";
    }
    return "available";
  } catch {
    return "available";
  }
}

/** True for "no-airport" and "no-flights". */
export function isNoFlightRoute(a: FlightAvailability): boolean {
  return a === "no-airport" || a === "no-flights";
}

/** Names which side(s) failed to resolve, origin first (Req 11.2). */
export function unresolvedSides(origin: unknown, destination: unknown): Array<"origin" | "destination"> {
  const sides: Array<"origin" | "destination"> = [];
  if (safeResolve(origin) === null) sides.push("origin");
  if (safeResolve(destination) === null) sides.push("destination");
  return sides;
}
