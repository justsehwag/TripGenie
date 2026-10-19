import type { Itinerary, TripPricing } from "./types";
import { buildItinerary } from "./itinerary-engine";
import { calculateTripPricing, partyFare } from "./pricing";
import { buildItineraryPdf } from "./pdf";

/**
 * Workspace reactivity glue - design sections 9/11/16.
 * Pure orchestration: on a resolved-days change it rebuilds the itinerary and
 * recomputes trip pricing from engine values (so the UI can reflect it within
 * 2s), exposes per-person + party fare for flight offers, and assembles the
 * full PDF from shared Pricing Engine values.
 * Requirements: 6.6, 6.7, 8.2, 8.3, 9.1, 14.1, 14.3.
 */

export interface WorkspaceInput {
  destination: string;
  startDate: string;
  resolvedDays: number;
  vibes?: string[];
  /** Flight + stay costs come from selected offers; activities are derived. */
  flight: number;
  stay: number;
  coupon?: string;
}

export interface WorkspaceState {
  itinerary: Itinerary;
  pricing: TripPricing;
}

/** Sum of all activity costs across the itinerary (the activities line item). */
function activitiesCost(itinerary: Itinerary): number {
  return itinerary.days.reduce((s, d) => s + d.total, 0);
}

/**
 * Recompute the workspace after a resolved-days change: rebuild the itinerary
 * for the new day count and re-price using the shared Pricing Engine. The
 * activities subtotal always matches the regenerated itinerary, so itinerary
 * and wallet stay in lockstep (Req 6.6, 8.2, 9.1).
 */
export function recomputeWorkspace(input: WorkspaceInput): WorkspaceState {
  const itinerary = buildItinerary({
    destination: input.destination,
    startDate: input.startDate,
    days: input.resolvedDays,
    vibes: input.vibes,
  });
  const pricing = calculateTripPricing({
    flight: input.flight,
    stay: input.stay,
    activities: activitiesCost(itinerary),
    coupon: input.coupon,
  });
  return { itinerary, pricing };
}

export interface FlightOfferFare {
  perPerson: number;
  travellers: number;
  party: number;
}

/** Flight offers show both the per-person fare and the fare x travellers (Req 8.3). */
export function flightOfferFare(perPerson: number, travellers: number): FlightOfferFare {
  const n = Math.max(1, Math.trunc(travellers));
  return {
    perPerson: Math.max(0, Math.round(perPerson)),
    travellers: n,
    party: partyFare(perPerson, n),
  };
}

/**
 * Export the full itinerary as a PDF using the shared Pricing Engine values
 * (single source of truth across wallet/itinerary/PDF) (Req 14.1, 14.3).
 */
export function exportItineraryPdf(state: WorkspaceState, route: string): Uint8Array {
  return buildItineraryPdf(
    state.itinerary.title,
    route,
    state.itinerary.days,
    state.pricing,
  );
}
