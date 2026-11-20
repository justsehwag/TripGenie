/**
 * Trip Summary computation (Req 3.1-3.4, 8.2, 10.3, 10.4, 10.5, 10.11, 14.5, 15.1-15.5).
 *
 * Pure and framework-free. Never throws.
 * Activities line = party total from `partyActivitiesInr` (person-basis costs x
 * travellers, group-basis costs x ceil(travellers / 4)), so the displayed lines
 * (flight + stay + activities - discount) equal the final payable.
 * `priceSourceCounts` / `formatSourceCounts` describe how Priceable_Activities were
 * priced (web, AI or estimated). They never change the total.
 * `lib/workspace` is not imported (it pulls in lib/pdf); `partyFare` is the same
 * math as `flightOfferFare(...).party`.
 */

import type { Activity, Itinerary, TripPricing } from "./types";
import { classifyActivity, isPriceable } from "./cost-classifier";
import { partyActivitiesInr } from "./itinerary-inr";
import { calculateTripPricing, partyFare } from "./pricing";

export interface SummaryInput {
  itinerary: Itinerary; // costUnit "inr"
  stayInr: number;
  flightPerPerson: number; // ignored when noFlight
  travellers: number;
  noFlight: boolean;
  coupon?: string;
}

export interface SourceCounts {
  web: number;
  ai: number;
  estimated: number;
}

function num(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

export function computeSummary(i: SummaryInput): TripPricing {
  const travellers = Math.max(1, Math.trunc(num(i?.travellers)) || 1);
  const flight = i?.noFlight ? 0 : partyFare(num(i?.flightPerPerson), travellers);
  const activities = partyActivitiesInr(i?.itinerary, travellers);
  return calculateTripPricing({
    flight,
    stay: num(i?.stayInr),
    activities,
    coupon: i?.coupon,
  });
}

/** Counts Priceable_Activities by price source; each is counted exactly once. */
export function priceSourceCounts(it: Itinerary): SourceCounts {
  const counts: SourceCounts = { web: 0, ai: 0, estimated: 0 };
  const days = Array.isArray(it?.days) ? it.days : [];
  for (const d of days) {
    const acts = Array.isArray(d?.activities) ? d.activities : [];
    for (const a of acts) {
      if (!a || typeof a !== "object") continue;
      // Places-first Stops are never "estimated"; unpricedStopCount reports them.
      if (a.webDetails) continue;
      const cls = a.costClass ?? classifyActivity(a, {});
      if (!isPriceable(cls)) continue;
      if (a.priceSource === "web") counts.web += 1;
      else if (a.priceSource === "ai") counts.ai += 1;
      else counts.estimated += 1;
    }
  }
  return counts;
}

/**
 * Number of places-first Stops (those with `webDetails`) without an accepted web
 * price. Legacy Stops are never counted. Totals already include accepted prices only.
 */
export function unpricedStopCount(activities: readonly Activity[] | null | undefined): number {
  if (!Array.isArray(activities)) return 0;
  let n = 0;
  for (const a of activities) {
    if (a && typeof a === "object" && a.webDetails && a.priceSource !== "web") n += 1;
  }
  return n;
}

/** "3 web-priced, 4 AI estimate, 2 estimated"; zero parts omitted; "" when all zero. */
export function formatSourceCounts(c: SourceCounts): string {
  const parts: string[] = [];
  if (num(c?.web) > 0) parts.push(`${c.web} web-priced`);
  if (num(c?.ai) > 0) parts.push(`${c.ai} AI estimate`);
  if (num(c?.estimated) > 0) parts.push(`${c.estimated} estimated`);
  return parts.join(", ");
}

/** True when any Stop is a places-first Stop (has `webDetails`). Legacy lists give false. */
export function hasWebDetails(activities: readonly Activity[] | null | undefined): boolean {
  return Array.isArray(activities) && activities.some((a) => !!a && typeof a === "object" && !!a.webDetails);
}

/** True when any day of the itinerary holds a places-first Stop. */
export function itineraryHasWebDetails(it: Itinerary | null | undefined): boolean {
  const days = Array.isArray(it?.days) ? it!.days : [];
  return days.some((d) => hasWebDetails(d?.activities));
}
