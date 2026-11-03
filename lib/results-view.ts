/**
 * Results view engine (pure) - design "8. lib/results-view.ts".
 *
 * One implementation serves live and estimate offers: pages normalise their
 * offers into small `StayItem` / `FlightItem` records and the engine works on
 * those. The View_State (sort, filters, page size) lives in the URL so a
 * refresh or a shared link reproduces the same view (Req 12).
 *
 * This module is framework-free: no React, no Next.js, no `fetch`.
 *
 * Sections:
 *  1. Item and view types, defaults                       (task 3.1)
 *  2. URL parse / serialise for stays, flights and cars    (task 3.1)
 *  3. Search href builder for the search forms             (task 3.1)
 *  4. Capabilities, filtering, sorting and paging          (task 3.3)
 *  5. Active filter pills and arrangeCars                  (task 3.9)
 *
 * URL rules (Req 12.3, 12.4, 12.5):
 *  - An unknown or malformed parameter is ignored and its field takes the default.
 *  - A list parameter (`stops`, `window`, `airline`) with any invalid member is
 *    ignored as a whole.
 *  - Lists are kept in canonical form (sorted, unique), both when parsed and
 *    when serialised, so `parse(serialize(v))` equals `v` for every canonical view.
 *  - Parameters equal to their defaults are omitted, so the default view
 *    serialises to an empty query string.
 *
 * Requirements: 3.5, 11.5, 12.2, 12.3, 12.4, 12.5, 12.6, 13.2.
 */

import { serializeCriteria, type SearchCriteria } from "./search-criteria";
import type { CarOffer } from "./types";

// ===========================================================================
// 1. Item and view types, defaults
// ===========================================================================

/** A stay normalised for the view engine (live hotel or estimate stay). */
export interface StayItem {
  key: string;
  /** Provider / estimator order; the final tie-break for every sort. */
  order: number;
  /** Nightly price in INR. */
  price: number;
  rating: number | null;
  reviews: number | null;
  /** Live only. */
  hotelClass: number | null;
  /** Estimate only. */
  style: "Budget" | "Comfort" | "Luxury" | null;
  freeCancellation: boolean | null;
  locationRating: number | null;
  amenityCount: number | null;
}

/** A flight normalised for the view engine (live itinerary or estimate flight). */
export interface FlightItem {
  key: string;
  order: number;
  /** Per-person fare in INR. */
  fare: number;
  durationMin: number;
  stops: number;
  /** "YYYY-MM-DD HH:MM" or "HH:MM"; lexicographic order is chronological. */
  departKey: string;
  /** 0-23. */
  departHour: number;
  /** Empty for estimates or when the provider does not return names. */
  airlines: string[];
}

export type StaysSort = "recommended" | "price-asc" | "price-desc" | "rating" | "reviews";
export type StayStyle = "Any" | "Budget" | "Comfort" | "Luxury";
export type MinRating = 0 | 3.5 | 4 | 4.5;

export interface StaysView {
  sort: StaysSort;
  style: StayStyle;
  minPrice: number | null;
  maxPrice: number | null;
  minRating: MinRating;
  freeCancel: boolean;
  /** Number of visible offers: 10, 20, 30, ... */
  show: number;
}

export type FlightsSort = "recommended" | "cheapest" | "fastest" | "earliest";
/** "2" means 2 or more stops. */
export type StopBand = "0" | "1" | "2";
export type DepartWindow = "early" | "morning" | "afternoon" | "evening";

export interface FlightsView {
  sort: FlightsSort;
  /** Sorted, unique; empty = any. */
  stops: StopBand[];
  /** Sorted, unique; empty = any. */
  airlines: string[];
  /** Canonical (chronological) order, unique; empty = any. */
  windows: DepartWindow[];
  maxFare: number | null;
  show: number;
}

/** Cars sort/filter values match the existing `app/cars/page.tsx` controls. */
export type CarsSort = "price" | "seats" | "class";
export type CarTransmission = "automatic" | "manual";

export interface CarsView {
  sort: CarsSort;
  carClass: string | null;
  transmission: CarTransmission | null;
}

/** Offers per page and the `show` step. */
export const PAGE_SIZE = 10;
/** Largest `show` value accepted from the URL. */
export const MAX_SHOW_PARAM = 30;

export const STAYS_SORTS: readonly StaysSort[] = ["recommended", "price-asc", "price-desc", "rating", "reviews"];
export const STAY_STYLES: readonly StayStyle[] = ["Any", "Budget", "Comfort", "Luxury"];
export const MIN_RATINGS: readonly MinRating[] = [0, 3.5, 4, 4.5];
export const FLIGHTS_SORTS: readonly FlightsSort[] = ["recommended", "cheapest", "fastest", "earliest"];
export const STOP_BANDS: readonly StopBand[] = ["0", "1", "2"];
export const DEPART_WINDOWS: readonly DepartWindow[] = ["early", "morning", "afternoon", "evening"];
export const CARS_SORTS: readonly CarsSort[] = ["price", "seats", "class"];
/** Car classes offered by the cars page filter (exact, case-sensitive). */
export const CAR_CLASSES: readonly string[] = ["Economy", "Compact", "SUV", "Luxury"];
export const CAR_TRANSMISSIONS: readonly CarTransmission[] = ["automatic", "manual"];

export const DEFAULT_STAYS_VIEW: StaysView = Object.freeze({
  sort: "recommended",
  style: "Any",
  minPrice: null,
  maxPrice: null,
  minRating: 0,
  freeCancel: false,
  show: PAGE_SIZE,
}) as StaysView;

export const DEFAULT_FLIGHTS_VIEW: FlightsView = Object.freeze({
  sort: "recommended",
  stops: Object.freeze([]) as unknown as StopBand[],
  airlines: Object.freeze([]) as unknown as string[],
  windows: Object.freeze([]) as unknown as DepartWindow[],
  maxFare: null,
  show: PAGE_SIZE,
}) as FlightsView;

export const DEFAULT_CARS_VIEW: CarsView = Object.freeze({
  sort: "price",
  carClass: null,
  transmission: null,
}) as CarsView;

// ===========================================================================
// 2. URL parse / serialise
// ===========================================================================

/** Accepted inputs for the parsers: URLSearchParams, a query string, or Next's searchParams record. */
export type ViewParamsInput =
  | URLSearchParams
  | string
  | Record<string, string | string[] | undefined>;

/** Normalise any accepted input to URLSearchParams (repeated values preserved). */
function toParams(input: ViewParamsInput): URLSearchParams {
  if (input instanceof URLSearchParams) return input;
  if (typeof input === "string") return new URLSearchParams(input);
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) p.append(k, item);
    else p.append(k, v);
  }
  return p;
}

/** Strict positive integer ("1", "2500"); no signs, decimals, spaces or leading zeros. */
function positiveInt(raw: string | null): number | null {
  if (raw === null || !/^[1-9]\d{0,14}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** `show`: a multiple of PAGE_SIZE between PAGE_SIZE and MAX_SHOW_PARAM; otherwise the default. */
function parseShow(raw: string | null): number {
  const n = positiveInt(raw);
  if (n === null || n % PAGE_SIZE !== 0 || n > MAX_SHOW_PARAM) return PAGE_SIZE;
  return n;
}

function oneOf<T extends string>(raw: string | null, allowed: readonly T[]): T | null {
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}

/** Unique members in the order of `canonical`. */
function canonicalList<T extends string>(values: readonly T[], canonical: readonly T[]): T[] {
  return canonical.filter((c) => values.includes(c));
}

/**
 * Strict comma list: every member must be allowed, otherwise the whole
 * parameter is ignored (null). Result is canonical (ordered, unique).
 */
function parseStrictList<T extends string>(raw: string | null, allowed: readonly T[]): T[] | null {
  if (raw === null) return null;
  const parts = raw.split(",");
  if (parts.some((part) => !(allowed as readonly string[]).includes(part))) return null;
  return canonicalList(parts as T[], allowed);
}

/** Airline name: 1-60 chars of letters, digits, space and `.&'-`, not blank. */
// Built with the constructor: the tsconfig target (ES2017) predates regex
// property escapes in literals, while every supported runtime has them.
const AIRLINE_NAME = new RegExp("^[\\p{L}\\p{N} .&'-]{1,60}$", "u");

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export function isValidAirlineName(name: string): boolean {
  return AIRLINE_NAME.test(name) && name.trim().length > 0;
}

/** Sorted, unique airline names (code-unit order, deterministic). */
function canonicalAirlines(names: readonly string[]): string[] {
  return [...new Set(names)].sort();
}

// ---------------------------------------------------------------------------
// Stays
// ---------------------------------------------------------------------------

/** Parse the Stays View_State; unknown or malformed values fall back per field (Req 12.2, 12.3). */
export function parseStaysView(input: ViewParamsInput): StaysView {
  const p = toParams(input);

  const sort = oneOf(p.get("sort"), STAYS_SORTS) ?? DEFAULT_STAYS_VIEW.sort;
  const style = oneOf(p.get("stayStyle"), STAY_STYLES) ?? DEFAULT_STAYS_VIEW.style;

  let minPrice = positiveInt(p.get("minPrice"));
  let maxPrice = positiveInt(p.get("maxPrice"));
  // A range with min > max is ignored as a pair.
  if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
    minPrice = null;
    maxPrice = null;
  }

  const ratingRaw = p.get("minRating");
  let minRating: MinRating = DEFAULT_STAYS_VIEW.minRating;
  if (ratingRaw !== null && /^\d(\.\d)?$/.test(ratingRaw)) {
    const n = Number(ratingRaw);
    if (n !== 0 && (MIN_RATINGS as readonly number[]).includes(n)) minRating = n as MinRating;
  }

  return {
    sort,
    style,
    minPrice,
    maxPrice,
    minRating,
    freeCancel: p.get("freeCancel") === "1",
    show: parseShow(p.get("show")),
  };
}

/** Serialise the Stays View_State, omitting defaults (Req 12.4, 12.5). */
export function serializeStaysView(v: StaysView): URLSearchParams {
  const p = new URLSearchParams();
  const d = DEFAULT_STAYS_VIEW;
  if (v.sort !== d.sort) p.set("sort", v.sort);
  if (v.style !== d.style) p.set("stayStyle", v.style);
  if (v.minPrice !== null) p.set("minPrice", String(v.minPrice));
  if (v.maxPrice !== null) p.set("maxPrice", String(v.maxPrice));
  if (v.minRating !== d.minRating) p.set("minRating", String(v.minRating));
  if (v.freeCancel) p.set("freeCancel", "1");
  if (v.show !== d.show) p.set("show", String(v.show));
  return p;
}

// ---------------------------------------------------------------------------
// Flights
// ---------------------------------------------------------------------------

/** Legacy flights `sort` values (Req 11.5). */
const LEGACY_FLIGHTS_SORT: Record<string, FlightsSort> = {
  price: "cheapest",
  duration: "fastest",
  departure: "earliest",
};

/** Legacy `maxStops` values mapped to the equivalent stops filter (Req 11.5). */
const LEGACY_MAX_STOPS: Record<string, StopBand[]> = {
  "0": ["0"],
  "1": ["0", "1"],
};

/**
 * Parse the Flights View_State (Req 12.2, 12.3), mapping the legacy
 * `sort=price|duration|departure` and `maxStops=0|1` parameters (Req 11.5).
 * A valid `stops` parameter takes precedence over `maxStops`.
 */
export function parseFlightsView(input: ViewParamsInput): FlightsView {
  const p = toParams(input);

  const sortRaw = p.get("sort");
  const sort =
    oneOf(sortRaw, FLIGHTS_SORTS) ??
    (sortRaw !== null && hasOwn(LEGACY_FLIGHTS_SORT, sortRaw) ? LEGACY_FLIGHTS_SORT[sortRaw] : null) ??
    DEFAULT_FLIGHTS_VIEW.sort;

  let stops = parseStrictList(p.get("stops"), STOP_BANDS);
  if (stops === null) {
    const legacy = p.get("maxStops");
    stops = legacy !== null && hasOwn(LEGACY_MAX_STOPS, legacy) ? [...LEGACY_MAX_STOPS[legacy]] : [];
  }

  const airlineRaw = p.getAll("airline");
  const airlines = airlineRaw.every(isValidAirlineName) ? canonicalAirlines(airlineRaw) : [];

  const windows = parseStrictList(p.get("window"), DEPART_WINDOWS) ?? [];

  return {
    sort,
    stops,
    airlines,
    windows,
    maxFare: positiveInt(p.get("maxFare")),
    show: parseShow(p.get("show")),
  };
}

/** Serialise the Flights View_State in canonical form, omitting defaults (Req 12.4, 12.5). */
export function serializeFlightsView(v: FlightsView): URLSearchParams {
  const p = new URLSearchParams();
  const d = DEFAULT_FLIGHTS_VIEW;
  if (v.sort !== d.sort) p.set("sort", v.sort);
  const stops = canonicalList(v.stops, STOP_BANDS);
  if (stops.length > 0) p.set("stops", stops.join(","));
  for (const name of canonicalAirlines(v.airlines)) p.append("airline", name);
  const windows = canonicalList(v.windows, DEPART_WINDOWS);
  if (windows.length > 0) p.set("window", windows.join(","));
  if (v.maxFare !== null) p.set("maxFare", String(v.maxFare));
  if (v.show !== d.show) p.set("show", String(v.show));
  return p;
}

// ---------------------------------------------------------------------------
// Cars (existing `sort`, `carClass`, `transmission` names and values)
// ---------------------------------------------------------------------------

/** Parse the Cars View_State; unknown values are ignored and take the default (Req 13.2). */
export function parseCarsView(input: ViewParamsInput): CarsView {
  const p = toParams(input);
  return {
    sort: oneOf(p.get("sort"), CARS_SORTS) ?? DEFAULT_CARS_VIEW.sort,
    carClass: oneOf(p.get("carClass"), CAR_CLASSES) ?? DEFAULT_CARS_VIEW.carClass,
    transmission: oneOf(p.get("transmission"), CAR_TRANSMISSIONS) ?? DEFAULT_CARS_VIEW.transmission,
  };
}

/** Serialise the Cars View_State, omitting defaults. */
export function serializeCarsView(v: CarsView): URLSearchParams {
  const p = new URLSearchParams();
  if (v.sort !== DEFAULT_CARS_VIEW.sort) p.set("sort", v.sort);
  if (v.carClass !== null) p.set("carClass", v.carClass);
  if (v.transmission !== null) p.set("transmission", v.transmission);
  return p;
}

// ===========================================================================
// 3. Search href builder (Req 3.5, 12.6)
// ===========================================================================

/**
 * Build a results URL for a search form submission: the criteria serialised by
 * `serializeCriteria`, followed by the current View_State parameters.
 *
 * View params with empty values are skipped, and a view param never overrides
 * a criteria param, so `parseCriteria` on the result reproduces the criteria.
 * Repeated view params (e.g. `airline`) are preserved.
 */
export function buildResultsHref(
  path: string,
  criteria: SearchCriteria,
  viewParams?: ViewParamsInput,
): string {
  const params = new URLSearchParams(serializeCriteria(criteria));
  const criteriaKeys = new Set(params.keys());
  if (viewParams !== undefined) {
    for (const [k, v] of toParams(viewParams)) {
      if (v === "" || criteriaKeys.has(k)) continue;
      params.append(k, v);
    }
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

// ===========================================================================
// 4. Capabilities, filtering, sorting and paging (task 3.3)
// ===========================================================================
//
// Every function below is pure: inputs are never mutated and a new array or
// object is returned. Requirements: 6.1, 10.1-10.7, 11.1-11.4, 14.11, 15.10,
// 16.4, 17.3.

/** Which stays controls the current Result_Set supports (live vs estimate). */
export interface StaysCaps {
  rating: boolean;
  reviews: boolean;
  freeCancel: boolean;
  /** Live hotels are style-filtered by star class, estimates by their own style. */
  styleBy: "class" | "style";
}

/** Which flights controls the current Result_Set supports. */
export interface FlightsCaps {
  airlines: boolean;
}

/** One airline filter option: a name present in the Result_Set and its offer count. */
export interface AirlineFacet {
  name: string;
  count: number;
}

/**
 * Stays capabilities (Req 10.4, 10.7). Estimate stays carry no rating, review
 * count or cancellation terms. "Free cancellation" is offered only when some
 * live hotel reports `freeCancellation === true`.
 */
export function staysCaps(items: StayItem[], live: boolean): StaysCaps {
  if (!live) return { rating: false, reviews: false, freeCancel: false, styleBy: "style" };
  return {
    rating: true,
    reviews: true,
    freeCancel: items.some((i) => i.freeCancellation === true),
    styleBy: "class",
  };
}

/** Flights capabilities (Req 11.4): the airline filter exists only for live offers. */
export function flightsCaps(items: FlightItem[], live: boolean): FlightsCaps {
  return { airlines: live && items.some((i) => i.airlines.length > 0) };
}

/** Reset every control the capabilities do not support to its default (Req 10.7). */
export function effectiveStaysView(v: StaysView, caps: StaysCaps): StaysView {
  const d = DEFAULT_STAYS_VIEW;
  let sort = v.sort;
  if ((sort === "rating" && !caps.rating) || (sort === "reviews" && !caps.reviews)) sort = d.sort;
  return {
    ...v,
    sort,
    minRating: caps.rating ? v.minRating : d.minRating,
    freeCancel: caps.freeCancel ? v.freeCancel : d.freeCancel,
  };
}

/**
 * Reset unsupported flights controls (Req 11.4) and drop selected airlines that
 * are not present in the Result_Set (Req 11.3). Lists stay canonical.
 */
export function effectiveFlightsView(v: FlightsView, caps: FlightsCaps, present: string[]): FlightsView {
  const presentSet = new Set(present);
  const airlines = caps.airlines ? canonicalAirlines(v.airlines.filter((a) => presentSet.has(a))) : [];
  return {
    ...v,
    stops: canonicalList(v.stops, STOP_BANDS),
    airlines,
    windows: canonicalList(v.windows, DEPART_WINDOWS),
  };
}

/**
 * Distinct airline names in the Result_Set with the number of offers that
 * include each one (an airline repeated within one offer counts once).
 * Ordered by count (descending), then name.
 */
export function airlineFacets(items: FlightItem[]): AirlineFacet[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const name of new Set(item.airlines)) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/** Inclusive star-class bands on `Math.round(hotelClass)` (Req 10.3). */
const CLASS_BANDS: Record<Exclude<StayStyle, "Any">, readonly [number, number]> = {
  Budget: [2, 3],
  Comfort: [3, 4],
  Luxury: [4, 5],
};

function matchesStyle(item: StayItem, style: StayStyle): boolean {
  if (style === "Any") return true;
  // Estimates carry their own style and are filtered by equality (Req 10.6).
  if (item.style !== null) return item.style === style;
  // Live hotels: class band; a hotel without a class is excluded (Req 10.5).
  if (item.hotelClass === null || !Number.isFinite(item.hotelClass)) return false;
  const cls = Math.round(item.hotelClass);
  const [lo, hi] = CLASS_BANDS[style];
  return cls >= lo && cls <= hi;
}

/** Offers satisfying every active stays filter, in input order (Req 10.5, 10.6, 10.8). */
export function filterStays(items: StayItem[], v: StaysView): StayItem[] {
  return items.filter((item) => {
    if (!matchesStyle(item, v.style)) return false;
    if (v.minPrice !== null && !(item.price >= v.minPrice)) return false;
    if (v.maxPrice !== null && !(item.price <= v.maxPrice)) return false;
    if (v.minRating > 0 && (item.rating === null || !(item.rating >= v.minRating))) return false;
    if (v.freeCancel && item.freeCancellation !== true) return false;
    return true;
  });
}

function stopBand(stops: number): StopBand {
  const n = Math.min(Math.max(0, Math.floor(stops)), 2);
  return String(n) as StopBand;
}

function departWindow(hour: number): DepartWindow | null {
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
  if (hour < 6) return "early";
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

/** Offers satisfying every active flights filter, in input order (Req 11.2, 11.6). */
export function filterFlights(items: FlightItem[], v: FlightsView): FlightItem[] {
  const airlines = new Set(v.airlines);
  return items.filter((item) => {
    if (v.stops.length > 0 && !v.stops.includes(stopBand(item.stops))) return false;
    if (airlines.size > 0 && !item.airlines.some((a) => airlines.has(a))) return false;
    if (v.windows.length > 0) {
      const w = departWindow(item.departHour);
      if (w === null || !v.windows.includes(w)) return false;
    }
    if (v.maxFare !== null && !(item.fare <= v.maxFare)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Sorting (stable; ties broken by provider `order`)
// ---------------------------------------------------------------------------

type Cmp<T> = (a: T, b: T) => number;

const asc = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0);
const desc = (a: number, b: number): number => asc(b, a);
const ascStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Non-increasing value with missing (null) values after all present ones (Req 10.2). */
function descMissingLast(a: number | null, b: number | null): number {
  if (a === null || b === null) return a === null ? (b === null ? 0 : 1) : -1;
  return desc(a, b);
}

/** Missing score is treated as -Infinity. */
function scoreOf(scores: Map<string, number>, key: string): number {
  const s = scores.get(key);
  return typeof s === "number" && !Number.isNaN(s) ? s : -Infinity;
}

/** Copy-sort with `order` then input position as the final tie-breaks (stable, deterministic). */
function stableSort<T extends { order: number }>(items: T[], cmp: Cmp<T>): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => cmp(a.item, b.item) || asc(a.item.order, b.item.order) || a.index - b.index)
    .map((e) => e.item);
}

/**
 * Sort stays (Req 10.1, 10.2, 14.11). Recommended: non-increasing Pick_Engine
 * score, then lower price, then `order` (the pick tie-break, so the AI_Pick is first).
 */
export function sortStays(items: StayItem[], v: StaysView, scores: Map<string, number>): StayItem[] {
  let cmp: Cmp<StayItem>;
  switch (v.sort) {
    case "price-asc":
      cmp = (a, b) => asc(a.price, b.price);
      break;
    case "price-desc":
      cmp = (a, b) => desc(a.price, b.price);
      break;
    case "rating":
      cmp = (a, b) => descMissingLast(a.rating, b.rating);
      break;
    case "reviews":
      cmp = (a, b) => descMissingLast(a.reviews, b.reviews);
      break;
    case "recommended":
    default:
      cmp = (a, b) => desc(scoreOf(scores, a.key), scoreOf(scores, b.key)) || asc(a.price, b.price);
      break;
  }
  return stableSort(items, cmp);
}

/**
 * Sort flights (Req 11.1, 11.7, 15.10). Recommended: non-increasing score,
 * then lower fare, then shorter duration, then `order`.
 */
export function sortFlights(items: FlightItem[], v: FlightsView, scores: Map<string, number>): FlightItem[] {
  let cmp: Cmp<FlightItem>;
  switch (v.sort) {
    case "cheapest":
      cmp = (a, b) => asc(a.fare, b.fare);
      break;
    case "fastest":
      cmp = (a, b) => asc(a.durationMin, b.durationMin);
      break;
    case "earliest":
      cmp = (a, b) => ascStr(a.departKey, b.departKey);
      break;
    case "recommended":
    default:
      cmp = (a, b) =>
        desc(scoreOf(scores, a.key), scoreOf(scores, b.key)) ||
        asc(a.fare, b.fare) ||
        asc(a.durationMin, b.durationMin);
      break;
  }
  return stableSort(items, cmp);
}

// ---------------------------------------------------------------------------
// Paging (Req 6.1, 16.4, 17.3)
// ---------------------------------------------------------------------------

/** The first `show` items and whether more remain for "Show more". */
export function page<T>(items: T[], show: number): { visible: T[]; hasMore: boolean } {
  const n = Number.isFinite(show) ? Math.max(0, Math.floor(show)) : PAGE_SIZE;
  const visible = items.slice(0, n);
  return { visible, hasMore: items.length > visible.length };
}

// ===========================================================================
// 5. Active filter pills and arrangeCars (task 3.9)
// ===========================================================================
//
// Pills (Req 18.2, 18.3): one removable pill per active filter value. A pill's
// `remove()` returns a NEW view equal to the input with only that value
// removed (sort and page size untouched). "Clear all" resets every filter to
// its default, keeps the sort and resets the page size.
//
// Cars (Req 13.1, 13.2): `arrangeCars` reproduces the former page-local
// `arrangeOffers` of `app/cars/page.tsx` on a parsed (known-values-only) view.
//
// Non-ASCII characters are written as escapes (\u20B9 rupee, \u2013 en dash)
// so the source stays plain ASCII.

/** One removable filter pill. `id` is stable for a given filter value. */
export interface FilterPill<V> {
  id: string;
  label: string;
  /** The view without this filter value (a new object; the input is not mutated). */
  remove: () => V;
}

const RUPEE = "\u20B9";
const EN_DASH = "\u2013";
const INR_FORMAT = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

/** "\u20B92,000" style amount with en-IN grouping. */
function inr(n: number): string {
  return `${RUPEE}${INR_FORMAT.format(n)}`;
}

const STOP_LABELS: Record<StopBand, string> = {
  "0": "Non-stop",
  "1": "1 stop",
  "2": "2+ stops",
};

const WINDOW_LABELS: Record<DepartWindow, string> = {
  early: `Early (12am${EN_DASH}6am)`,
  morning: `Morning (6am${EN_DASH}12pm)`,
  afternoon: `Afternoon (12pm${EN_DASH}6pm)`,
  evening: `Evening (6pm${EN_DASH}12am)`,
};

/** Pills for the active Stays filters, in toolbar order. */
export function staysFilterPills(v: StaysView): FilterPill<StaysView>[] {
  const d = DEFAULT_STAYS_VIEW;
  const pills: FilterPill<StaysView>[] = [];
  if (v.style !== d.style) {
    pills.push({ id: "style", label: `${v.style} stays`, remove: () => ({ ...v, style: d.style }) });
  }
  if (v.minPrice !== null) {
    pills.push({ id: "minPrice", label: `${inr(v.minPrice)}+`, remove: () => ({ ...v, minPrice: null }) });
  }
  if (v.maxPrice !== null) {
    pills.push({ id: "maxPrice", label: `Up to ${inr(v.maxPrice)}`, remove: () => ({ ...v, maxPrice: null }) });
  }
  if (v.minRating !== d.minRating) {
    pills.push({
      id: "minRating",
      label: `Rating ${v.minRating.toFixed(1)}+`,
      remove: () => ({ ...v, minRating: d.minRating }),
    });
  }
  if (v.freeCancel !== d.freeCancel) {
    pills.push({ id: "freeCancel", label: "Free cancellation", remove: () => ({ ...v, freeCancel: d.freeCancel }) });
  }
  return pills;
}

/** Pills for the active Flights filters: one per stop band, airline and window, then max fare. */
export function flightsFilterPills(v: FlightsView): FilterPill<FlightsView>[] {
  const pills: FilterPill<FlightsView>[] = [];
  for (const band of canonicalList(v.stops, STOP_BANDS)) {
    pills.push({
      id: `stops:${band}`,
      label: STOP_LABELS[band],
      remove: () => ({ ...v, stops: v.stops.filter((s) => s !== band) }),
    });
  }
  for (const name of canonicalAirlines(v.airlines)) {
    pills.push({
      id: `airline:${name}`,
      label: name,
      remove: () => ({ ...v, airlines: v.airlines.filter((a) => a !== name) }),
    });
  }
  for (const w of canonicalList(v.windows, DEPART_WINDOWS)) {
    pills.push({
      id: `window:${w}`,
      label: WINDOW_LABELS[w],
      remove: () => ({ ...v, windows: v.windows.filter((x) => x !== w) }),
    });
  }
  if (v.maxFare !== null) {
    pills.push({
      id: "maxFare",
      label: `Up to ${inr(v.maxFare)} per person`,
      remove: () => ({ ...v, maxFare: null }),
    });
  }
  return pills;
}

function isFlightsView(v: StaysView | FlightsView): v is FlightsView {
  return Array.isArray((v as FlightsView).stops);
}

/** Pills for whichever view is given (design "8. lib/results-view.ts"). */
export function activeFilterPills(v: StaysView): FilterPill<StaysView>[];
export function activeFilterPills(v: FlightsView): FilterPill<FlightsView>[];
export function activeFilterPills(
  v: StaysView | FlightsView,
): FilterPill<StaysView>[] | FilterPill<FlightsView>[];
export function activeFilterPills(
  v: StaysView | FlightsView,
): FilterPill<StaysView>[] | FilterPill<FlightsView>[] {
  return isFlightsView(v) ? flightsFilterPills(v) : staysFilterPills(v);
}

/** "Clear all" for stays: every filter and `show` at default, sort kept (Req 18.3). */
export function clearStaysFilters(v: StaysView): StaysView {
  return { ...DEFAULT_STAYS_VIEW, sort: v.sort };
}

/** "Clear all" for flights: every filter and `show` at default, sort kept (Req 18.3). */
export function clearFlightsFilters(v: FlightsView): FlightsView {
  return { sort: v.sort, stops: [], airlines: [], windows: [], maxFare: null, show: DEFAULT_FLIGHTS_VIEW.show };
}

/** "Clear all" for whichever view is given. */
export function clearAllFilters(v: StaysView): StaysView;
export function clearAllFilters(v: FlightsView): FlightsView;
export function clearAllFilters(v: StaysView | FlightsView): StaysView | FlightsView;
export function clearAllFilters(v: StaysView | FlightsView): StaysView | FlightsView {
  return isFlightsView(v) ? clearFlightsFilters(v) : clearStaysFilters(v);
}

/**
 * Apply the Cars view (Req 13.1): filter by exact car class and transmission
 * (null = any), then sort by price per day (ascending), seats (descending) or
 * class name (`localeCompare`). Same semantics as the former page-local
 * `arrangeOffers`; the sort is stable and the input is not mutated.
 */
export function arrangeCars(offers: CarOffer[], v: CarsView): CarOffer[] {
  const out = offers.filter(
    (o) =>
      (v.carClass === null || o.carClass === v.carClass) &&
      (v.transmission === null || o.transmission === v.transmission),
  );
  switch (v.sort) {
    case "price":
      out.sort((a, b) => a.pricePerDay - b.pricePerDay);
      break;
    case "seats":
      out.sort((a, b) => b.seats - a.seats);
      break;
    case "class":
      out.sort((a, b) => a.carClass.localeCompare(b.carClass));
      break;
  }
  return out;
}
