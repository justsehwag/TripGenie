/**
 * Flight customization (pure) - TripGenie parity with TripSaathi FR-31: let a
 * traveller switch a flight between a direct (non-stop) and a one-stop routing
 * in a dedicated dialog, and recompute fare and duration deterministically so
 * the accepted choice can be reflected immediately across Flights and Itinerary.
 *
 * Pure and framework-free: given a base FlightOffer and a chosen routing it
 * returns a NEW offer (never mutates the input). Direct routings carry a modest
 * convenience premium and a shorter duration; one-stop routings are cheaper and
 * longer. The mapping is a fixed, testable function of the base fare/times.
 */

import type { FlightOffer } from "./types";

export type Routing = "direct" | "one-stop";

/** Fixed, deterministic factors for each routing relative to the base fare. */
const FARE_FACTOR: Record<Routing, number> = { direct: 1.12, "one-stop": 0.9 };
/** Extra minutes a one-stop routing adds over the base duration. */
const ONE_STOP_EXTRA_MINUTES = 150;
/** Minutes a direct routing trims from a one-stop base (floor applied). */
const DIRECT_TRIM_MINUTES = 150;

function toMinutes(t: string): number {
  const [h, m] = t.split(":").map((n) => Number.parseInt(n, 10));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}
function fromMinutes(total: number): string {
  const wrapped = ((total % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** The current routing implied by an offer's stop count. */
export function routingOf(offer: Pick<FlightOffer, "stops">): Routing {
  return offer.stops === 0 ? "direct" : "one-stop";
}

/** Base (routing-neutral) fare, derived by removing the current routing factor. */
function baseFare(offer: Pick<FlightOffer, "farePerPerson" | "stops">): number {
  return offer.farePerPerson / FARE_FACTOR[routingOf(offer)];
}

/** Base duration in minutes with the current routing's delta removed. */
function baseDurationMinutes(offer: Pick<FlightOffer, "depart" | "arrive" | "stops">): number {
  const d = toMinutes(offer.depart);
  const a = toMinutes(offer.arrive);
  const span = a > d ? a - d : a + 1440 - d;
  return routingOf(offer) === "one-stop" ? span - ONE_STOP_EXTRA_MINUTES : span + DIRECT_TRIM_MINUTES;
}

export interface CustomizationPreview {
  routing: Routing;
  stops: number;
  farePerPerson: number;
  depart: string;
  arrive: string;
  durationMinutes: number;
}

/**
 * Preview a routing choice WITHOUT producing a full offer - handy for showing
 * both options side by side in the dialog.
 */
export function previewRouting(offer: FlightOffer, routing: Routing): CustomizationPreview {
  const base = Math.max(1, baseDurationMinutes(offer));
  const depart = toMinutes(offer.depart);
  const durationMinutes = Math.max(
    45,
    routing === "one-stop" ? base + ONE_STOP_EXTRA_MINUTES : base - DIRECT_TRIM_MINUTES,
  );
  const farePerPerson = Math.round((baseFare(offer) * FARE_FACTOR[routing]) / 100) * 100;
  return {
    routing,
    stops: routing === "direct" ? 0 : 1,
    farePerPerson,
    depart: offer.depart,
    arrive: fromMinutes(depart + durationMinutes),
    durationMinutes,
  };
}

/**
 * Apply a routing choice, returning a NEW FlightOffer with recomputed stops,
 * fare and arrival time. The input offer is never mutated (FR-31). Choosing the
 * routing the offer already has still returns a normalized copy.
 */
export function customizeFlight(offer: FlightOffer, routing: Routing): FlightOffer {
  const preview = previewRouting(offer, routing);
  return {
    ...offer,
    stops: preview.stops,
    farePerPerson: preview.farePerPerson,
    arrive: preview.arrive,
  };
}