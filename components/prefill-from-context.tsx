"use client";

/**
 * Shared-context prefill affordance (realtime-ai-integration spec, task 12.1 —
 * design "Shared_Trip_Context → carry via navigation"; Req 4.3, 10.2).
 *
 * A traveler who lands on a booking results page (e.g. `/flights`) WITHOUT any
 * search params — typically arriving from the concierge, where only the shared
 * `TripContext` holds the trip — would otherwise see a bare page. This small
 * client helper bridges that gap WITHOUT converting the server results page to
 * a client component and WITHOUT any visual/layout/token change:
 *
 *   - It reads the single Shared_Trip_Context via `useTripContext`.
 *   - If that context carries a usable destination, it projects it onto the
 *     requested category's `SearchCriteria` with the pure mappers
 *     (`toFlightsCriteria`/`toStaysCriteria`/`toCarsCriteria`), serializes with
 *     `serializeCriteria`, and offers a one-click "Use my trip details" link to
 *     the same results route with those params — so the existing server page
 *     then `parseCriteria`s them and renders real results.
 *   - If the context has no destination either, it falls back to the SAME
 *     "start a search" prompt the page shows today (a `.lead` note linking home).
 *
 * HARD CONSTRAINT compliance: renders through EXISTING class names only
 * (`.lead`, `.inline-link`, `.cta`) — the exact pattern already used by the
 * booking empty states. No new token, no `:root` var, no nav entry, no new
 * runtime dependency, no layout change.
 *
 * Generic by category so `/stays` and `/cars` can reuse it cheaply, but this
 * task scopes its use to flights.
 *
 * Requirements: 4.3, 10.2.
 */

import Link from "next/link";

import { useTripContext } from "@/components/trip-context";
import {
  toFlightsCriteria,
  toStaysCriteria,
  toCarsCriteria,
} from "@/lib/trip-context-map";
import { serializeCriteria, type Category } from "@/lib/search-criteria";

export interface PrefillFromContextProps {
  /** Which booking category this results page serves. */
  category: Category;
}

/** Human label for the destination noun, per category, for the prompts. */
const PLACE_NOUN: Record<Category, string> = {
  flights: "flights",
  stays: "stays",
  cars: "rental cars",
};

/** Target results route for each category (all existing App Router routes). */
const ROUTE: Record<Category, string> = {
  flights: "/flights",
  stays: "/stays",
  cars: "/cars",
};

export default function PrefillFromContext({
  category,
}: PrefillFromContextProps) {
  const { context, dates } = useTripContext();

  // The shared context is usable for prefill only when it carries a
  // destination. Without one, there is nothing to project — fall through to the
  // same "start a search" prompt the page shows today (no fabrication).
  const destination = context.destination?.trim() ?? "";

  if (destination === "") {
    return (
      <p className="lead" role="note">
        Start a search to see {PLACE_NOUN[category]}, or plan your trip from the{" "}
        <Link href="/" className="inline-link">
          TripGenie concierge
        </Link>
        .
      </p>
    );
  }

  // Project the shared context onto this category's criteria via the pure
  // mappers, then serialize to the same query string the server page parses.
  const criteria =
    category === "flights"
      ? toFlightsCriteria(context, dates)
      : category === "stays"
        ? toStaysCriteria(context, dates)
        : toCarsCriteria(context, dates);

  const query = serializeCriteria(criteria);
  const href = `${ROUTE[category]}${query ? `?${query}` : ""}`;

  return (
    <p className="lead" role="note">
      We have your trip to <strong>{destination}</strong> from the concierge.{" "}
      <Link href={href} className="cta">
        Use my trip details
      </Link>
    </p>
  );
}
