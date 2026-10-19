import type { TripPricing } from "./types";
import { applyPromotion } from "./promotions";

/**
 * Pricing Engine (pure) — design section "9. Pricing Engine".
 * Ported from TripSaathi lib/promotions.ts (calculateTripPricing).
 * Single source of gross/discount/final-payable across wallet/itinerary/PDF.
 * Requirements: 8.1-8.3.
 */
export function calculateTripPricing(input: {
  flight: number;
  stay: number;
  activities: number;
  coupon?: string;
}): TripPricing {
  const flight = Math.max(0, Math.round(input.flight || 0));
  const stay = Math.max(0, Math.round(input.stay || 0));
  const activities = Math.max(0, Math.round(input.activities || 0));
  const gross = flight + stay + activities;
  const applied = applyPromotion(gross, input.coupon);
  return {
    flight,
    stay,
    activities,
    gross,
    discount: applied.discount,
    coupon: applied.offer?.code ?? "",
    finalPayable: Math.max(0, applied.payable),
    error: applied.error,
  };
}

/** Party fare = per-person fare × traveller count (Req 8.3). */
export function partyFare(farePerPerson: number, travellers: number): number {
  return Math.max(0, Math.round(farePerPerson)) * Math.max(1, Math.trunc(travellers));
}
