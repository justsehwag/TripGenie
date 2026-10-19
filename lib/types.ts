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
export interface Activity {
  time: string;
  title: string;
  description: string;
  cost: number;
}

export interface TripDay {
  day: number;
  date: string;
  title: string;
  theme: string;
  activities: Activity[];
  total: number;
}

export interface Itinerary {
  title: string;
  totalCost: number;
  days: TripDay[];
  revised?: boolean;
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
