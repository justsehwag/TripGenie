/**
 * Pure, total record codec for the account-history-and-drafts feature
 * (design section "Components and Interfaces" §3 "record-codec"; Data Models
 * "CapturedPlan"; Correctness Property 4 "Record round-trip and totality").
 *
 * This module is the bridge between the live Shared_Trip_Context
 * (components/trip-context.tsx) and the persistable payload stored inside a
 * StoredTrip record. It is framework-free, node-testable, and performs NO
 * window / sessionStorage access and imports NO server-only secret.
 *
 * - fromSharedContext serializes a live CapturedPlan into a plain payload.
 * - toSharedContext is TOTAL: it never throws and returns the safe default
 *   { context: {}, dates: {}, itinerary: null } on any malformed, partial, or
 *   non-object input, validating each field defensively in the same style as
 *   readStorage in components/trip-context.tsx (unknown/missing context -> {},
 *   missing dates -> {}, non-object itinerary -> null).
 *
 * The round-trip toSharedContext(fromSharedContext(plan)) equals plan for any
 * well-formed CapturedPlan.
 *
 * Requirements: 3.8, 4.6, 4.7, 5.6, 5.7.
 */

import type { TripContext, Itinerary } from "@/lib/types";
import type { DateHints } from "@/lib/trip-context-map";

/**
 * The resume payload reconstructed from (or serialized into) a StoredTrip.
 * Mirrors the SharedTripContextState shape held by trip-context.tsx: the
 * canonical TripContext, the lightweight ISO DateHints, and the optional
 * most-recently generated Itinerary.
 */
export interface CapturedPlan {
  context: TripContext;
  dates: DateHints;
  itinerary?: Itinerary | null;
}

/** The safe empty/null plan returned by toSharedContext on any bad input. */
function safeDefault(): CapturedPlan {
  return { context: {}, dates: {}, itinerary: null };
}

/** True for a non-null, non-array plain object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Build the payload persisted inside a StoredTrip from the live
 * Shared_Trip_Context. The itinerary is normalized to null when absent so the
 * round-trip through toSharedContext reconstructs an equal CapturedPlan.
 */
export function fromSharedContext(plan: CapturedPlan): Record<string, unknown> {
  return {
    context: plan.context,
    dates: plan.dates,
    itinerary: plan.itinerary ?? null,
  };
}

/**
 * Reconstruct a CapturedPlan from a stored record's payload. TOTAL: never
 * throws; returns the safe default { context: {}, dates: {}, itinerary: null }
 * on malformed / partial / non-object input. Each field is validated
 * defensively in the same style as readStorage in trip-context.tsx:
 *   - unknown / missing / non-object context -> {}
 *   - unknown / missing / non-object dates    -> {}
 *   - non-object itinerary                     -> null
 */
export function toSharedContext(payload: unknown): CapturedPlan {
  if (!isPlainObject(payload)) return safeDefault();

  const context: TripContext =
    isPlainObject(payload.context) ? (payload.context as unknown as TripContext) : {};
  const dates: DateHints =
    isPlainObject(payload.dates) ? (payload.dates as unknown as DateHints) : {};
  const itinerary: Itinerary | null =
    isPlainObject(payload.itinerary) ? (payload.itinerary as unknown as Itinerary) : null;

  return { context, dates, itinerary };
}
