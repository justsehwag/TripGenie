"use client";

/**
 * FlightsResults - the client-owned flights Result_Set view (task 11.10).
 *
 * The flights counterpart of `stays-results.tsx`. The server page (task 12.2)
 * renders exactly one of two Result_Sets - never mixed:
 *  - LIVE: real Google Flights itineraries (`LiveFlight[]`) rendered as a
 *    `FlightList` of `LiveFlightRow`s, each slotting a `FlightBookingPanel` for
 *    the lazy "Compare & book" lookup.
 *  - ESTIMATE: Pricing_Engine `FlightOffer[]` rendered as `FlightOfferCard`s.
 *
 * This component owns the live View_State (sort, filters, page size). It is
 * seeded from the server's `parseFlightsView` and, on every change, it:
 *  - updates React state so the list re-renders with no network call (Req 6.1,
 *    12.1); and
 *  - rewrites the URL query string via `window.history.replaceState`, merging
 *    the serialised view with the existing criteria params already in the URL
 *    so the criteria are never dropped (Req 12.1, 12.2). No router push, no
 *    server round-trip.
 *
 * The view engine (`lib/results-view.ts`) and the pick engine
 * (`lib/pick-engine.ts`) do all of the filtering, sorting, paging, scoring and
 * AI_Pick selection, so both branches share one pipeline over normalised
 * `FlightItem`s. Nothing is fabricated: the airline facet is offered only for
 * live offers that carry airline names (Req 11.4), and the pick's typical-range
 * fact is only computed when the provider returned `PriceInsights`.
 *
 * The booking cache `Map` (keyed by token) is owned here via `useRef` and
 * passed down to every `FlightBookingPanel`, so closing and reopening a panel
 * never refetches (Req 5.12).
 *
 * Requirements: 4.1, 4.2, 5.12, 6.1, 11.1, 11.4, 12.1, 12.2, 15.2, 15.3, 15.8,
 * 17.1, 17.2, 17.3, 18.4, 21.5.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import type { FlightOffer } from "@/lib/types";
import type { LiveFlight, PriceInsights } from "@/lib/providers/serpapi-flights";
import {
  PAGE_SIZE,
  airlineFacets,
  clearAllFilters,
  effectiveFlightsView,
  filterFlights,
  flightsCaps,
  page,
  serializeFlightsView,
  sortFlights,
  type FlightItem,
  type FlightsView,
} from "@/lib/results-view";
import { pickFlight, scoreFlights, type Pick } from "@/lib/pick-engine";
import ResultsToolbar from "@/components/results-toolbar";
import { LiveFlightRow } from "@/components/live-flight-row";
import {
  FlightOfferCard,
  flightDurationMinutes,
  rankFlights,
  type FlightInsight,
} from "@/components/flight-offer-card";
import FlightBookingPanel, {
  type BookingCacheEntry,
  type FlightBookingCriteria,
} from "@/components/flight-booking-panel";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface FlightsResultsProps {
  /** True for a live Result_Set, false for an estimate one. */
  live: boolean;
  /** Live itineraries (live branch only). */
  liveFlights?: LiveFlight[];
  /** Estimate offers (estimate branch only). */
  estimateOffers?: FlightOffer[];
  /** The server's parsed View_State; seeds the local state. */
  initialView: FlightsView;
  /** Search criteria for the lazy booking lookups (live branch). */
  criteria: FlightBookingCriteria;
  /** Traveller count, used for the estimate total fare and row wording. */
  travellers: number;
  /** True when the search is round-trip. */
  roundTrip: boolean;
  /** Currency of the fares shown (INR for live). */
  currency: string;
  /** Provider label for the provenance line (live branch). */
  provider: string;
  /** Completion time of the Provider_Request, ISO-8601 (live branch). */
  checkedAt: string;
  /** Pre-formatted IST Checked_Label (live branch). */
  checkedLabel: string;
  /** Provider price insights for the pick's typical-range fact (live only). */
  insights?: PriceInsights | null;
  /** Serialised criteria appended to the estimate detail links (estimate branch). */
  estimateQuery?: string;
}

// ---------------------------------------------------------------------------
// Item mapping (LiveFlight / FlightOffer -> FlightItem)
// ---------------------------------------------------------------------------

/** The `HH:MM` portion of a "YYYY-MM-DD HH:MM" local timestamp, or the raw value. */
function clockOf(local: string): string {
  const m = /\b(\d{2}:\d{2})\b/.exec(local);
  return m ? m[1] : local;
}

/** Hour 0-23 parsed from a "YYYY-MM-DD HH:MM" (or "HH:MM") string, else -1. */
function hourOf(local: string): number {
  const clock = clockOf(local);
  const h = Number.parseInt(clock.slice(0, 2), 10);
  return Number.isFinite(h) && h >= 0 && h <= 23 ? h : -1;
}

/** Map a live itinerary to a `FlightItem` for the view engine. */
function liveToItem(flight: LiveFlight, index: number): FlightItem {
  return {
    key: flight.token,
    order: index,
    fare: flight.farePerPerson,
    durationMin: flight.durationMin,
    stops: flight.stops,
    // departTime is already the sortable "YYYY-MM-DD HH:MM" shape.
    departKey: flight.departTime,
    departHour: hourOf(flight.departTime),
    airlines: flight.airlines,
  };
}

/** Map an estimate offer to a `FlightItem` for the view engine. */
function estimateToItem(offer: FlightOffer, index: number): FlightItem {
  return {
    key: offer.id,
    order: index,
    fare: offer.farePerPerson,
    durationMin: flightDurationMinutes(offer.depart, offer.arrive),
    stops: offer.stops,
    // Estimate departure is an "HH:MM" clock; lexicographic order is chronological.
    departKey: offer.depart,
    departHour: hourOf(offer.depart),
    airlines: [],
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function FlightsResults(props: FlightsResultsProps) {
  const {
    live,
    liveFlights,
    estimateOffers,
    initialView,
    criteria,
    travellers,
    roundTrip,
    currency,
    provider,
    checkedAt,
    checkedLabel,
    insights = null,
    estimateQuery = "",
  } = props;

  // The live View_State, seeded from the server parse. Every change goes
  // through `applyView`, which also rewrites the URL (no server round-trip).
  const [view, setView] = useState<FlightsView>(initialView);

  // Shared booking cache keyed by token; created once and passed to every
  // FlightBookingPanel so reopening a panel never refetches (Req 5.12).
  const bookingCacheRef = useRef<Map<string, BookingCacheEntry>>(new Map());

  /**
   * Apply a new View_State: update React state and merge the serialised view
   * into the current URL, keeping every existing criteria parameter (Req 12.1,
   * 12.2). Guarded for SSR / tests where `window` is absent.
   */
  const applyView = useCallback((next: FlightsView) => {
    setView(next);
    if (typeof window === "undefined") return;

    const current = new URLSearchParams(window.location.search);
    const viewParams = serializeFlightsView(next);
    const viewKeys = new Set([...viewParams.keys()]);

    // Start from the existing params, drop every view-owned key, then re-apply
    // the canonical view params. Criteria params (any key the view does not
    // own) are preserved untouched.
    const merged = new URLSearchParams();
    const dropOnRefresh = new Set([
      "sort",
      "stops",
      "airline",
      "window",
      "maxFare",
      "show",
      // legacy flight params the view replaces (Req 11.5)
      "maxStops",
    ]);
    for (const [k, v] of current) {
      if (dropOnRefresh.has(k) || viewKeys.has(k)) continue;
      merged.append(k, v);
    }
    for (const [k, v] of viewParams) merged.append(k, v);

    const qs = merged.toString();
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState(window.history.state, "", url);
  }, []);

  if (live) {
    return (
      <LiveBranch
        flights={liveFlights ?? []}
        view={view}
        onChange={applyView}
        criteria={criteria}
        travellers={travellers}
        roundTrip={roundTrip}
        currency={currency}
        provider={provider}
        checkedAt={checkedAt}
        checkedLabel={checkedLabel}
        insights={insights}
        cache={bookingCacheRef.current}
      />
    );
  }

  return (
    <EstimateBranch
      offers={estimateOffers ?? []}
      view={view}
      onChange={applyView}
      travellers={travellers}
      query={estimateQuery}
    />
  );
}

// ---------------------------------------------------------------------------
// Live branch
// ---------------------------------------------------------------------------

function LiveBranch({
  flights,
  view,
  onChange,
  criteria,
  travellers,
  roundTrip,
  currency,
  provider,
  checkedAt,
  checkedLabel,
  insights,
  cache,
}: {
  flights: LiveFlight[];
  view: FlightsView;
  onChange: (view: FlightsView) => void;
  criteria: FlightBookingCriteria;
  travellers: number;
  roundTrip: boolean;
  currency: string;
  provider: string;
  checkedAt: string;
  checkedLabel: string;
  insights: PriceInsights | null;
  cache: Map<string, BookingCacheEntry>;
}) {
  // Look up the source itinerary by token for rendering.
  const byKey = useMemo(() => {
    const m = new Map<string, LiveFlight>();
    flights.forEach((f) => m.set(f.token, f));
    return m;
  }, [flights]);

  const items = useMemo(() => flights.map(liveToItem), [flights]);
  const caps = useMemo(() => flightsCaps(items, true), [items]);
  const facets = useMemo(() => airlineFacets(items), [items]);

  const effView = useMemo(
    () => effectiveFlightsView(view, caps, facets.map((f) => f.name)),
    [view, caps, facets],
  );
  const filtered = useMemo(() => filterFlights(items, effView), [items, effView]);
  const scores = useMemo(() => scoreFlights(filtered), [filtered]);
  const sorted = useMemo(() => sortFlights(filtered, effView, scores), [filtered, effView, scores]);
  const { visible, hasMore } = useMemo(() => page(sorted, effView.show), [sorted, effView.show]);

  // The AI_Pick over the filtered set, with the pick's REAL total fare and the
  // provider insights (Req 15.2, 15.3, 15.8). Returns null when fewer than two.
  const pick: Pick | null = useMemo(
    () =>
      pickFlight(filtered, {
        estimated: false,
        insights: insights ? { typicalRange: insights.typicalRange } : null,
        totalFare: (key) => byKey.get(key)?.totalFare ?? NaN,
      }),
    [filtered, insights, byKey],
  );

  const showMore = () => onChange({ ...view, show: view.show + PAGE_SIZE });

  return (
    <div className="results">
      <ResultsToolbar
        kind="flights"
        view={view}
        onChange={onChange}
        caps={caps}
        airlineFacets={facets}
        totalCount={filtered.length}
        shownCount={visible.length}
        countNoun="flights"
      />

      {visible.length === 0 ? (
        <EmptyFilters onClear={() => onChange(clearAllFilters(view))} />
      ) : (
        <>
          <ul className="offer-list offer-list--rows">
            {visible.map((item) => {
              const flight = byKey.get(item.key);
              if (!flight) return null;
              const isPick = pick?.key === item.key;
              const panelId = `flight-book-${item.key}`;
              return (
                <LiveFlightRow
                  key={item.key}
                  flight={flight}
                  travellers={travellers}
                  roundTrip={roundTrip}
                  currency={currency}
                  provider={provider}
                  checkedAt={checkedAt}
                  checkedLabel={checkedLabel}
                  pick={isPick && pick ? { reason: pick.reason } : null}
                >
                  <FlightBookingPanel
                    id={panelId}
                    flight={flight}
                    criteria={criteria}
                    isRoundTrip={roundTrip}
                    cache={cache}
                  />
                </LiveFlightRow>
              );
            })}
          </ul>

          {hasMore && (
            <div className="results__more">
              <button type="button" className="btn" onClick={showMore}>
                Show more flights
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Estimate branch
// ---------------------------------------------------------------------------

function EstimateBranch({
  offers,
  view,
  onChange,
  travellers,
  query,
}: {
  offers: FlightOffer[];
  view: FlightsView;
  onChange: (view: FlightsView) => void;
  travellers: number;
  query: string;
}) {
  const byId = useMemo(() => {
    const m = new Map<string, FlightOffer>();
    offers.forEach((o) => m.set(o.id, o));
    return m;
  }, [offers]);

  const items = useMemo(() => offers.map(estimateToItem), [offers]);
  // Estimates never carry airline names, so the airline filter is hidden.
  const caps = useMemo(() => flightsCaps(items, false), [items]);

  const effView = useMemo(() => effectiveFlightsView(view, caps, []), [view, caps]);
  const filtered = useMemo(() => filterFlights(items, effView), [items, effView]);
  const scores = useMemo(() => scoreFlights(filtered), [filtered]);
  const sorted = useMemo(() => sortFlights(filtered, effView, scores), [filtered, effView, scores]);
  const { visible, hasMore } = useMemo(() => page(sorted, effView.show), [sorted, effView.show]);

  // Deterministic value insights for the card (match %, highlights), computed
  // over the full estimate set so the ranking is stable across filters.
  const insightById = useMemo(() => rankFlights(offers), [offers]);

  // The AI_Pick over the filtered estimates; no insights, total = per-person
  // fare multiplied by the traveller count (Req 15.8).
  const pick: Pick | null = useMemo(
    () =>
      pickFlight(filtered, {
        estimated: true,
        insights: null,
        totalFare: (key) => (byId.get(key)?.farePerPerson ?? NaN) * travellers,
      }),
    [filtered, byId, travellers],
  );

  const showMore = () => onChange({ ...view, show: view.show + PAGE_SIZE });

  return (
    <div className="results">
      <ResultsToolbar
        kind="flights"
        view={view}
        onChange={onChange}
        caps={caps}
        totalCount={filtered.length}
        shownCount={visible.length}
        countNoun="flights"
      />

      {visible.length === 0 ? (
        <EmptyFilters onClear={() => onChange(clearAllFilters(view))} />
      ) : (
        <>
          <ul className="offer-list offer-list--rows">
            {visible.map((item) => {
              const offer = byId.get(item.key);
              if (!offer) return null;
              const base: FlightInsight | undefined = insightById[offer.id];
              // Extend the picked estimate's insight with the pick reason (Req 15.2).
              const insight: FlightInsight | undefined =
                pick?.key === item.key && base
                  ? { ...base, reason: pick.reason }
                  : base;
              return (
                <FlightOfferCard
                  key={item.key}
                  offer={offer}
                  travellers={travellers}
                  query={query}
                  insight={insight}
                />
              );
            })}
          </ul>

          {hasMore && (
            <div className="results__more">
              <button type="button" className="btn" onClick={showMore}>
                Show more flights
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty-after-filter state
// ---------------------------------------------------------------------------

function EmptyFilters({ onClear }: { onClear: () => void }) {
  return (
    <div className="results__empty" role="status">
      <p>No flights match your filters.</p>
      <button type="button" className="btn" onClick={onClear}>
        Clear filters
      </button>
    </div>
  );
}
