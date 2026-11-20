/**
 * Activity cost estimation (pure).
 *
 * Replaces the old flat, hard-coded itinerary activity costs (which were the
 * same for every destination) with honest, destination-aware *estimates*.
 * Each activity has a CATEGORY (transfer/sight/meal/leisure) priced from a
 * small USD band, scaled by a destination cost TIER. Values are USD-anchored
 * so the core stays pure and deterministic; conversion to the destination
 * local currency happens at the display edge using the live currency adapter.
 * These are labelled "Estimated" in the UI - never presented as bookable fact.
 */

export type ActivityCategory = "transfer" | "sight" | "meal" | "leisure";
export type CostTier = "budget" | "mid" | "high" | "luxury";

/* Per-category mid-tier base in USD (per person, one activity). Honest, round
   order-of-magnitude bands - not false precision. */
const BASE_USD: Record<ActivityCategory, number> = {
  transfer: 18,
  sight: 28,
  meal: 22,
  leisure: 20,
};

/* Tier multipliers applied to the USD base. */
const TIER_FACTOR: Record<CostTier, number> = {
  budget: 0.55,
  mid: 1,
  high: 1.6,
  luxury: 2.4,
};

/* Destination cost-of-living tiers. Keys are matched case-insensitively against
   the first comma-separated token of the destination (e.g. "Paris, France"). */
const TIER_BY_PLACE: Record<string, CostTier> = {
  switzerland: "luxury",
  zurich: "luxury",
  geneva: "luxury",
  tokyo: "high",
  london: "high",
  paris: "high",
  singapore: "high",
  dubai: "high",
  "new york": "luxury",
  sydney: "high",
  amsterdam: "high",
  rome: "mid",
  barcelona: "mid",
  bali: "budget",
  bangkok: "budget",
  hanoi: "budget",
  delhi: "budget",
  mumbai: "budget",
  goa: "budget",
  jaipur: "budget",
  kathmandu: "budget",
  cairo: "budget",
  maldives: "high",
  istanbul: "mid",
  lisbon: "mid",
};

/* Destination -> local currency (ISO 4217). Keys matched as above; falls back
   to USD when the place is not mapped so we never guess a wrong symbol. */
const CURRENCY_BY_PLACE: Record<string, string> = {
  switzerland: "CHF",
  zurich: "CHF",
  geneva: "CHF",
  tokyo: "JPY",
  japan: "JPY",
  london: "GBP",
  paris: "EUR",
  rome: "EUR",
  barcelona: "EUR",
  amsterdam: "EUR",
  lisbon: "EUR",
  singapore: "SGD",
  dubai: "AED",
  "new york": "USD",
  sydney: "AUD",
  bali: "IDR",
  bangkok: "THB",
  hanoi: "VND",
  delhi: "INR",
  mumbai: "INR",
  goa: "INR",
  jaipur: "INR",
  india: "INR",
  kathmandu: "NPR",
  cairo: "EGP",
  maldives: "MVR",
  istanbul: "TRY",
};

/** Normalise the first place token (lowercase, trimmed) for map lookups. */
function placeKey(dest: string): string {
  return (dest.split(",")[0] || dest).trim().toLowerCase();
}

/** Destination cost tier; defaults to "mid" for any unmapped place. */
export function destinationTier(dest: string): CostTier {
  const key = placeKey(dest);
  return Object.prototype.hasOwnProperty.call(TIER_BY_PLACE, key) ? TIER_BY_PLACE[key] : "mid";
}

/** Destination local currency ISO code; defaults to "USD" when unmapped. */
export function localCurrency(dest: string): string {
  const key = placeKey(dest);
  return Object.prototype.hasOwnProperty.call(CURRENCY_BY_PLACE, key) ? CURRENCY_BY_PLACE[key] : "USD";
}

/**
 * Estimated USD cost for one activity of a given category at a given tier.
 * Rounded to the nearest dollar - an honest estimate, not false precision.
 */
export function estimateUsd(category: ActivityCategory, tier: CostTier): number {
  const base = BASE_USD[category];
  const factor = TIER_FACTOR[tier];
  return Math.max(0, Math.round(base * factor));
}

/** Convenience: estimated USD for a category at a destination's tier. */
export function estimateUsdFor(category: ActivityCategory, dest: string): number {
  return estimateUsd(category, destinationTier(dest));
}
