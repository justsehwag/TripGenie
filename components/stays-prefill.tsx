"use client";

/**
 * Stays shared-context prefill affordance (realtime-ai-integration spec, task
 * 12.2 — design "Shared_Trip_Context → carry via navigation" + "Booking Site ▸
 * Stays Results_Page").
 *
 * The `/stays` page is a SERVER component that reproduces its search purely from
 * the URL. When a traveler lands on `/stays` WITHOUT a destination in the URL
 * (typically arriving from the concierge, where only the shared `TripContext`
 * holds the trip), the server renders its existing empty-state prompt. This
 * small client helper is rendered INSIDE that existing prompt and does exactly
 * one additive thing: if the Shared_Trip_Context already carries a destination
 * (captured by the AI planner), it offers a one-click "Use my trip details"
 * link that routes to `/stays?<serialized StaysCriteria>` so the server page
 * re-parses it and runs the search — no page/UI/layout/token change.
 *
 * It mirrors the Flights (`prefill-from-context.tsx`) and Cars
 * (`cars-prefill.tsx`) prefill components exactly: read `useTripContext()`, map
 * via `toStaysCriteria`, serialize via `serializeCriteria`, and link to the
 * existing `/stays` route with those params. When the shared context has no
 * destination it falls back to the SAME "start a search" prompt the page shows
 * today (a `.lead` note linking home), so nothing is fabricated.
 *
 * HARD CONSTRAINT compliance: renders through EXISTING class names only
 * (`.lead`, `.inline-link`, `.cta`) — the exact pattern already used by the
 * Flights prefill. No new token, no `:root` var, no nav entry, no new runtime
 * dependency, no layout change.
 *
 * Requirements: 4.3, 6.1, 10.1, 10.2, 10.3, 10.4.
 */

import Link from "next/link";

import { useTripContext } from "@/components/trip-context";
import { toStaysCriteria } from "@/lib/trip-context-map";
import { serializeCriteria } from "@/lib/search-criteria";

/**
 * Renders a "Use my trip details" link to a prefilled `/stays` search when the
 * Shared_Trip_Context has a destination; otherwise renders the same
 * "start a search" prompt the page shows today so nothing is fabricated.
 */
export default function StaysPrefill() {
  const { context, dates } = useTripContext();

  // The shared context is usable for prefill only when it carries a
  // destination. Without one, there is nothing to project — fall through to the
  // same "start a search" prompt the page shows today (no fabrication).
  const destination = context.destination?.trim() ?? "";

  if (destination === "") {
    return (
      <p className="lead" role="note">
        Start a search to see stays, or plan your trip from the{" "}
        <Link href="/" className="inline-link">
          TripGenie concierge
        </Link>
        .
      </p>
    );
  }

  // Build StaysCriteria from the shared context (+ date hints) and serialize it
  // the same way every other criteria URL is produced, so the server page's
  // `parseCriteria("stays", …)` reproduces the identical search.
  const query = serializeCriteria(toStaysCriteria(context, dates));
  const href = query ? `/stays?${query}` : "/stays";

  return (
    <p className="lead" role="note">
      We have your trip to <strong>{destination}</strong> from the concierge.{" "}
      <Link href={href} className="cta">
        Use my trip details
      </Link>
    </p>
  );
}
