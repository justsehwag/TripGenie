/**
 * Pick engine (pure) - design "9. lib/pick-engine.ts".
 *
 * Scores the offers in the current filtered Results_View so the Recommended
 * sort can order them and the AI_Pick can be chosen. Works on the normalised
 * `StayItem` / `FlightItem` records from `lib/results-view.ts`, so live and
 * estimate offers share one implementation.
 *
 * This module is framework-free: no React, no Next.js, no `fetch`.
 *
 * Sections:
 *  1. Median and numeric helpers                (task 4.1)
 *  2. Stay and flight scoring                   (task 4.1)
 *  3. pickStay, pickFlight and reason builder   (task 4.3)
 *
 * Requirements: 14.1, 14.2, 15.1.
 */

import {
  DEFAULT_FLIGHTS_VIEW,
  DEFAULT_STAYS_VIEW,
  sortFlights,
  sortStays,
  type FlightItem,
  type StayItem,
} from "./results-view";

// ===========================================================================
// 1. Median and numeric helpers
// ===========================================================================

/**
 * Median of the finite values; the mean of the two middle values for even
 * counts. Returns 0 when no finite value is given. The input is not mutated.
 */
export function median(values: number[]): number {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median nightly price (INR) over the stays in view - the stays Median_Price. */
export function staysMedian(items: StayItem[]): number {
  return median(items.map((i) => i.price));
}

/** Median per-person fare (INR) over the flights in view - the flights Median_Price. */
export function flightsMedian(items: FlightItem[]): number {
  return median(items.map((i) => i.fare));
}

function clamp(x: number, lo: number, hi: number): number {
  if (Number.isNaN(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

/** A present, finite score input (null / undefined / NaN / Infinity count as missing). */
function present(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Weighted mean over the present inputs, so missing weights are redistributed (Req 14.2). */
function weightedMean(parts: ReadonlyArray<readonly [score: number, weight: number]>): number {
  let num = 0;
  let den = 0;
  for (const [s, w] of parts) {
    num += w * s;
    den += w;
  }
  return den > 0 ? num / den : 0;
}

/**
 * `best / value` in [0, 1] for "lower is better" inputs (fare, duration).
 * A non-positive value is treated as the best possible (1); a non-finite one as 0.
 */
function lowerIsBetter(best: number, value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 1;
  return clamp(Math.max(0, best) / value, 0, 1);
}

// ===========================================================================
// 2. Stay and flight scoring
// ===========================================================================

/** Stay input weights (design table, Req 14.1). */
export const STAY_WEIGHTS = Object.freeze({
  price: 0.35,
  rating: 0.3,
  reviews: 0.15,
  location: 0.1,
  amenities: 0.1,
});

/** Flight input weights (design, Req 15.1). */
export const FLIGHT_WEIGHTS = Object.freeze({
  fare: 0.5,
  duration: 0.3,
  stops: 0.2,
});

/** Price input: `clamp(0.5 × median / price, 0, 1)`; price = median gives 0.5. */
function stayPriceScore(price: number, med: number): number {
  if (!Number.isFinite(price)) return 0;
  if (price <= 0) return 1;
  return clamp((0.5 * med) / price, 0, 1);
}

/**
 * Stay scores keyed by `item.key` (Req 14.1, 14.2), computed over the items
 * given (the filtered Results_View).
 *
 * | Input     | Score                                                    | Weight |
 * |-----------|----------------------------------------------------------|--------|
 * | Price     | clamp(0.5 × median / price, 0, 1)                        | 0.35   |
 * | Rating    | rating / 5                                               | 0.30   |
 * | Reviews   | log10(1 + reviews) / log10(1 + maxReviewsInView), 1 if max is 0 | 0.15 |
 * | Location  | locationRating / 5                                       | 0.10   |
 * | Amenities | min(amenityCount, 10) / 10                               | 0.10   |
 *
 * `score = Σ wᵢsᵢ / Σ wᵢ` over the inputs present on the item. Price is always present.
 */
export function scoreStays(items: StayItem[]): Map<string, number> {
  const scores = new Map<string, number>();
  if (items.length === 0) return scores;

  const med = staysMedian(items);
  let maxReviews = 0;
  for (const i of items) {
    if (present(i.reviews) && i.reviews > maxReviews) maxReviews = i.reviews;
  }
  const maxLog = Math.log10(1 + maxReviews);

  for (const item of items) {
    const parts: Array<readonly [number, number]> = [
      [stayPriceScore(item.price, med), STAY_WEIGHTS.price],
    ];
    if (present(item.rating)) {
      parts.push([clamp(item.rating / 5, 0, 1), STAY_WEIGHTS.rating]);
    }
    if (present(item.reviews)) {
      const r = Math.max(0, item.reviews);
      const s = maxLog > 0 ? clamp(Math.log10(1 + r) / maxLog, 0, 1) : 1;
      parts.push([s, STAY_WEIGHTS.reviews]);
    }
    if (present(item.locationRating)) {
      parts.push([clamp(item.locationRating / 5, 0, 1), STAY_WEIGHTS.location]);
    }
    if (present(item.amenityCount)) {
      parts.push([clamp(Math.min(item.amenityCount, 10) / 10, 0, 1), STAY_WEIGHTS.amenities]);
    }
    scores.set(item.key, weightedMean(parts));
  }
  return scores;
}

/** 1 for non-stop, 0.8 for one stop, 0.6 for two or more (Req 15.1). */
export function stopsScore(stops: number): number {
  if (!(stops > 0)) return 1;
  if (stops < 2) return 0.8;
  return 0.6;
}

/**
 * Flight scores keyed by `item.key` (Req 15.1):
 * `0.5 × minFare/fare + 0.3 × minDuration/duration + 0.2 × stopsScore`,
 * with minima taken over the items given (the filtered Results_View).
 * `rankFlights` in `components/flight-offer-card.tsx` is left unchanged.
 */
export function scoreFlights(items: FlightItem[]): Map<string, number> {
  const scores = new Map<string, number>();
  if (items.length === 0) return scores;

  let minFare = Infinity;
  let minDuration = Infinity;
  for (const i of items) {
    if (Number.isFinite(i.fare) && i.fare < minFare) minFare = i.fare;
    if (Number.isFinite(i.durationMin) && i.durationMin < minDuration) minDuration = i.durationMin;
  }
  if (!Number.isFinite(minFare)) minFare = 0;
  if (!Number.isFinite(minDuration)) minDuration = 0;

  for (const item of items) {
    const score =
      FLIGHT_WEIGHTS.fare * lowerIsBetter(minFare, item.fare) +
      FLIGHT_WEIGHTS.duration * lowerIsBetter(minDuration, item.durationMin) +
      FLIGHT_WEIGHTS.stops * stopsScore(item.stops);
    scores.set(item.key, score);
  }
  return scores;
}

// ===========================================================================
// 3. pickStay, pickFlight and reason builder (task 4.3)
// ===========================================================================
/**
 * A single plain-language fact in a Pick_Reason. `numbers` records every number
 * printed in `text`, so the honesty property can check the reason against the
 * source fields, the Median_Price and the provider insights (Req 14.10, 21.4).
 */
export interface PickFact {
  text: string;
  numbers: number[];
}

/** The AI_Pick: the chosen offer key, its assembled reason and the facts behind it. */
export interface Pick {
  key: string;
  reason: string;
  facts: PickFact[];
}

/** Minimal price-insights shape the flight pick needs; avoids importing the
 * server-only flights adapter. The flights result's `typicalRange` is
 * `[low, high]` per-passenger-basis fares, or `null` when absent. */
export interface PickInsights {
  typicalRange: [number, number] | null;
}

/** INR currency symbol (U+20B9), kept as an escape so the source stays ASCII. */
const RUPEE = "\u20b9";

/**
 * Floored "percent below the median" (Req 14.7, 15.6 wording):
 * `floor((median - price) / median * 100)`, returned only when `price < median`
 * and the floored value is at least 1; otherwise `null`.
 */
function percentBelowMedian(price: number, med: number): number | null {
  if (!Number.isFinite(price) || !Number.isFinite(med) || med <= 0) return null;
  if (!(price < med)) return null;
  const p = Math.floor(((med - price) / med) * 100);
  return p >= 1 ? p : null;
}

/** Keep the first `max` facts that apply, so a reason cites one to three facts (Req 14.6, 15.5). */
function firstFacts(candidates: Array<PickFact | null>, max: number): PickFact[] {
  const kept: PickFact[] = [];
  for (const c of candidates) {
    if (c) kept.push(c);
    if (kept.length >= max) break;
  }
  return kept;
}

/** Assemble the reason sentence and, for estimates, append the comparison note. */
function buildReason(facts: PickFact[], estimated: boolean, estimateNote: string): string {
  const parts = facts.map((f) => f.text).filter((t) => t.length > 0);
  if (estimated) parts.push(estimateNote);
  return parts.join(" ");
}

/**
 * The stays AI_Pick (Req 14.3-14.10, 21.4). It is the first stay under the
 * Recommended order (score, then lower price, then provider order), returned
 * only when at least two stays are in view; otherwise `null`.
 *
 * Facts, in design order, first three that apply:
 *  1. `Rated {rating} by {reviews} guests` (or `Rated {rating}/5` without reviews).
 *  2. `{p}% below the median nightly price here` (only when price < median and p >= 1).
 *  3. `{n}-star`.
 *  4. `Location rated {x}/5`.
 * Fallback `{RUPEE}{price} per night` guarantees at least one fact.
 * For estimates the sentence "Compared among estimated prices." is appended (Req 14.8).
 */
export function pickStay(items: StayItem[], ctx: { estimated: boolean }): Pick | null {
  if (items.length < 2) return null;

  const scores = scoreStays(items);
  const ordered = sortStays(items, DEFAULT_STAYS_VIEW, scores);
  const pick = ordered[0];
  if (!pick) return null;

  const med = staysMedian(items);

  const ratingFact: PickFact | null = present(pick.rating)
    ? present(pick.reviews)
      ? { text: `Rated ${pick.rating} by ${pick.reviews} guests`, numbers: [pick.rating, pick.reviews] }
      : { text: `Rated ${pick.rating}/5`, numbers: [pick.rating, 5] }
    : null;

  const p = percentBelowMedian(pick.price, med);
  const medianFact: PickFact | null =
    p !== null ? { text: `${p}% below the median nightly price here`, numbers: [p] } : null;

  const starFact: PickFact | null =
    present(pick.hotelClass) && pick.hotelClass > 0
      ? { text: `${pick.hotelClass}-star`, numbers: [pick.hotelClass] }
      : null;

  const locationFact: PickFact | null = present(pick.locationRating)
    ? { text: `Location rated ${pick.locationRating}/5`, numbers: [pick.locationRating, 5] }
    : null;

  let facts = firstFacts([ratingFact, medianFact, starFact, locationFact], 3);
  if (facts.length === 0) {
    facts = [{ text: `${RUPEE}${pick.price} per night`, numbers: [pick.price] }];
  }

  const reason = buildReason(facts, ctx.estimated, "Compared among estimated prices.");
  return { key: pick.key, reason, facts };
}

/**
 * The flights AI_Pick (Req 15.2-15.9, 21.4). It is the first flight under the
 * Recommended order (score, then lower fare, then shorter duration, then
 * provider order), returned only when at least two flights are in view;
 * otherwise `null`.
 *
 * Facts, in design order, first three that apply, with an airline name prefixed
 * only when the provider returned one for the pick (Req 15.7):
 *  1. `Non-stop` or `{n} stop(s) via {codes}`.
 *  2. `{h}h {m}m total`.
 *  3. `{p}% below the median fare` (only when fare < median and p >= 1).
 *  4. `Total fare is below/within Google's typical range of {RUPEE}{low}-{RUPEE}{high}`
 *     (only when insights exist; the pick's total fare is compared with the range).
 * Fallback `{RUPEE}{fare} per person` guarantees at least one fact.
 * For estimates the sentence "Compared among estimated fares." is appended (Req 15.8).
 */
export function pickFlight(
  items: FlightItem[],
  ctx: { estimated: boolean; insights: PickInsights | null; totalFare: (key: string) => number }
): Pick | null {
  if (items.length < 2) return null;

  const scores = scoreFlights(items);
  const ordered = sortFlights(items, DEFAULT_FLIGHTS_VIEW, scores);
  const pick = ordered[0];
  if (!pick) return null;

  const med = flightsMedian(items);

  const airline = pick.airlines.length > 0 ? pick.airlines[0] : null;

  const stopsFact: PickFact = (() => {
    if (!(pick.stops > 0)) return { text: "Non-stop", numbers: [] };
    const n = pick.stops;
    const plural = n === 1 ? "stop" : "stops";
    return { text: `${n} ${plural}`, numbers: [n] };
  })();

  const durationFact: PickFact | null = Number.isFinite(pick.durationMin)
    ? (() => {
        const total = Math.max(0, Math.round(pick.durationMin));
        const h = Math.floor(total / 60);
        const m = total % 60;
        return { text: `${h}h ${m}m total`, numbers: [h, m] };
      })()
    : null;

  const p = percentBelowMedian(pick.fare, med);
  const medianFact: PickFact | null =
    p !== null ? { text: `${p}% below the median fare`, numbers: [p] } : null;

  const rangeFact: PickFact | null = (() => {
    const range = ctx.insights?.typicalRange;
    if (!range) return null;
    const [low, high] = range;
    if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
    const total = ctx.totalFare(pick.key);
    if (!Number.isFinite(total)) return null;
    const position = total < low ? "below" : "within";
    return {
      text: `Total fare is ${position} Google's typical range of ${RUPEE}${low}-${RUPEE}${high}`,
      numbers: [low, high],
    };
  })();

  const prefix = (f: PickFact): PickFact =>
    airline ? { text: `${airline} ${f.text.charAt(0).toLowerCase()}${f.text.slice(1)}`, numbers: f.numbers } : f;

  let facts = firstFacts([stopsFact, durationFact, medianFact, rangeFact], 3);
  if (facts.length === 0) {
    facts = [{ text: `${RUPEE}${pick.fare} per person`, numbers: [pick.fare] }];
  }
  // Prefix only the leading fact with the airline name, so the sentence reads naturally.
  if (airline && facts.length > 0) {
    facts = [prefix(facts[0]), ...facts.slice(1)];
  }

  const reason = buildReason(facts, ctx.estimated, "Compared among estimated fares.");
  return { key: pick.key, reason, facts };
}
