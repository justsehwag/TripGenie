/**
 * SerpApi Google Hotels adapter (server-only, read-only).
 *
 * Fetches LIVE hotel prices for exact dates and guest counts from Google Hotels
 * via SerpApi, plus the per-site booking offers (Booking.com, Agoda, Expedia,
 * the hotel's own site, ...) with links that send the traveller straight to
 * that site to pay. TripGenie never takes payment.
 *
 * Honesty rules enforced here:
 *  - Only prices the provider actually reported are returned; a property with
 *    no reported price is skipped (never estimated or invented).
 *  - Every result carries `checkedAt` (the time the provider request completed),
 *    so the UI can say when it was checked.
 *  - Only https links are passed through; anything else is dropped.
 *
 * Transport, cache, in-flight de-duplication and the monthly usage guard live
 * in `serpapi-core.ts`. Search results are cached as `search` (45 min) and
 * booking offers as `detail` (15 min). Star-class filtering is done locally on
 * the full result set, so no `hotel_class` parameter is ever sent: one upstream
 * call serves every view of the same search.
 *
 * SERVER-ONLY: reads the secret via `serpApiKey()`. SerpApi takes the key as a
 * query parameter, so the request URL is never logged or returned. On any
 * failure the adapter returns a labelled status instead of throwing.
 *
 * Requirements: 6.2, 6.3, 6.5, 6.6, 7.1, 7.2, 8.1, 8.4, 8.5, 20.1, 20.3, 21.1, 21.2, 22.5.
 */

import { serpApiKey } from "@/lib/config";
import {
  PAUSED_MESSAGE,
  cachedProviderCall,
  cacheKey,
  normalizeDestination,
  obj,
  posNum,
  providerStore,
  safeHttpsUrl,
  str,
  type AdapterOptions,
  type Json,
} from "@/lib/providers/serpapi-core";

export { SERPAPI_ENDPOINT, safeHttpsUrl, type AdapterOptions } from "@/lib/providers/serpapi-core";
export { TTL_MS } from "@/lib/providers/provider-store";

export const LIVE_HOTELS_PROVIDER = "Google Hotels via SerpApi" as const;

const LOG_TAG = "serpapi-hotels";
const MAX_HOTELS = 30;
const MAX_ADULTS = 10;
const MAX_AMENITIES_SHOWN = 6;

export interface HotelRateQuery {
  destination: string;
  /** ISO date YYYY-MM-DD. */
  checkIn: string;
  /** ISO date YYYY-MM-DD, strictly after checkIn. */
  checkOut: string;
  adults: number;
  /** ISO 4217 currency; defaults to INR. */
  currency?: string;
}

export interface LiveHotel {
  /** Google property token; used to fetch per-site booking offers. */
  token: string;
  name: string;
  description: string | null;
  thumbnail: string | null;
  hotelClass: number | null;
  rating: number | null;
  reviews: number | null;
  /** Lowest nightly rate reported, including taxes and fees when available. */
  ratePerNight: number;
  ratePerNightBeforeTaxes: number | null;
  /** Lowest total for the whole stay, when reported. */
  totalRate: number | null;
  /** The hotel's own website, when reported. */
  website: string | null;
  /** Up to 6 amenities, for display. */
  amenities: string[];
  /** Google's location score (0-5), when reported. */
  locationRating: number | null;
  /** Name of the first nearby place, when reported; shown as text only. */
  nearbyPlace: string | null;
  /** Only set when the provider reports a boolean; never inferred. */
  freeCancellation: boolean | null;
  /** Total number of amenities reported (not capped), used for scoring. */
  amenityCount: number;
}

export interface HotelBookingOffer {
  source: string;
  logo: string | null;
  /** True when the offer is the hotel's own official site. */
  official: boolean;
  /** https link that takes the traveller to the site to book and pay. */
  link: string;
  ratePerNight: number | null;
  totalRate: number | null;
  freeCancellation: boolean;
}

export type LiveStatus = "live" | "unconfigured" | "invalid" | "unavailable";

export interface HotelRatesResult {
  status: LiveStatus;
  provider: typeof LIVE_HOTELS_PROVIDER;
  currency: string;
  checkedAt: string;
  hotels: LiveHotel[];
  error?: string;
}

export interface HotelOffersResult {
  status: LiveStatus;
  provider: typeof LIVE_HOTELS_PROVIDER;
  currency: string;
  checkedAt: string;
  hotelName: string | null;
  offers: HotelBookingOffer[];
  error?: string;
}

/* ------------------------------------------------------------------------- *
 * Validation
 * ------------------------------------------------------------------------- */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN = /^[A-Za-z0-9_-]{4,300}$/;
const CURRENCY = /^[A-Z]{3}$/;

function isRealDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Returns a user-facing problem with the query, or null when it is valid. "Today" is UTC. */
export function validateHotelQuery(q: HotelRateQuery, now: Date = new Date()): string | null {
  if (!q.destination || q.destination.trim().length < 2) return "Add a destination to see live prices.";
  if (!q.checkIn || !q.checkOut) return "Add check-in and check-out dates to see live prices.";
  if (!isRealDate(q.checkIn) || !isRealDate(q.checkOut)) return "Check-in and check-out must be valid dates.";
  if (q.checkOut <= q.checkIn) return "Check-out must be after check-in.";
  const today = now.toISOString().slice(0, 10);
  if (q.checkIn < today) return "Check-in can't be in the past.";
  if (!Number.isInteger(q.adults) || q.adults < 1 || q.adults > MAX_ADULTS)
    return `Guests must be between 1 and ${MAX_ADULTS}.`;
  if (q.currency !== undefined && !CURRENCY.test(q.currency)) return "Invalid currency.";
  return null;
}

/* ------------------------------------------------------------------------- *
 * Normalisation helpers (pure)
 * ------------------------------------------------------------------------- */

/** Rate including taxes/fees when reported, else the provider's lowest rate. */
function rateIncl(v: unknown): number | null {
  const r = obj(v);
  if (!r) return null;
  return posNum(r.extracted_after_taxes_fees) ?? posNum(r.extracted_lowest) ?? posNum(r.extracted_display_price);
}

function rateExcl(v: unknown): number | null {
  const r = obj(v);
  return r ? posNum(r.extracted_before_taxes_fees) : null;
}

/** Map one Google Hotels `properties[]` entry; null when it has no real price. */
export function normalizeHotel(raw: unknown): LiveHotel | null {
  const p = obj(raw);
  if (!p) return null;
  const token = str(p.property_token);
  const name = str(p.name);
  const ratePerNight = rateIncl(p.rate_per_night);
  if (!token || !TOKEN.test(token) || !name || ratePerNight === null) return null;
  const images = Array.isArray(p.images) ? p.images : [];
  const firstImage = obj(images[0]);
  const allAmenities = Array.isArray(p.amenities)
    ? p.amenities.filter((a): a is string => typeof a === "string" && a.trim().length > 0)
    : [];
  const nearby = Array.isArray(p.nearby_places) ? obj(p.nearby_places[0]) : null;
  return {
    token,
    name,
    description: str(p.description),
    thumbnail: safeHttpsUrl(firstImage?.thumbnail) ?? safeHttpsUrl(p.thumbnail),
    hotelClass: posNum(p.extracted_hotel_class) ?? posNum(p.hotel_class),
    rating: posNum(p.overall_rating),
    reviews: posNum(p.reviews),
    ratePerNight,
    ratePerNightBeforeTaxes: rateExcl(p.rate_per_night),
    totalRate: rateIncl(p.total_rate),
    website: safeHttpsUrl(p.link),
    amenities: allAmenities.slice(0, MAX_AMENITIES_SHOWN),
    locationRating: posNum(p.location_rating),
    nearbyPlace: str(nearby?.name),
    freeCancellation: typeof p.free_cancellation === "boolean" ? p.free_cancellation : null,
    amenityCount: allAmenities.length,
  };
}

/** Map one `featured_prices[]` / `prices[]` entry; null without a source or safe link. */
export function normalizeOffer(raw: unknown): HotelBookingOffer | null {
  const o = obj(raw);
  if (!o) return null;
  const source = str(o.source);
  const link = safeHttpsUrl(o.link);
  if (!source || !link) return null;
  return {
    source,
    logo: safeHttpsUrl(o.logo),
    official: o.official === true,
    link,
    ratePerNight: rateIncl(o.rate_per_night),
    totalRate: rateIncl(o.total_rate),
    freeCancellation: o.free_cancellation === true,
  };
}

/** Featured offers first, then the rest; one row per site; cheapest first. */
export function collectOffers(data: Json): HotelBookingOffer[] {
  const raw = [
    ...(Array.isArray(data.featured_prices) ? data.featured_prices : []),
    ...(Array.isArray(data.prices) ? data.prices : []),
  ];
  const seen = new Set<string>();
  const out: HotelBookingOffer[] = [];
  for (const r of raw) {
    const offer = normalizeOffer(r);
    if (!offer) continue;
    const key = offer.source.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(offer);
  }
  return out.sort((a, b) => {
    if (a.ratePerNight === null && b.ratePerNight === null) return 0;
    if (a.ratePerNight === null) return 1;
    if (b.ratePerNight === null) return -1;
    return a.ratePerNight - b.ratePerNight;
  });
}

/* ------------------------------------------------------------------------- *
 * Request params + cache
 * ------------------------------------------------------------------------- */

/** Test hook: clears the shared provider cache, in-flight registry and usage counter. */
export function clearHotelRateCache(): void {
  providerStore.clear();
}

const UNCONFIGURED = "Live hotel prices are not connected yet.";
const UNAVAILABLE = "Live hotel prices are temporarily unavailable. Please try again shortly.";

/** Keep the paused message visible; any other failure gets the hotel wording. */
function failureMessage(message: string): string {
  return message === PAUSED_MESSAGE ? PAUSED_MESSAGE : UNAVAILABLE;
}

/** Params come only from destination, dates, adults and currency (Req 6.2, 6.3, 6.6). */
function baseParams(q: HotelRateQuery, currency: string): Record<string, string> {
  return {
    engine: "google_hotels",
    q: `${normalizeDestination(q.destination)} hotels`,
    check_in_date: q.checkIn,
    check_out_date: q.checkOut,
    adults: String(q.adults),
    currency,
    gl: "in",
    hl: "en",
  };
}

/* ------------------------------------------------------------------------- *
 * Public API
 * ------------------------------------------------------------------------- */

/** Live hotel list with real prices for the given dates and guests. Never throws. */
export async function searchHotelRates(
  q: HotelRateQuery,
  opts: AdapterOptions = {},
): Promise<HotelRatesResult> {
  const now = opts.now ?? new Date();
  const currency = q.currency ?? "INR";
  const base = { provider: LIVE_HOTELS_PROVIDER, currency, checkedAt: now.toISOString(), hotels: [] as LiveHotel[] };

  if (!serpApiKey()) return { ...base, status: "unconfigured", error: UNCONFIGURED };

  const problem = validateHotelQuery(q, now);
  if (problem) return { ...base, status: "invalid", error: problem };

  const params = baseParams(q, currency);
  return cachedProviderCall<HotelRatesResult>({
    key: cacheKey("hotels:search", params),
    kind: "search",
    params,
    now,
    fetchImpl: opts.fetchImpl,
    logTag: LOG_TAG,
    build: (data, completedAt) => {
      const properties = Array.isArray(data.properties) ? data.properties : [];
      const hotels: LiveHotel[] = [];
      const seen = new Set<string>();
      for (const raw of properties) {
        const h = normalizeHotel(raw);
        if (!h || seen.has(h.token)) continue;
        seen.add(h.token);
        hotels.push(h);
        if (hotels.length >= MAX_HOTELS) break;
      }
      return { ...base, checkedAt: completedAt.toISOString(), status: "live", hotels };
    },
    unavailable: (message) => ({ ...base, status: "unavailable", error: failureMessage(message) }),
  });
}

/** Per-site booking offers for one hotel (property token). Never throws. */
export async function fetchHotelOffers(
  q: HotelRateQuery & { token: string },
  opts: AdapterOptions = {},
): Promise<HotelOffersResult> {
  const now = opts.now ?? new Date();
  const currency = q.currency ?? "INR";
  const base = {
    provider: LIVE_HOTELS_PROVIDER,
    currency,
    checkedAt: now.toISOString(),
    hotelName: null as string | null,
    offers: [] as HotelBookingOffer[],
  };

  if (!serpApiKey()) return { ...base, status: "unconfigured", error: UNCONFIGURED };

  if (!q.token || !TOKEN.test(q.token)) return { ...base, status: "invalid", error: "Unknown hotel." };
  const problem = validateHotelQuery(q, now);
  if (problem) return { ...base, status: "invalid", error: problem };

  const params = { ...baseParams(q, currency), property_token: q.token };
  return cachedProviderCall<HotelOffersResult>({
    key: cacheKey("hotels:offers", params),
    kind: "detail",
    params,
    now,
    fetchImpl: opts.fetchImpl,
    logTag: LOG_TAG,
    build: (data, completedAt) => ({
      ...base,
      checkedAt: completedAt.toISOString(),
      status: "live",
      hotelName: str(data.name),
      offers: collectOffers(data),
    }),
    unavailable: (message) => ({ ...base, status: "unavailable", error: failureMessage(message) }),
  });
}
