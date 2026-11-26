/**
 * TripGenie shared domain types.
 *
 * These are the pure, framework-free contracts shared across the domain core
 * (parsers, resolvers, pricing, promotions, itinerary, retention) and the AWS
 * edges that wrap it. Field shapes are taken verbatim from the design document's
 * "Components and Interfaces" and "Data Models" sections.
 *
 * Requirements: 19.1 (serverless-first, pure core / swappable edges).
 */

import type { CostClass } from "./cost-caps";

/* ---------------------------------------------------------------------------
 * Provenance (design: Payload_Provenance) — exactly one value per payload.
 * `estimated` implies no payment taken and no valid ticket/room issued.
 * ------------------------------------------------------------------------- */
export type Provenance = "live" | "estimated" | "cached" | "demo";

/* ---------------------------------------------------------------------------
 * Trip_Context — canonical structured record (design: Data Models /
 * Preference Controller). Reused from TripSaathi `lib/travel-engine.ts`.
 * ------------------------------------------------------------------------- */
export interface TripContext {
  origin?: string;
  destination?: string;
  durationDays?: number;
  travellers?: { adults: number; children: number };
  budgetLevel?: string;
  diet?: string;
  pace?: string;
  interests?: string[];
  /** Persisted when a flight offer is selected (Req 8.4). */
  selectedFlight?: {
    flightNo: string;
    date: string;
    depart: string;
    arrive: string;
  };
}

/* ---------------------------------------------------------------------------
 * Offer contract (design: Search & Inventory Adapter, Offer Contract).
 * Every offer carries provider, mode (provenance), retrievedAt, expiresAt,
 * disclaimer, and a reviewSummary rendered only when attributable.
 * ------------------------------------------------------------------------- */
export interface OfferMeta {
  /** Provider identifier (Req 4.5). */
  provider: string;
  /** Retrieval mode / provenance (Req 4.5, 4.10). */
  mode: Provenance;
  /** Retrieval timestamp, ISO-8601 (Req 4.5, 4.6). */
  retrievedAt: string;
  /** Expiry timestamp, ISO-8601; retrievedAt <= expiresAt (Req 4.5, 4.6). */
  expiresAt: string;
  /** Disclaimer; for `estimated`, states no payment/ticket/room (Req 4.11). */
  disclaimer: string;
  /**
   * Attributable upstream review data. Rendered if and only if present
   * (Req 4.12/4.13); omitted when no attributable review data exists.
   */
  reviewSummary?: {
    rating: number;
    count: number;
    source: string;
  };
}

export interface FlightOffer {
  id: string;
  meta: OfferMeta;
  origin: string;
  destination: string;
  cabin: string;
  stops: number;
  flightNo: string;
  date: string;
  depart: string;
  arrive: string;
  /** Per-person fare (Req 8.3). */
  farePerPerson: number;
}

export interface StayOffer {
  id: string;
  meta: OfferMeta;
  destination: string;
  stayStyle: string;
  nights: number;
  /** Representative photo unless an authorized provider returns an exact image (Req 11.2). */
  representative: boolean;
  pricePerNight: number;
}

export interface PlaceOffer {
  id: string;
  meta: OfferMeta;
  name: string;
  /** Metropolitan area the place belongs to; constrained to the destination (Req 4.4). */
  metroArea: string;
  category: string;
}

/* ---------------------------------------------------------------------------
 * CarOffer (design: Booking Site / New Data Model: CarOffer). Same OfferMeta
 * provenance discipline as FlightOffer/StayOffer: exactly one Provenance, and
 * when uncredentialed `estimated` with the no-payment/rental disclaimer
 * (Req 25.7, 25.8, 25.11, 4.5, 4.6, 4.10, 4.11).
 * ------------------------------------------------------------------------- */
export interface CarOffer {
  id: string;
  meta: OfferMeta;
  pickupLocation: string;
  /** Equals pickupLocation unless a different drop-off was requested (Req 25.2). */
  dropoffLocation: string;
  /** Rental category, e.g. Economy, SUV, Luxury. */
  carClass: string;
  transmission: "automatic" | "manual";
  seats: number;
  /** Rental length in days, derived from pickup/return. */
  days: number;
  /** Estimated per-day price, deterministically calibrated (Req 25.11). */
  pricePerDay: number;
}

/* ---------------------------------------------------------------------------
 * Pricing object (design: Pricing Engine). Reused verbatim from TripSaathi
 * `lib/promotions.ts` `TripPricing`. Single source across wallet/itinerary/PDF.
 * ------------------------------------------------------------------------- */
export interface TripPricing {
  flight: number;
  stay: number;
  activities: number;
  gross: number;
  discount: number;
  coupon: string;
  finalPayable: number;
  error: string;
}

/* ---------------------------------------------------------------------------
 * Promotions (design: Promotions Engine). Computed separately from base fares.
 * ------------------------------------------------------------------------- */
export interface Promotion {
  code: string;
  kind: "coupon" | "loyalty" | "bounty" | "delight";
  discount: number;
  minSpend: number;
}

/* ---------------------------------------------------------------------------
 * Itinerary (design: Itinerary Generation & Revision).
 * ------------------------------------------------------------------------- */
export type ActivityCategory = "transfer" | "sight" | "meal" | "leisure";

export type HoursLabel = "Typical hours" | "Hours not listed";

/** One enrichment value: a verbatim snippet excerpt with its source. */
export interface WebDetail {
  /** At most 240 characters, verbatim from a retrieved snippet. */
  text: string;
  /** Absolute https URL. */
  sourceUrl: string;
  /** Equals new URL(sourceUrl).hostname. */
  sourceHost: string;
  /** ISO date accepted by Date.parse. */
  checkedAt: string;
}

export interface WebDetails {
  /** true when SearXNG answered for this Stop (even with nothing found); false = never checked. */
  checked: boolean;
  tip?: WebDetail;
  booking?: WebDetail;
  bestTime?: WebDetail;
  /** Which price kind the top-level price is: entry or ticket price (sights) or typical cost (meals). */
  priceKind?: "entry" | "typical";
  /** true when the price lookup was unavailable (SearXNG down), so the Stop was not checked. */
  unavailable?: true;
}

export interface Activity {
  time: string;
  title: string;
  description: string;
  cost: number;
  /** Cost category for honest, destination-aware estimates (optional). */
  category?: ActivityCategory;
  /** Where the INR price came from: model-priced or category estimate (optional). */
  priceSource?: "ai" | "estimated" | "web";
  /** Short explanation of how the price was derived, up to 120 chars (optional). */
  priceBasis?: string;
  /** Web price evidence; present only with priceSource "web" (optional). */
  sourceUrl?: string;
  sourceHost?: string;
  checkedAt?: string;
  /** Whether `cost` is per person or per vehicle/group (optional). */
  costBasis?: "person" | "group";
  /** Cost class used for caps and pricing (optional). */
  costClass?: CostClass;
  /** Short note shown instead of a price for included/optional rows (optional). */
  costNote?: string;
  /** Set only when kept although Places could not resolve it (grounding, optional). */
  mapVerified?: false;
  /** Google Places id; present only when resolved by a real Places lookup (optional). */
  placeId?: string;
  /** Display name returned by Places for the matched place (optional). */
  placeName?: string;
  /** True only for a stop confirmed by a Places result (optional). */
  verified?: true;
  /** Google Maps link built from the real placeId and name (optional). */
  mapsUrl?: string;
  /** Neighbourhood or area label (optional). */
  area?: string;
  /** Coordinates from the Places result (optional). */
  location?: { lat: number; lng: number };
  /** Places photo resource name, "places/<id>/photos/<id>" (optional). */
  photoRef?: string;
  /** Estimated road minutes to the next stop of the same day (optional). */
  travelToNextMin?: number;
  /** Scheduled visit length in minutes, integer 1-1440 (optional). */
  visitMin?: number;
  /** Google's weekday description for the scheduled weekday, verbatim (optional). */
  openingHours?: string;
  /** "Typical hours" when the trip has no start date, "Hours not listed" when Google returned none (optional). */
  hoursLabel?: HoursLabel;
  /** Places photo resource names for this Stop, at most 3; photoRef equals photos[0] (optional). */
  photos?: string[];
  /** Web details; present on every Stop built by the places-first flow (optional). */
  webDetails?: WebDetails;
  /** Google price data, AI estimate or unverified web price when no verified web price exists (optional). */
  priceFallback?: PriceFallback;
}

export type GooglePriceLevel = 0 | 1 | 2 | 3 | 4;

export interface PriceFallback {
  google?: {
    level?: GooglePriceLevel;
    range?: { lowInr: number; highInr: number };
    checkedAt: string; // ISO
  };
  ai?: { lowInr: number; highInr: number; basis: string; checkedAt: string };
  /** A cited web price that failed the cross-check. Never copied into cost or priceSource. */
  unverifiedWeb?: { inr: number; sourceUrl: string; sourceHost: string; checkedAt: string; reasons: string[] };
}

export interface TripDay {
  day: number;
  date: string;
  title: string;
  theme: string;
  activities: Activity[];
  total: number;
  /** True when this day is a day trip beyond the destination radius (optional). */
  dayTrip?: true;
}

/** How many requested days are verified, withheld or still pending (optional on Itinerary). */
export interface ItineraryCompleteness {
  requestedDays: number;
  verifiedDays: number[];
  withheldDays: number[];
  pendingDays?: number[];
}

/** A web source shown to the traveller under the itinerary (title, https URL, host). */
export interface SourceLink {
  title: string;
  url: string;
  host: string;
}

/** Informational bus/train fare range for no-airport routes; never added to totals. */
export interface RouteFareRange {
  mode: "bus" | "train";
  minInr: number;
  maxInr: number;
  sourceUrl: string;
  sourceHost: string;
  checkedAt: string;
}

export interface Itinerary {
  title: string;
  totalCost: number;
  days: TripDay[];
  revised?: boolean;
  /** ISO 4217 code the costs are expressed in after conversion (optional). */
  currency?: string;
  /** True when costs are estimates rather than booked amounts (optional). */
  estimated?: boolean;
  /** When "inr", every cost, day total and totalCost is already in INR (optional). */
  costUnit?: "inr";
  /** Present only when web grounding contributed sources (optional). */
  sources?: SourceLink[];
  /** Verified informational route fare for no-airport trips (optional). */
  routeFare?: RouteFareRange;
  /** Which requested days are verified, withheld or pending (optional). */
  completeness?: ItineraryCompleteness;
}

/* ---------------------------------------------------------------------------
 * Traveler Profile (design: Traveler Profile / Data Models: Profiles table).
 * Version-based compare-and-swap preserved.
 * ------------------------------------------------------------------------- */
export interface TravelerProfile {
  userId: string;
  displayName: string;
  homeCity: string;
  travelStyle: string;
  locale: string;
  /** Party composition (Req 7.1). */
  party: { adults: number; children: number };
  /** Compare-and-swap token (Req 7.4/7.5). */
  version: number;
}

/* ---------------------------------------------------------------------------
 * Route Intake (design: Route Intake). Parsed values separated from
 * confirmation state.
 * ------------------------------------------------------------------------- */
export interface RouteState {
  /** "" at session start (Req 5.1). */
  origin: string;
  destination: string;
  /** Bare place held until assigned to a side (Req 5.8/5.9). */
  routeCandidate: string;
  originConfirmed: boolean;
  destinationConfirmed: boolean;
}

/* ---------------------------------------------------------------------------
 * Date & Duration Intake (design: Date & Duration Intake).
 * ------------------------------------------------------------------------- */
export interface DateState {
  mode: "flexible" | "fixed";
  startDate?: string;
  endDate?: string;
  tripDays: number;
}
