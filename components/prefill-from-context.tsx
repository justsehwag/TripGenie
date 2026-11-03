"use client";

/**
 * Shared-context prefill (realtime-ai-integration spec; Req 4.3, 10.2).
 *
 * A traveller who lands on a booking results page (e.g. `/flights`) WITHOUT any
 * search params - typically arriving from the concierge, where only the shared
 * `TripContext` holds the trip - should see live results immediately. This
 * client helper bridges that gap WITHOUT converting the server results page to
 * a client component:
 *
 *   - It reads the single Shared_Trip_Context via `useTripContext`.
 *   - If that context carries a usable destination, it projects it onto the
 *     requested category's `SearchCriteria` with the pure mappers, serializes
 *     with `serializeCriteria`, and AUTO-NAVIGATES (router.replace) to the same
 *     results route with those params - so the server page re-parses them and
 *     renders real results with no "Use my trip details" click.
 *   - If the context has no destination, it falls back to the SAME "start a
 *     search" prompt the page shows today (a `.lead` note linking home), so a
 *     casual browser still gets the normal empty search form with suggestions.
 *
 * Renders through EXISTING class names only (`.lead`, `.inline-link`). No new
 * token, no `:root` var, no nav entry, no new runtime dependency.
 *
 * Requirements: 4.3, 10.2.
 */

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

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
  const router = useRouter();
  const redirectedRef = useRef(false);

  // Usable for prefill only when the context carries a destination.
  const destination = context.destination?.trim() ?? "";

  // Build the prefilled results URL from the shared context ("" when none).
  const prefillHref = (() => {
    if (destination === "") return "";
    const criteria =
      category === "flights"
        ? toFlightsCriteria(context, dates)
        : category === "stays"
          ? toStaysCriteria(context, dates)
          : toCarsCriteria(context, dates);
    const query = serializeCriteria(criteria);
    return `${ROUTE[category]}${query ? `?${query}` : ""}`;
  })();

  // Auto-run the search: as soon as the shared context carries a trip, go
  // straight to the prefilled results (no click). This component only renders
  // on the page's no-search branch, so navigating to the prefilled URL
  // re-renders the page with real results and never loops. router.replace
  // keeps the back button clean.
  useEffect(() => {
    if (prefillHref === "" || redirectedRef.current) return;
    redirectedRef.current = true;
    router.replace(prefillHref);
  }, [prefillHref, router]);

  // No captured trip: the normal "start a search" prompt (casual browsing).
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

  // A trip exists: the redirect effect takes over immediately; show a quiet,
  // honest status line (never a button) while the prefilled results load.
  return (
    <p className="lead" role="status">
      Loading live {PLACE_NOUN[category]} for your trip to{" "}
      <strong>{destination}</strong>&hellip;
    </p>
  );
}