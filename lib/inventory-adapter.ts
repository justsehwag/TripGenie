import type { CarOffer, FlightOffer, OfferMeta, PlaceOffer, Provenance, StayOffer } from "./types";

/**
 * Inventory Adapter (pure core + estimator) - design section 5.
 * Ported from TripSaathi lib/marketplace.ts (createPreviewInventory).
 * Requirements: 4.5-4.13.
 */

/**
 * Attributable upstream review data. Present only when a credentialed provider
 * supplies verifiable review data; rendered if and only if attributable
 * (Req 4.12/4.13, Property 23).
 */
export interface AttributableReview {
  rating: number;
  count: number;
  source: string;
}

export interface InventoryQuery {
  origin: string;
  destination: string;
  cabin: string;
  stayStyle: string;
  nights: number;
  credentialed?: boolean;
  /** Car pickup location; defaults to the destination when omitted (Req 25.2). */
  pickupLocation?: string;
  /** Car drop-off location; equals pickupLocation unless a different one is requested (Req 25.2). */
  dropoffLocation?: string;
  /** Requested rental category, e.g. Economy, SUV, Luxury. */
  carClass?: string;
  /** Rental length in days, derived from pickup/return. */
  rentalDays?: number;
  /**
   * Attributable review data supplied by an authorized provider. Omitted in the
   * estimator path (no connected review provider), so review content is never
   * fabricated for estimated offers.
   */
  review?: AttributableReview;
}

function hash(value: string): number {
  return [...value].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) >>> 0, 17);
}

/** A review is attributable only if it carries a real source and a non-negative count. */
function attributable(review?: AttributableReview): boolean {
  return Boolean(review && review.source.trim().length > 0 && review.count > 0);
}

function meta(q: InventoryQuery, now: Date): OfferMeta {
  const credentialed = Boolean(q.credentialed);
  const mode: Provenance = credentialed ? "live" : "estimated";
  const m: OfferMeta = {
    provider: credentialed ? "contracted-gds" : "tripgenie-estimator",
    mode,
    retrievedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
    disclaimer: credentialed
      ? "Live provider quote."
      : "Estimated: no payment is taken and no valid ticket or room is issued.",
  };
  // Render review content iff attributable provider review data exists (Req 4.12/4.13).
  if (attributable(q.review)) {
    const r = q.review!;
    m.reviewSummary = { rating: r.rating, count: r.count, source: r.source };
  }
  return m;
}

const routeFare: Record<string, number> = {
  Dubai: 10900, Singapore: 14900, London: 29500, Goa: 4200, Bali: 18800, Paris: 30500, Tokyo: 32800,
};

const stayMult: Record<string, number> = {
  Dubai: 1.12, Singapore: 1.18, London: 1.35, Goa: 0.78, Bali: 0.72, Paris: 1.25, Tokyo: 1.16,
};

/** Per-location rental multiplier, mirroring the stay calibration (Req 25.11). */
const carMult: Record<string, number> = {
  Dubai: 1.08, Singapore: 1.22, London: 1.40, Goa: 0.70, Bali: 0.65, Paris: 1.30, Tokyo: 1.20,
};

/** Per-class daily base, seat count, and transmission (deterministic, no brand). */
const carClassBase: Record<string, { daily: number; seats: number; transmission: "automatic" | "manual" }> = {
  Economy: { daily: 2600, seats: 5, transmission: "manual" },
  Compact: { daily: 3100, seats: 5, transmission: "manual" },
  SUV: { daily: 5200, seats: 7, transmission: "automatic" },
  Luxury: { daily: 9800, seats: 5, transmission: "automatic" },
};

export function buildFlightOffers(q: InventoryQuery, n = 6, now = new Date()): FlightOffer[] {
  const seed = hash(`${q.origin}-${q.destination}-${q.cabin}`);
  const m = meta(q, now);
  const base = routeFare[q.destination] ?? 13800;
  const cabinMult = q.cabin === "Business" ? 2.55 : q.cabin === "Premium Economy" ? 1.42 : 1;
  return Array.from({ length: n }, (_, i) => {
    const stops = i > 2 ? 1 : 0;
    const stopMult = i > 2 ? 0.88 + (i - 3) * 0.06 : 1 + i * 0.08;
    const fare = Math.round((base * cabinMult * stopMult + (seed % 700)) / 100) * 100;
    return {
      id: `FL-${seed}-${i + 1}`,
      meta: m,
      origin: q.origin,
      destination: q.destination,
      cabin: q.cabin,
      stops,
      flightNo: `TG ${500 + (seed % 300) + i}`,
      date: now.toISOString().slice(0, 10),
      depart: ["06:15", "09:40", "12:10", "14:25", "18:35", "22:05"][i % 6],
      arrive: "15:30",
      farePerPerson: fare,
    };
  });
}

export function buildStayOffers(q: InventoryQuery, n = 6, now = new Date()): StayOffer[] {
  const seed = hash(`${q.destination}-${q.stayStyle}`);
  const m = meta(q, now);
  const baseNightly = (q.stayStyle === "Luxury" ? 9800 : q.stayStyle === "Budget" ? 2600 : 4800) * (stayMult[q.destination] ?? 0.95);
  return Array.from({ length: n }, (_, i) => {
    const nightly = Math.round((baseNightly * (1 + i * 0.11) + (seed % 500)) / 100) * 100;
    return {
      id: `HT-${seed}-${i + 1}`,
      meta: m,
      destination: q.destination,
      stayStyle: q.stayStyle,
      nights: Math.max(1, Math.trunc(q.nights)),
      representative: !q.credentialed,
      pricePerNight: nightly,
    };
  });
}

export function buildPlaceOffers(q: InventoryQuery, n = 6, now = new Date()): PlaceOffer[] {
  const seed = hash(q.destination);
  const m = meta(q, now);
  const cats = ["Landmark", "Museum", "Market", "Viewpoint", "Park", "Waterfront"];
  return Array.from({ length: n }, (_, i) => ({
    id: `PL-${seed}-${i + 1}`,
    meta: m,
    name: `${q.destination} ${cats[i % cats.length]}`,
    metroArea: q.destination,
    category: cats[i % cats.length],
  }));
}

const carClasses = ["Economy", "Compact", "SUV", "Luxury"];

export function buildCarOffers(q: InventoryQuery, n = 6, now = new Date()): CarOffer[] {
  const pickup = (q.pickupLocation ?? q.destination) || q.destination;
  const dropoff = q.dropoffLocation ?? pickup;
  const days = Math.max(1, Math.trunc(q.rentalDays ?? q.nights ?? 1));
  const requested = q.carClass;
  const seed = hash(`${pickup}-${requested ?? "any"}-${days}`);
  const m = meta(q, now);
  const locMult = carMult[pickup] ?? 0.95;
  return Array.from({ length: n }, (_, i) => {
    // If a class is requested, calibrate around it; otherwise span the catalogue.
    const carClass = requested ?? carClasses[i % carClasses.length];
    const classBase = carClassBase[carClass] ?? carClassBase.Economy;
    const perDay = Math.round((classBase.daily * locMult * (1 + i * 0.09) + (seed % 400)) / 100) * 100;
    return {
      id: `CR-${seed}-${i + 1}`,
      meta: m,
      pickupLocation: pickup,
      dropoffLocation: dropoff,
      carClass,
      transmission: classBase.transmission,
      seats: classBase.seats,
      days,
      pricePerDay: perDay,
    };
  });
}
