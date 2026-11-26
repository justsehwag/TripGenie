"use client";

/**
 * Stays shared-context prefill (realtime-ai-integration spec).
 *
 * The `/stays` page is a SERVER component that reproduces its search purely from
 * the URL. When a traveller lands on `/stays` WITHOUT a destination in the URL
 * (typically arriving from the concierge, where only the shared `TripContext`
 * holds the trip), the server renders its empty-state prompt and this helper is
 * rendered inside it. If the Shared_Trip_Context already carries a destination
 * (captured by the AI planner), it AUTO-NAVIGATES (router.replace) to
 * `/stays?<serialized StaysCriteria>` so the server page re-parses it and runs
 * the live search - with NO "Use my trip details" click. When the shared
 * context has no destination it falls back to the SAME "start a search" prompt
 * the page shows today, so a casual browser still gets the normal empty search
 * form with suggestions.
 *
 * Renders through EXISTING class names only (`.lead`, `.inline-link`). No new
 * token, no `:root` var, no nav entry, no new runtime dependency.
 *
 * Requirements: 4.3, 6.1, 10.1, 10.2, 10.3, 10.4.
 */

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import { useTripContext } from "@/components/trip-context";
import { toStaysCriteria } from "@/lib/trip-context-map";
import { serializeCriteria, type StaysCriteria } from "@/lib/search-criteria";
import { buildResultsHref } from "@/lib/results-view";
import { usePageAssistantContext } from "@/components/use-page-assistant-context";

export default function StaysPrefill() {
  const { context, dates } = useTripContext();
  const router = useRouter();
  const redirectedRef = useRef(false);

  const destination = context.destination?.trim() ?? "";

  // The prefilled /stays URL from the shared context ("" when no destination).
  const prefillHref = (() => {
    if (destination === "") return "";
    const query = serializeCriteria(toStaysCriteria(context, dates));
    return query ? `/stays?${query}` : "/stays";
  })();

  // Site assistant: no results yet, so only setSearch is offered (Req 4.4).
  usePageAssistantContext({
    page: "stays",
    slot: "search",
    summary: "Stays search page with no search run yet.",
    actions: {
      setSearch: (params) => {
        const p = (params ?? {}) as Record<string, unknown>;
        if (typeof p.destination !== "string" || typeof p.checkIn !== "string" || typeof p.checkOut !== "string") return;
        const next: StaysCriteria = {
          category: "stays",
          destination: p.destination,
          checkIn: p.checkIn,
          checkOut: p.checkOut,
          guests: typeof p.guests === "number" ? p.guests : 1,
          rooms: 1,
        };
        router.push(buildResultsHref("/stays", next));
      },
    },
  });

  // Auto-run the search as soon as a trip is captured (no click). This renders
  // only on the no-search branch, so navigating to the prefilled URL re-renders
  // the page with real results and never loops. router.replace keeps back clean.
  useEffect(() => {
    if (prefillHref === "" || redirectedRef.current) return;
    redirectedRef.current = true;
    router.replace(prefillHref);
  }, [prefillHref, router]);

  // No captured trip: the normal "start a search" prompt (casual browsing).
  if (destination === "") {
    return (
      <p className="lead" role="note">
        Start a search to see stays, or plan your trip from the{" "}
        <Link href="/" className="inline-link">
          Tripsaathi AI concierge
        </Link>
        .
      </p>
    );
  }

  // A trip exists: the redirect takes over; show a quiet status line, no button.
  return (
    <p className="lead" role="status">
      Loading live stays for your trip to <strong>{destination}</strong>&hellip;
    </p>
  );
}