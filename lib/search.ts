import type { CarOffer, FlightOffer, PlaceOffer, StayOffer } from "./types";
import { buildCarOffers, buildFlightOffers, buildPlaceOffers, buildStayOffers, type InventoryQuery } from "./inventory-adapter";

/**
 * Search service wrapper - design section 5.
 * Exactly min(6, available) per category; partial flag when fewer than six;
 * places restricted to metro area; labelled error + destination retained on failure.
 * Requirements: 4.1-4.4.
 */

const TARGET = 6;

export interface SearchResult {
  flights: FlightOffer[];
  hotels: StayOffer[];
  places: PlaceOffer[];
  cars: CarOffer[];
  partial: { flights: boolean; hotels: boolean; places: boolean; cars: boolean };
  confirmedDestination: string;
  error?: string;
}

export interface UpstreamCounts {
  flights?: number;
  hotels?: number;
  places?: number;
  cars?: number;
}

/**
 * Build a search result. `upstream` optionally caps how many results were
 * available upstream per category (defaults to plenty, i.e. a full six).
 */
export function runSearch(
  q: InventoryQuery,
  upstream: UpstreamCounts = {},
  now = new Date(),
): SearchResult {
  const avail = (v: number | undefined) => (v === undefined ? TARGET : Math.max(0, Math.trunc(v)));
  const fCount = Math.min(TARGET, avail(upstream.flights));
  const hCount = Math.min(TARGET, avail(upstream.hotels));
  const pCount = Math.min(TARGET, avail(upstream.places));
  const cCount = Math.min(TARGET, avail(upstream.cars));
  return {
    flights: buildFlightOffers(q, fCount, now),
    hotels: buildStayOffers(q, hCount, now),
    places: buildPlaceOffers(q, pCount, now),
    cars: buildCarOffers(q, cCount, now),
    partial: {
      flights: fCount < TARGET,
      hotels: hCount < TARGET,
      places: pCount < TARGET,
      cars: cCount < TARGET,
    },
    confirmedDestination: q.destination,
  };
}

/** Failure/timeout: labelled error with the confirmed destination retained for retry. */
export function searchError(destination: string, reason: string): SearchResult {
  return {
    flights: [],
    hotels: [],
    places: [],
    cars: [],
    partial: { flights: true, hotels: true, places: true, cars: true },
    confirmedDestination: destination,
    error: reason || "Search unavailable; please retry.",
  };
}
