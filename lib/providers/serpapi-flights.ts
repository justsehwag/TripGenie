/**
 * Google Flights adapter via SerpApi (server-only).
 *
 * This file owns the flight query types, validation, the provider parameters
 * and the fare basis. Normalisation (7.3), booking options (7.5) and the
 * search / returns / booking fetchers (7.7) are added in their own sections.
 *
 * Honesty rules:
 *  - Invalid queries never reach the provider (Req 2.3-2.8).
 *  - `flightParams` is the only place provider params are built; it never
 *    sends `no_cache` or server-side filters (Req 1.1, 6.4).
 *  - `fareFromProvider` is the only place the fare basis is defined (A1).
 *
 * SERVER-ONLY: import from server components and route handlers only.
 *
 * Requirements: 1.1, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 6.4.
 */

import { resolveAirport } from "@/lib/airports";
import { serpApiKey } from "@/lib/config";
import { todayIst } from "@/lib/ist-time";
import type { LiveStatus } from "@/lib/providers/provider-store";
// Used by the 7.3 / 7.5 / 7.7 sections below.
import {
  PAUSED_MESSAGE,
  cacheKey,
  cachedProviderCall,
  PROVIDER_DETAIL_TIMEOUT_MS,
  obj,
  posNum,
  safeHttpsUrl,
  str,
  type AdapterOptions,
  type FetchLike,
  type Json,
} from "@/lib/providers/serpapi-core";

export type { AdapterOptions, FetchLike, Json, LiveStatus };

export const LIVE_FLIGHTS_PROVIDER = "Google Flights via SerpApi" as const;
/** Opaque SerpApi booking / departure token shape (Req 20.4). */
export const FLIGHT_TOKEN = /^[A-Za-z0-9+/=_-]{8,4096}$/;
export const MAX_FLIGHTS = 30;

/** Only INR is requested from the provider (Req 1.1). */
const FLIGHT_CURRENCY = "INR";
const MIN_ADULTS = 1;
const MAX_ADULTS = 9;

/* ------------------------------------------------------------------------- *
 * Query and result types (Data Models)
 * ------------------------------------------------------------------------- */

export interface FlightFareQuery {
  /** Traveller input: city / airport name or a 3-letter code. */
  origin: string;
  destination: string;
  tripType: "round-trip" | "one-way";
  /** ISO date YYYY-MM-DD. */
  departDate: string;
  /** ISO date YYYY-MM-DD; required for round-trip. */
  returnDate?: string;
  cabin: string;
  adults: number;
  currency?: string;
}

export interface ResolvedFlightQuery {
  originCode: string;
  destinationCode: string;
  /** SerpApi trip type: 1 = round trip, 2 = one way. */
  type: 1 | 2;
  /** SerpApi travel class: 1 economy, 2 premium economy, 3 business, 4 first. */
  travelClass: 1 | 2 | 3 | 4;
  departDate: string;
  returnDate?: string;
  adults: number;
  currency: string;
}

export interface FlightSegment {
  from: string;
  fromName: string | null;
  /** "YYYY-MM-DD HH:MM" local time. */
  departTime: string;
  to: string;
  toName: string | null;
  arriveTime: string;
  airline: string | null;
  flightNumber: string | null;
  durationMin: number | null;
}

export interface LiveFlight {
  token: string;
  tokenKind: "booking" | "departure";
  /** Distinct, segment order; [] when none returned. */
  airlines: string[];
  /** https only. */
  airlineLogo: string | null;
  flightNumbers: string[];
  segments: FlightSegment[];
  departAirport: string;
  departTime: string;
  arriveAirport: string;
  arriveTime: string;
  /** total_duration, else sum(segments + layovers) when all present. */
  durationMin: number;
  /** layovers.length, else segments.length - 1. */
  stops: number;
  layoverAirports: string[];
  /** fareFromProvider(price, adults).perPerson */
  farePerPerson: number;
  /** Provider price. */
  totalFare: number;
  /** Provider "type", e.g. "Round trip". */
  priceType: string | null;
}

export interface PriceInsights {
  lowestPrice: number | null;
  priceLevel: string | null;
  /** Unchanged provider values. */
  typicalRange: [number, number] | null;
}

export interface FlightFaresResult {
  status: LiveStatus;
  provider: typeof LIVE_FLIGHTS_PROVIDER;
  currency: string;
  /** Completion time of the Provider_Request (ISO-8601). */
  checkedAt: string;
  /** Resolved codes when the query is valid. */
  route: { origin: string | null; destination: string | null };
  flights: LiveFlight[];
  insights: PriceInsights | null;
  error?: string;
}

export interface FlightBookingOption {
  /** book_with */
  source: string;
  /** First https airline_logos entry. */
  logo: string | null;
  isAirline: boolean;
  optionTitle: string | null;
  /** Positive number only. */
  price: number | null;
  /** https url; fields from post_data. */
  request: { url: string; method: "POST" | "GET"; fields: [string, string][] };
}

export interface FlightBookingResult {
  status: LiveStatus;
  provider: typeof LIVE_FLIGHTS_PROVIDER;
  currency: string;
  checkedAt: string;
  options: FlightBookingOption[];
  error?: string;
}

/* ------------------------------------------------------------------------- *
 * Cabin, validation, params, fare basis (task 7.1, pure)
 * ------------------------------------------------------------------------- */

/**
 * Map a cabin string to SerpApi `travel_class`. Accepts the app's values
 * ("economy", "premium", "business", "first") and the spelled-out variants
 * ("premium economy", "premium-economy", "Premium Economy", "first class"),
 * ignoring case and surrounding / internal whitespace, hyphens and underscores.
 */
export function cabinToTravelClass(cabin: string): 1 | 2 | 3 | 4 | null {
  if (typeof cabin !== "string") return null;
  const c = cabin.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  switch (c) {
    case "economy":
      return 1;
    case "premium":
    case "premium economy":
      return 2;
    case "business":
      return 3;
    case "first":
    case "first class":
      return 4;
    default:
      return null;
  }
}

/** True for a real calendar date in strict YYYY-MM-DD form. */
function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export const ORIGIN_UNRESOLVED =
  "We couldn't find the origin airport. Use a city name or a 3-letter airport code.";
export const DESTINATION_UNRESOLVED =
  "We couldn't find the destination airport. Use a city name or a 3-letter airport code.";
export const SAME_AIRPORT = "Origin and destination must be different.";
export const DEPART_INVALID = "Choose a departure date from today onwards to see live fares.";
export const RETURN_INVALID = "Choose a return date on or after the departure date to see live fares.";
export const TRAVELLERS_INVALID = "Travellers must be a whole number from 1 to 9 to see live fares.";
export const CABIN_INVALID = "Choose economy, premium economy, business or first to see live fares.";

/**
 * Validate in the design's order; the first failure wins and no provider call
 * is made by callers on failure (Req 2.3-2.8). Today is the IST calendar date.
 */
export function validateFlightQuery(
  q: FlightFareQuery,
  now: Date,
): { ok: true; resolved: ResolvedFlightQuery } | { ok: false; error: string } {
  const originCode = resolveAirport(q.origin);
  if (!originCode) return { ok: false, error: ORIGIN_UNRESOLVED };

  const destinationCode = resolveAirport(q.destination);
  if (!destinationCode) return { ok: false, error: DESTINATION_UNRESOLVED };

  if (originCode === destinationCode) return { ok: false, error: SAME_AIRPORT };

  // ISO YYYY-MM-DD strings compare correctly as plain strings.
  if (!isIsoDate(q.departDate) || q.departDate < todayIst(now)) {
    return { ok: false, error: DEPART_INVALID };
  }

  const roundTrip = q.tripType === "round-trip";
  if (roundTrip && (!isIsoDate(q.returnDate) || q.returnDate < q.departDate)) {
    return { ok: false, error: RETURN_INVALID };
  }

  if (!Number.isInteger(q.adults) || q.adults < MIN_ADULTS || q.adults > MAX_ADULTS) {
    return { ok: false, error: TRAVELLERS_INVALID };
  }

  const travelClass = cabinToTravelClass(q.cabin);
  if (travelClass === null) return { ok: false, error: CABIN_INVALID };

  const resolved: ResolvedFlightQuery = {
    originCode,
    destinationCode,
    type: roundTrip ? 1 : 2,
    travelClass,
    departDate: q.departDate,
    adults: q.adults,
    currency: FLIGHT_CURRENCY,
  };
  if (roundTrip) resolved.returnDate = q.returnDate;
  return { ok: true, resolved };
}

/**
 * The only provider params for a flight search (Req 1.1, 6.4). No `no_cache`
 * and no server-side filters (stops, airlines, price, times) are ever sent.
 */
export function flightParams(r: ResolvedFlightQuery): Record<string, string> {
  const p: Record<string, string> = {
    engine: "google_flights",
    departure_id: r.originCode,
    arrival_id: r.destinationCode,
    outbound_date: r.departDate,
  };
  if (r.type === 1 && r.returnDate) p.return_date = r.returnDate;
  p.type = String(r.type);
  p.travel_class = String(r.travelClass);
  p.adults = String(r.adults);
  p.currency = FLIGHT_CURRENCY;
  p.gl = "in";
  p.hl = "en";
  return p;
}

/**
 * Fare basis (decision A1): the provider `price` is the total for all adults;
 * the per-person fare is that total divided by the adult count, rounded.
 * This is the only place the basis is defined.
 */
export function fareFromProvider(price: number, adults: number): { perPerson: number; total: number } {
  return { perPerson: Math.round(price / adults), total: price };
}

/* ------------------------------------------------------------------------- *
 * Itinerary and insights normalisation (task 7.3)
 * normalizeItinerary, collectItineraries, normalizeInsights
 * ------------------------------------------------------------------------- */

/** Normalise one provider segment; a segment with no usable endpoints yields null. */
function normalizeSegment(raw: unknown): FlightSegment | null {
  const s = obj(raw);
  if (!s) return null;

  const dep = obj(s.departure_airport);
  const arr = obj(s.arrival_airport);
  const from = dep ? str(dep.id) : null;
  const departTime = dep ? str(dep.time) : null;
  const to = arr ? str(arr.id) : null;
  const arriveTime = arr ? str(arr.time) : null;

  // A segment must carry both endpoint ids and times to be part of a live offer.
  if (!from || !departTime || !to || !arriveTime) return null;

  return {
    from,
    fromName: dep ? str(dep.name) : null,
    departTime,
    to,
    toName: arr ? str(arr.name) : null,
    arriveTime,
    airline: str(s.airline),
    flightNumber: str(s.flight_number),
    durationMin: posNum(s.duration),
  };
}

/**
 * Normalise one itinerary into a `LiveFlight`, or return `null` when it cannot
 * be rendered honestly. An itinerary is kept only when it has:
 *  - a positive numeric price (Req 1.3),
 *  - at least one segment with departure/arrival ids and times,
 *  - a resolvable duration: `total_duration`, else the sum of every segment and
 *    layover duration when all of them are present (otherwise skip),
 *  - a valid token: `booking_token` when it matches `FLIGHT_TOKEN`, else
 *    `departure_token`; omitted when neither is valid (Req 1.2, 1.7, 20.4).
 * Airline names, flight numbers and logos are kept only when returned, and
 * logos only when `https:` (Req 1.4, 1.5, 21.1).
 */
export function normalizeItinerary(raw: unknown, adults: number): LiveFlight | null {
  const it = obj(raw);
  if (!it) return null;

  const price = posNum(it.price);
  if (price === null) return null;

  const rawSegments = Array.isArray(it.flights) ? it.flights : [];
  const segments: FlightSegment[] = [];
  for (const rs of rawSegments) {
    const seg = normalizeSegment(rs);
    if (seg) segments.push(seg);
  }
  if (segments.length === 0) return null;

  const first = segments[0];
  const last = segments[segments.length - 1];

  // Token: prefer a valid booking_token, else a valid departure_token.
  const bookingTokenRaw = str(it.booking_token);
  const departureTokenRaw = str(it.departure_token);
  let token: string | null = null;
  let tokenKind: "booking" | "departure" | null = null;
  if (bookingTokenRaw && FLIGHT_TOKEN.test(bookingTokenRaw)) {
    token = bookingTokenRaw;
    tokenKind = "booking";
  } else if (departureTokenRaw && FLIGHT_TOKEN.test(departureTokenRaw)) {
    token = departureTokenRaw;
    tokenKind = "departure";
  }
  if (!token || !tokenKind) return null;

  // Duration: total_duration, else the sum of every segment + layover duration
  // when all are present; otherwise the itinerary is skipped.
  const rawLayovers = Array.isArray(it.layovers) ? it.layovers : [];
  let durationMin = posNum(it.total_duration);
  if (durationMin === null) {
    let sum = 0;
    let allPresent = true;
    for (const seg of segments) {
      if (seg.durationMin === null) {
        allPresent = false;
        break;
      }
      sum += seg.durationMin;
    }
    if (allPresent) {
      for (const rl of rawLayovers) {
        const lo = obj(rl);
        const d = lo ? posNum(lo.duration) : null;
        if (d === null) {
          allPresent = false;
          break;
        }
        sum += d;
      }
    }
    if (!allPresent || sum <= 0) return null;
    durationMin = sum;
  }

  // Airlines: distinct, in segment order; only when returned.
  const airlines: string[] = [];
  const flightNumbers: string[] = [];
  for (const seg of segments) {
    if (seg.airline && !airlines.includes(seg.airline)) airlines.push(seg.airline);
    if (seg.flightNumber) flightNumbers.push(seg.flightNumber);
  }

  // Layover airport codes, only when the layover carries an id.
  const layoverAirports: string[] = [];
  for (const rl of rawLayovers) {
    const lo = obj(rl);
    const id = lo ? str(lo.id) : null;
    if (id) layoverAirports.push(id);
  }

  // Stops: layovers.length when the provider lists them, else segments.length - 1.
  const stops = rawLayovers.length > 0 ? rawLayovers.length : segments.length - 1;

  const fare = fareFromProvider(price, adults);

  return {
    token,
    tokenKind,
    airlines,
    airlineLogo: safeHttpsUrl(it.airline_logo),
    flightNumbers,
    segments,
    departAirport: first.from,
    departTime: first.departTime,
    arriveAirport: last.to,
    arriveTime: last.arriveTime,
    durationMin,
    stops,
    layoverAirports,
    farePerPerson: fare.perPerson,
    totalFare: fare.total,
    priceType: str(it.type),
  };
}

/**
 * Collect every renderable itinerary from `best_flights` then `other_flights`,
 * de-duplicating by token and capping at `MAX_FLIGHTS` (Req 1.2, 1.7). Pure.
 */
export function collectItineraries(data: Json, adults: number): LiveFlight[] {
  const out: LiveFlight[] = [];
  const seen = new Set<string>();
  const groups: unknown[] = [];
  if (Array.isArray(data.best_flights)) groups.push(...data.best_flights);
  if (Array.isArray(data.other_flights)) groups.push(...data.other_flights);

  for (const raw of groups) {
    if (out.length >= MAX_FLIGHTS) break;
    const flight = normalizeItinerary(raw, adults);
    if (!flight) continue;
    if (seen.has(flight.token)) continue;
    seen.add(flight.token);
    out.push(flight);
  }
  return out;
}

/**
 * Pass provider price insights through unchanged (Req 1.6). The typical range
 * is kept only when both bounds are finite numbers; otherwise it is `null`.
 * Returns `null` when the provider returned no insights object.
 */
export function normalizeInsights(raw: unknown): PriceInsights | null {
  const pi = obj(raw);
  if (!pi) return null;

  let typicalRange: [number, number] | null = null;
  const range = pi.typical_price_range;
  if (Array.isArray(range) && range.length >= 2) {
    const low = range[0];
    const high = range[1];
    if (typeof low === "number" && Number.isFinite(low) && typeof high === "number" && Number.isFinite(high)) {
      typicalRange = [low, high];
    }
  }

  return {
    lowestPrice: posNum(pi.lowest_price),
    priceLevel: str(pi.price_level),
    typicalRange,
  };
}

/* ------------------------------------------------------------------------- *
 * Booking options (task 7.5)
 * collectBookingOptions
 * ------------------------------------------------------------------------- */

/** At most this many form fields survive from one `post_data` body. */
const MAX_BOOKING_FIELDS = 20;
/** Each field value may be at most this many bytes (16 KB). */
const MAX_BOOKING_FIELD_BYTES = 16 * 1024;

const utf8ByteLength =
  typeof TextEncoder !== "undefined"
    ? (s: string): number => new TextEncoder().encode(s).length
    : (s: string): number => Buffer.byteLength(s, "utf8");

/**
 * Parse a provider `post_data` body into ordered `[name, value]` fields, or
 * return `null` when the option must be dropped. An option is dropped when the
 * body yields more than 20 fields or any single value exceeds 16 KB. An absent
 * or empty body yields an empty field list (a GET option).
 */
function parsePostData(raw: unknown): [string, string][] | null {
  const body = typeof raw === "string" ? raw : "";
  if (body.length === 0) return [];

  const params = new URLSearchParams(body);
  const fields: [string, string][] = [];
  for (const [name, value] of params) {
    if (utf8ByteLength(value) > MAX_BOOKING_FIELD_BYTES) return null;
    fields.push([name, value]);
    if (fields.length > MAX_BOOKING_FIELDS) return null;
  }
  return fields;
}

/** First https entry in the provider's airline logo list, else null. */
function firstHttpsLogo(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  for (const entry of raw) {
    const url = safeHttpsUrl(entry);
    if (url) return url;
  }
  return null;
}

/**
 * Collect every bookable "together" option from a booking lookup payload
 * (Req 1.5, 5.5, 5.7, 5.8, 20.5). An option is kept only when its
 * `booking_request.url` is https (`safeHttpsUrl`); otherwise it is dropped. The
 * POST body is parsed with `URLSearchParams` into at most 20 fields of at most
 * 16 KB each, and an option exceeding those bounds is dropped. `method` is
 * `POST` when the body carries fields, else `GET`. `separate_tickets` options
 * are ignored. Options are de-duplicated by `source + optionTitle` (first wins)
 * and sorted by price with nulls last; ties keep their original order. Pure.
 */
export function collectBookingOptions(data: Json): FlightBookingOption[] {
  const raw = Array.isArray(data.booking_options) ? data.booking_options : [];
  const out: FlightBookingOption[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    const option = obj(entry);
    if (!option) continue;

    const together = obj(option.together);
    if (!together) continue; // separate_tickets and anything else is ignored

    const request = obj(together.booking_request);
    const url = request ? safeHttpsUrl(request.url) : null;
    if (!url) continue; // non-https booking URL: option dropped (Req 5.8, 20.5)

    const fields = request ? parsePostData(request.post_data) : [];
    if (fields === null) continue; // over the field count / size bounds: dropped

    const source = str(together.book_with);
    if (!source) continue; // nothing to label the booking site with

    const optionTitle = str(together.option_title);
    const dedupeKey = `${source}\u0000${optionTitle ?? ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    out.push({
      source,
      logo: firstHttpsLogo(together.airline_logos),
      isAirline: together.airline === true,
      optionTitle,
      price: posNum(together.price),
      request: { url, method: fields.length > 0 ? "POST" : "GET", fields },
    });
  }

  // Sort by price with nulls last; stable so equal prices keep provider order.
  return out
    .map((o, i) => ({ o, i }))
    .sort((a, b) => {
      const pa = a.o.price;
      const pb = b.o.price;
      if (pa === null && pb === null) return a.i - b.i;
      if (pa === null) return 1;
      if (pb === null) return -1;
      if (pa !== pb) return pa - pb;
      return a.i - b.i;
    })
    .map((x) => x.o);
}

/* ------------------------------------------------------------------------- *
 * Search, returns and booking fetchers (task 7.7)
 * searchFlightFares, fetchReturnFlights, fetchFlightBookingOptions
 * ------------------------------------------------------------------------- */
const LOG_TAG = "serpapi-flights";

const UNCONFIGURED = "Live flight prices are not connected yet.";
const UNAVAILABLE = "Live flight prices are temporarily unavailable. Please try again shortly.";

/** Keep the paused message visible; any other failure gets the flight wording. */
function failureMessage(message: string): string {
  return message === PAUSED_MESSAGE ? PAUSED_MESSAGE : UNAVAILABLE;
}

/**
 * Live flight fares for a route and dates (Req 1.1, 1.8, 1.9, 1.10, 6.4, 7.1,
 * 8.1, 8.4, 8.5, 20.1, 20.3). Order mirrors the hotels adapter: `unconfigured`
 * (no key, no request) → `invalid` (validation failure, no request) →
 * `cachedProviderCall`. The build receives the parsed payload and the request's
 * completion time, and the result carries that time as `checkedAt`. Never throws.
 */
export async function searchFlightFares(
  q: FlightFareQuery,
  opts: AdapterOptions = {},
): Promise<FlightFaresResult> {
  const now = opts.now ?? new Date();
  const currency = FLIGHT_CURRENCY;
  const base = {
    provider: LIVE_FLIGHTS_PROVIDER,
    currency,
    checkedAt: now.toISOString(),
    route: { origin: null as string | null, destination: null as string | null },
    flights: [] as LiveFlight[],
    insights: null as PriceInsights | null,
  };

  if (!serpApiKey()) return { ...base, status: "unconfigured", error: UNCONFIGURED };

  const check = validateFlightQuery(q, now);
  if (!check.ok) return { ...base, status: "invalid", error: check.error };

  const resolved = check.resolved;
  const route = { origin: resolved.originCode, destination: resolved.destinationCode };
  const live = { ...base, currency: resolved.currency, route };
  const params = flightParams(resolved);

  return cachedProviderCall<FlightFaresResult>({
    key: cacheKey("flights:search", params),
    kind: "search",
    params,
    now,
    fetchImpl: opts.fetchImpl,
    logTag: LOG_TAG,
    build: (data, completedAt) => ({
      ...live,
      checkedAt: completedAt.toISOString(),
      status: "live",
      flights: collectItineraries(data, resolved.adults),
      insights: normalizeInsights(data.price_insights),
    }),
    unavailable: (message) => ({ ...live, status: "unavailable", error: failureMessage(message) }),
  });
}

/**
 * Matching return legs for a round-trip outbound offer (Req 5.3, 20.4). The
 * provider query is the same resolved search plus `departure_token`; a
 * `booking_token` is never sent. The token is checked against `FLIGHT_TOKEN`
 * before any request. The result has the same shape as `searchFlightFares`;
 * `flights` are the return legs. Never throws.
 */
export async function fetchReturnFlights(
  q: FlightFareQuery & { departureToken: string },
  opts: AdapterOptions = {},
): Promise<FlightFaresResult> {
  const now = opts.now ?? new Date();
  const currency = FLIGHT_CURRENCY;
  const base = {
    provider: LIVE_FLIGHTS_PROVIDER,
    currency,
    checkedAt: now.toISOString(),
    route: { origin: null as string | null, destination: null as string | null },
    flights: [] as LiveFlight[],
    insights: null as PriceInsights | null,
  };

  if (!serpApiKey()) return { ...base, status: "unconfigured", error: UNCONFIGURED };

  if (!q.departureToken || !FLIGHT_TOKEN.test(q.departureToken)) {
    return { ...base, status: "invalid", error: "Unknown flight." };
  }

  const check = validateFlightQuery(q, now);
  if (!check.ok) return { ...base, status: "invalid", error: check.error };

  const resolved = check.resolved;
  const route = { origin: resolved.originCode, destination: resolved.destinationCode };
  const live = { ...base, currency: resolved.currency, route };
  const params = { ...flightParams(resolved), departure_token: q.departureToken };

  return cachedProviderCall<FlightFaresResult>({
    key: cacheKey("flights:returns", params),
    kind: "detail",
    params,
    now,
    fetchImpl: opts.fetchImpl,
    logTag: LOG_TAG,
    timeoutMs: PROVIDER_DETAIL_TIMEOUT_MS,
    build: (data, completedAt) => ({
      ...live,
      checkedAt: completedAt.toISOString(),
      status: "live",
      flights: collectItineraries(data, resolved.adults),
      insights: normalizeInsights(data.price_insights),
    }),
    unavailable: (message) => ({ ...live, status: "unavailable", error: failureMessage(message) }),
  });
}

/**
 * Per-site booking options for a selected itinerary (Req 5.2, 5.4, 20.4, 20.5).
 * The provider query is the same resolved search plus `booking_token`; a
 * `departure_token` is never sent. The token is checked against `FLIGHT_TOKEN`
 * before any request. Build collects https-only options via
 * `collectBookingOptions`. Never throws.
 */
export async function fetchFlightBookingOptions(
  q: FlightFareQuery & { bookingToken: string },
  opts: AdapterOptions = {},
): Promise<FlightBookingResult> {
  const now = opts.now ?? new Date();
  const currency = FLIGHT_CURRENCY;
  const base = {
    provider: LIVE_FLIGHTS_PROVIDER,
    currency,
    checkedAt: now.toISOString(),
    options: [] as FlightBookingOption[],
  };

  if (!serpApiKey()) return { ...base, status: "unconfigured", error: UNCONFIGURED };

  if (!q.bookingToken || !FLIGHT_TOKEN.test(q.bookingToken)) {
    return { ...base, status: "invalid", error: "Unknown flight." };
  }

  const check = validateFlightQuery(q, now);
  if (!check.ok) return { ...base, status: "invalid", error: check.error };

  const resolved = check.resolved;
  const live = { ...base, currency: resolved.currency };
  const params = { ...flightParams(resolved), booking_token: q.bookingToken };

  return cachedProviderCall<FlightBookingResult>({
    key: cacheKey("flights:booking", params),
    kind: "detail",
    params,
    now,
    fetchImpl: opts.fetchImpl,
    logTag: LOG_TAG,
    timeoutMs: PROVIDER_DETAIL_TIMEOUT_MS,
    build: (data, completedAt) => ({
      ...live,
      checkedAt: completedAt.toISOString(),
      status: "live",
      options: collectBookingOptions(data),
    }),
    unavailable: (message) => ({ ...live, status: "unavailable", error: failureMessage(message) }),
  });
}
