/**
 * Trip cost aggregation (itinerary-price-trust).
 *
 * Pure and total: single source of truth for day totals, the activities line,
 * stay, flights, grand total, range totals and the composition text.
 * Never throws; bad numbers are coerced to safe defaults.
 */

import type { Activity, Itinerary, TripDay, TripPricing } from "./types";
import { formatInr } from "./itinerary-inr";

export type PriceTier = "web" | "estimate" | "google-range" | "google-level" | "ai" | "none";

export interface TierCounts {
  web: number;
  estimate: number;
  googleRange: number;
  googleLevel: number;
  ai: number;
  none: number;
  unverified: number;
}

export interface AggregateInput {
  itinerary: Itinerary;
  travellers: number;
  rooms: number;
  /** null when the route has no flights. */
  flight: { perPersonInr: number | null; live: boolean } | null;
  stay: { ratePerNightInr: number | null };
  discountInr: number;
  requestedDays?: number;
}

export interface DayCost {
  day: number;
  /** Party amount of Stop cost values; null when display is "not-priced". */
  costInr: number | null;
  rangeLowInr: number;
  rangeHighInr: number;
  display: "priced" | "range-only" | "not-priced";
  tiers: TierCounts;
}

export interface TripCost {
  days: DayCost[];
  nights: number;
  activities: { pricedInr: number; rangeLowInr: number; rangeHighInr: number; tiers: TierCounts };
  flightsInr: number | null;
  stayInr: number | null;
  discountInr: number;
  grandTotalInr: number;
  lowTotalInr: number;
  highTotalInr: number;
  coveredDays: number;
  requestedDays: number;
  composition: string;
}

function emptyTiers(): TierCounts {
  return { web: 0, estimate: 0, googleRange: 0, googleLevel: 0, ai: 0, none: 0, unverified: 0 };
}

function addTiers(a: TierCounts, b: TierCounts): TierCounts {
  return {
    web: a.web + b.web,
    estimate: a.estimate + b.estimate,
    googleRange: a.googleRange + b.googleRange,
    googleLevel: a.googleLevel + b.googleLevel,
    ai: a.ai + b.ai,
    none: a.none + b.none,
    unverified: a.unverified + b.unverified,
  };
}

function num(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function nonNeg(n: unknown): number {
  return Math.max(0, num(n));
}

function positive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

function daysOf(it: Itinerary | null | undefined): TripDay[] {
  return it && Array.isArray(it.days) ? it.days : [];
}

function activitiesOf(day: TripDay | null | undefined): Activity[] {
  return day && Array.isArray(day.activities) ? day.activities : [];
}

/** Source class of the price held by a Stop. */
export function stopTier(a: Activity): PriceTier {
  if (a?.priceSource === "web") return "web";
  if (num(a?.cost) > 0) return "estimate";
  const fb = a?.priceFallback;
  const range = fb?.google?.range;
  if (range && Number.isFinite(range.lowInr) && Number.isFinite(range.highInr)) return "google-range";
  if (fb?.google && typeof fb.google.level === "number") return "google-level";
  if (fb?.ai && Number.isFinite(fb.ai.lowInr) && Number.isFinite(fb.ai.highInr)) return "ai";
  return "none";
}

function rangeOf(a: Activity, tier: PriceTier): { low: number; high: number } | null {
  if (tier === "google-range") {
    const r = a.priceFallback?.google?.range;
    if (r) return { low: nonNeg(r.lowInr), high: Math.max(nonNeg(r.lowInr), nonNeg(r.highInr)) };
  }
  if (tier === "ai") {
    const r = a.priceFallback?.ai;
    if (r) return { low: nonNeg(r.lowInr), high: Math.max(nonNeg(r.lowInr), nonNeg(r.highInr)) };
  }
  return null;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isoMs(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = ISO_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const chk = new Date(t);
  if (Number.isNaN(t) || chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) {
    return null;
  }
  return t;
}

function nightsOf(days: readonly TripDay[]): number {
  const stamps: number[] = [];
  for (const d of days) {
    const t = isoMs(d?.date);
    if (t !== null) stamps.push(t);
  }
  if (stamps.length >= 2) {
    const diff = Math.round((stamps[stamps.length - 1] - stamps[0]) / 86_400_000);
    return Math.max(1, diff);
  }
  return Math.max(1, days.length - 1);
}

function range(low: number, high: number): string {
  return low === high ? formatInr(low) : `${formatInr(low)}-${formatInr(high).replace(/^INR /, "")}`;
}

export function aggregateTripCost(i: AggregateInput): TripCost {
  const travellers = Math.max(1, Math.trunc(num(i?.travellers)) || 1);
  const rooms = Math.max(1, Math.trunc(num(i?.rooms)) || 1);
  const vehicles = Math.ceil(travellers / 4);
  const days = daysOf(i?.itinerary);

  let webInr = 0;
  let estimateInr = 0;
  let googleLow = 0;
  let googleHigh = 0;
  let aiLow = 0;
  let aiHigh = 0;
  let tiers = emptyTiers();

  const dayCosts: DayCost[] = days.map((d, idx) => {
    const t = emptyTiers();
    let cost = 0;
    let low = 0;
    let high = 0;
    for (const a of activitiesOf(d)) {
      const mult = a?.costBasis === "group" ? vehicles : travellers;
      const tier = stopTier(a);
      const amount = nonNeg(a?.cost) * mult;
      if (a?.priceFallback?.unverifiedWeb) t.unverified += 1;
      switch (tier) {
        case "web":
          t.web += 1;
          webInr += amount;
          cost += amount;
          break;
        case "estimate":
          t.estimate += 1;
          estimateInr += amount;
          cost += amount;
          break;
        case "google-range": {
          t.googleRange += 1;
          const r = rangeOf(a, tier);
          if (r) {
            low += r.low * mult;
            high += r.high * mult;
            googleLow += r.low * mult;
            googleHigh += r.high * mult;
          }
          break;
        }
        case "ai": {
          t.ai += 1;
          const r = rangeOf(a, tier);
          if (r) {
            low += r.low * mult;
            high += r.high * mult;
            aiLow += r.low * mult;
            aiHigh += r.high * mult;
          }
          break;
        }
        case "google-level":
          t.googleLevel += 1;
          break;
        default:
          t.none += 1;
      }
    }
    const display: DayCost["display"] =
      t.web + t.estimate > 0 ? "priced" : t.googleRange + t.ai > 0 ? "range-only" : "not-priced";
    tiers = addTiers(tiers, t);
    return {
      day: typeof d?.day === "number" && Number.isFinite(d.day) ? d.day : idx + 1,
      costInr: display === "not-priced" ? null : cost,
      rangeLowInr: low,
      rangeHighInr: high,
      display,
      tiers: t,
    };
  });

  const pricedInr = dayCosts.reduce((s, d) => s + (d.costInr ?? 0), 0);
  const rangeLowInr = dayCosts.reduce((s, d) => s + d.rangeLowInr, 0);
  const rangeHighInr = dayCosts.reduce((s, d) => s + d.rangeHighInr, 0);
  const nights = nightsOf(days);

  const flight = i?.flight;
  const flightsInr = flight && flight.live && positive(flight.perPersonInr) ? flight.perPersonInr * travellers : null;
  const rate = i?.stay?.ratePerNightInr;
  const stayInr = positive(rate) ? rate * nights * rooms : null;
  const discountInr = nonNeg(i?.discountInr);

  const grandTotalInr = Math.max(0, pricedInr + (stayInr ?? 0) + (flightsInr ?? 0) - discountInr);

  const requestedDays = Math.max(
    0,
    Math.trunc(num(i?.requestedDays) || num(i?.itinerary?.completeness?.requestedDays) || days.length),
  );
  const coveredDays = days.length;

  const money: string[] = [];
  if (webInr > 0) money.push(`${formatInr(webInr)} from web prices`);
  if (estimateInr > 0) money.push(`${formatInr(estimateInr)} from estimates`);
  if (googleHigh > 0) money.push(`${range(googleLow, googleHigh)} Google price ranges`);
  if (aiHigh > 0) money.push(`${range(aiLow, aiHigh)} AI estimates`);
  const parts: string[] = [];
  if (money.length > 0) parts.push(money.join(" + "));
  if (tiers.googleLevel > 0) {
    parts.push(`${tiers.googleLevel} ${tiers.googleLevel === 1 ? "stop" : "stops"} with a Google price level only`);
  }
  if (tiers.none > 0) {
    parts.push(`${tiers.none} ${tiers.none === 1 ? "stop" : "stops"} without a price`);
  }
  if (coveredDays < requestedDays) parts.push(`prices cover ${coveredDays} of ${requestedDays} days`);
  const composition = parts.length > 0 ? parts.join("; ") : "No prices yet";

  return {
    days: dayCosts,
    nights,
    activities: { pricedInr, rangeLowInr, rangeHighInr, tiers },
    flightsInr,
    stayInr,
    discountInr,
    grandTotalInr,
    lowTotalInr: grandTotalInr + rangeLowInr,
    highTotalInr: grandTotalInr + rangeHighInr,
    coveredDays,
    requestedDays,
    composition,
  };
}

/** Maps the aggregate to the existing TripPricing shape (PDF builder). */
export function toTripPricing(t: TripCost): TripPricing {
  const flight = Math.round(t.flightsInr ?? 0);
  const stay = Math.round(t.stayInr ?? 0);
  const activities = Math.round(t.activities.pricedInr);
  return {
    flight,
    stay,
    activities,
    gross: flight + stay + activities,
    discount: Math.round(t.discountInr),
    coupon: "",
    finalPayable: Math.round(t.grandTotalInr),
    error: "",
  };
}
