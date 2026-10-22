"use client";

/**
 * Cars shared-context prefill affordance (realtime-ai-integration spec, task
 * 12.3 — design "Shared_Trip_Context → carry via navigation" + "Booking Site ▸
 * Cars Results_Page").
 *
 * The `/cars` page is a SERVER component that reproduces its search purely from
 * the URL. When a traveler lands on `/cars` WITHOUT a pickup location in the
 * URL, the server renders its existing empty-state prompt ("Add a pickup
 * location… Start from the Cars search"). This small client helper is rendered
 * INSIDE that existing prompt and does exactly one additive thing: if the
 * Shared_Trip_Context already carries a destination (captured by the AI
 * planner), it offers a "Use my trip details" link that routes to
 * `/cars?<serialized CarsCriteria>` so the server page re-parses it and runs the
 * search — no page/UI/layout/token change.
 *
 * Why a client component: the shared context lives in the client
 * `TripContextProvider` (mounted in `app/layout.tsx`), so only a `"use client"`
 * reader can see it. It renders through EXISTING classes only (`.inline-link`),
 * introduces no new element type, token, or class, and renders NOTHING when the
 * context has no destination — leaving the server prompt exactly as it is today.
 *
 * Requirements: 4.3, 6.1, 7.6, 10.x (prefill via shared context, existing UI).
 */

import Link from "next/link";

import { useTripContext } from "@/components/trip-context";
import { toCarsCriteria } from "@/lib/trip-context-map";
import { serializeCriteria } from "@/lib/search-criteria";

/**
 * Renders a "Use my trip details" link to a prefilled `/cars` search when the
 * Shared_Trip_Context has a destination; otherwise renders nothing so the
 * server page's existing empty-state prompt stands unchanged.
 */
export default function CarsPrefill() {
  const { context, dates } = useTripContext();

  // No destination in the shared context ⇒ render nothing. The server page's
  // existing prompt remains exactly as today (no fabricated prefill).
  const destination = context.destination?.trim();
  if (!destination) return null;

  // Build CarsCriteria from the shared context (+ date hints) and serialize it
  // the same way every other criteria URL is produced, so the server page's
  // `parseCriteria("cars", …)` reproduces the identical search.
  const qs = serializeCriteria(toCarsCriteria(context, dates));
  const href = qs ? `/cars?${qs}` : "/cars";

  // A leading space separates this from the server prompt's trailing period; the
  // link carries its own closing period so the empty-state sentence reads
  // "… Cars search. Use my trip details." only when a destination exists.
  return (
    <>
      {" "}
      <Link href={href} className="inline-link">
        Use my trip details
      </Link>
      .
    </>
  );
}
