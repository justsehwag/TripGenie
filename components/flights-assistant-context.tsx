"use client";

import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { usePageAssistantContext } from "@/components/use-page-assistant-context";
import type { PageActionHandlers } from "@/lib/site-assistant/types";
import { buildResultsHref, parseFlightsView, serializeFlightsView, type FlightsView } from "@/lib/results-view";
import type { FlightsCriteria } from "@/lib/search-criteria";

/** One fare as the assistant sees it (built on the server from the rendered results). */
export interface AssistantFare {
  airline: string;
  stops: number;
  duration: string;
  price: number;
  priceLabel: string;
}

interface Props {
  criteria: FlightsCriteria;
  /** Fares the page renders (grouped country results flattened). Omit on the empty form. */
  fares?: AssistantFare[];
  /** Short status for pages without fares, e.g. "No flights found". */
  note?: string;
}

const MAX_FARES = 20;

function isStr(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function currentHref(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/**
 * Registers the Flights page context with the site assistant. Renders nothing.
 * Search/sort/filter actions navigate with the same URL builders the search
 * form uses, so the page re-renders from the URL as for a manual change.
 */
export default function FlightsAssistantContext({ criteria, fares, note }: Props) {
  const router = useRouter();
  const sp = useSearchParams();
  const spKey = sp.toString();
  const view: FlightsView = useMemo(() => parseFlightsView(spKey), [spKey]);

  const hasResultsView = fares !== undefined;

  const visible = useMemo(() => {
    if (!fares) return [];
    let list = fares.filter((f) => {
      if (view.stops.length > 0 && !view.stops.includes(String(Math.min(f.stops, 2)) as FlightsView["stops"][number])) {
        return false;
      }
      if (view.airlines.length > 0 && !view.airlines.includes(f.airline)) return false;
      if (view.maxFare !== null && !(f.price <= view.maxFare)) return false;
      return true;
    });
    if (view.sort === "cheapest") list = [...list].sort((a, b) => a.price - b.price);
    return list.slice(0, MAX_FARES);
  }, [fares, view]);

  const hrefFor = useCallback(
    (next: FlightsCriteria, nextView: FlightsView) => buildResultsHref("/flights", next, serializeFlightsView(nextView)),
    [],
  );

  const go = useCallback(
    (href: string) => {
      const previous = currentHref();
      router.push(href);
      return { undo: () => router.push(previous) };
    },
    [router],
  );

  const actions: PageActionHandlers = {
    setSearch: (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      if (!isStr(p.origin) || !isStr(p.destination) || !isStr(p.departDate)) return;
      const returnDate = isStr(p.returnDate) ? p.returnDate : undefined;
      const next: FlightsCriteria = {
        category: "flights",
        tripType: returnDate ? "round-trip" : "one-way",
        origin: p.origin,
        destination: p.destination,
        departDate: p.departDate,
        travellers: typeof p.travellers === "number" ? p.travellers : criteria.travellers || 1,
        cabin: criteria.cabin || "economy",
      };
      if (returnDate) next.returnDate = returnDate;
      // A new route invalidates airline/stop/price filters; keep only the sort.
      return go(hrefFor(next, { ...parseFlightsView(""), sort: view.sort }));
    },
  };

  if (hasResultsView) {
    actions.setSort = (params) => {
      const sort = (params as { sort?: unknown } | null)?.sort;
      if (sort !== "recommended" && sort !== "cheapest" && sort !== "fastest" && sort !== "earliest") return;
      return go(hrefFor(criteria, { ...view, sort, show: parseFlightsView("").show }));
    };
    actions.setFilter = (params) => {
      const p = (params ?? {}) as { stops?: unknown; maxPrice?: unknown };
      const next: FlightsView = { ...view, show: parseFlightsView("").show };
      if (Array.isArray(p.stops)) {
        const bands = p.stops.map((s) => String(s)).filter((s): s is "0" | "1" | "2" => s === "0" || s === "1" || s === "2");
        next.stops = (["0", "1", "2"] as const).filter((b) => bands.includes(b));
      }
      if (typeof p.maxPrice === "number" && Number.isFinite(p.maxPrice) && p.maxPrice >= 1) {
        next.maxFare = Math.floor(p.maxPrice);
      }
      return go(hrefFor(criteria, next));
    };
  }

  const route = `${criteria.origin || "?"} to ${criteria.destination || "?"}`;
  const summary = hasResultsView
    ? `Flights ${route}, ${criteria.tripType}, depart ${criteria.departDate || "-"}${
        criteria.returnDate ? `, return ${criteria.returnDate}` : ""
      }, ${criteria.travellers} traveller(s), sorted by ${view.sort}. ${
        visible.length > 0 ? `${visible.length} fare(s) shown.` : note ?? "No fares shown."
      }`
    : "Flights search form, no search yet.";

  const data = hasResultsView
    ? {
        criteria: {
          tripType: criteria.tripType,
          origin: criteria.origin,
          destination: criteria.destination,
          departDate: criteria.departDate,
          returnDate: criteria.returnDate,
          travellers: criteria.travellers,
          cabin: criteria.cabin,
        },
        view: { sort: view.sort, stops: view.stops, airlines: view.airlines, maxFare: view.maxFare },
        fares: visible,
      }
    : { criteria: { travellers: criteria.travellers, cabin: criteria.cabin } };

  usePageAssistantContext({ page: "flights", slot: "results", summary, data, actions });
  return null;
}
