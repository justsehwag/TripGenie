import type { Metadata } from "next";
import Link from "next/link";
import { parseCriteria, serializeCriteria, type FlightsCriteria } from "@/lib/search-criteria";
import { runSearch } from "@/lib/search";
import type { InventoryQuery } from "@/lib/inventory-adapter";
import { parseFlightsView, serializeFlightsView } from "@/lib/results-view";
import { checkedLabel, todayIst } from "@/lib/ist-time";
import { searchFlightFares, type FlightFaresResult } from "@/lib/providers/serpapi-flights";
import PrefillFromContext from "@/components/prefill-from-context";
import FlightCoupons from "@/components/flight-coupons";
import FlightsSearchForm from "@/components/flights-search-form";
import FlightsResults from "@/components/flights-results";
import type { FlightBookingCriteria } from "@/components/flight-booking-panel";

export const metadata: Metadata = { title: "Flights - TripGenie" };

/**
 * Flights Results_Page (server component) — live-travel-pricing task 12.2.
 *
 * Reads `searchParams`, parses them into typed `FlightsCriteria` via
 * `parseCriteria("flights", …)` so opening or refreshing the URL reproduces the
 * identical search, and parses the view with `parseFlightsView` (legacy
 * `sort`/`maxStops` mapping included). It stays a SERVER component — the new
 * client `FlightsResults` owns sort / filter / paging, so this page no longer
 * carries the old GET sort form or the `sortOffers`/`filterOffers` helpers.
 *
 * Flow (mirrors the live-hotel pattern in `app/stays/page.tsx`):
 *   1. No origin AND no destination → render the full `FlightsSearchForm` plus
 *      the `PrefillFromContext` affordance (Req 4.3). No search is run.
 *   2. Otherwise call `searchFlightFares(...)` (server-only; fine here). When it
 *      returns real itineraries (`status === "live"` and at least one flight),
 *      render `<FlightsResults live …>` with the provider, Checked_Label,
 *      insights and a `FlightBookingCriteria` for the lazy booking lookups.
 *   3. When live fares are unavailable, invalid, unconfigured or empty, fall
 *      back to Pricing_Engine estimates (`runSearch(...).flights`), render
 *      `<FlightsResults live={false} …>`, and show a one-line Live_Notice
 *      explaining why live fares aren't shown.
 *
 * The compact `FlightsSearchForm` above the results is pre-filled from the
 * criteria and keeps the current view params so a new search preserves the
 * chosen sort / filter. `FlightCoupons` is kept (Req 17.4). The `runSearch`
 * error path is preserved for the estimate branch.
 *
 * Requirements: 1.1, 4.1, 4.2, 4.3, 4.7, 9.1, 9.2, 11.1, 11.5, 12.2, 17.4,
 * 21.3, 21.5.
 */

/** True when a string is a real YYYY-MM-DD date. */
function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** A YYYY-MM-DD date `days` after the given ISO date. */
function isoPlusDays(fromIso: string, days: number): string {
  const base = new Date(`${fromIso}T00:00:00Z`).getTime();
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Ensure a flight search has valid dates. When the URL carried a route but no
 * (or invalid) depart/return - e.g. the traveller arrived from the AI trip
 * without dates - default to a sensible near-future window so the LIVE fare
 * search runs and real fares (with Compare & book) show, not estimates.
 */
function ensureFlightDates(departDate: string, returnDate: string | undefined, roundTrip: boolean, today: string) {
  const dep = isIsoDate(departDate) ? departDate : isoPlusDays(today, 14);
  let ret = returnDate;
  if (roundTrip) ret = isIsoDate(ret ?? "") && (ret as string) > dep ? (ret as string) : isoPlusDays(dep, 6);
  return { departDate: dep, returnDate: ret };
}

type RawSearchParams = Record<string, string | string[] | undefined>;

/** Serialize Next's raw searchParams back into a query string for parseCriteria. */
function serializeRaw(raw: RawSearchParams): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length > 0) p.set(k, v[0]);
    } else {
      p.set(k, v);
    }
  }
  return p.toString();
}

/** Map parsed flight criteria to the Inventory_Adapter query shape (estimates). */
function toInventoryQuery(c: FlightsCriteria): InventoryQuery {
  return {
    origin: c.origin,
    destination: c.destination,
    cabin: c.cabin,
    // Flights do not use the stay fields; supply inert defaults.
    stayStyle: "Standard",
    nights: 1,
  };
}

/** The view params to keep across a new search, as a plain record for the form. */
function viewKeep(qs: string): Record<string, string> {
  const params = serializeFlightsView(parseFlightsView(qs));
  const keep: Record<string, string> = {};
  for (const [k, v] of params) keep[k] = v;
  return keep;
}

/**
 * Why estimates are shown instead of live fares (null when live fares are
 * shown). Mirrors the stays `liveNotice` switch over the Live_Status.
 */
function liveNotice(live: FlightFaresResult): string | null {
  switch (live.status) {
    case "live":
      return live.flights.length === 0
        ? "No live fares were returned for these dates, so the flights below are estimates."
        : null;
    case "unconfigured":
      return "Live fares aren't connected yet, so the flights below are estimates.";
    case "invalid":
      return `${live.error ?? "Check your search."} The flights below are estimates.`;
    case "unavailable":
      return "Live fares are temporarily unavailable, so the flights below are estimates.";
  }
}

export default async function FlightsResultsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const raw = await searchParams;

  // Reproduce the search from the URL. parseCriteria is total; parseFlightsView
  // applies the legacy sort/maxStops mapping (Req 11.5, 12.2).
  const qs = serializeRaw(raw);
  const criteria = parseCriteria("flights", qs) as FlightsCriteria;
  const view = parseFlightsView(raw);
  const today = todayIst();

  // No origin AND no destination → nothing to search. Render the full search
  // form and the shared-context prefill affordance (Req 4.3).
  const hasSearch =
    criteria.origin.trim() !== "" || criteria.destination.trim() !== "";
  if (!hasSearch) {
    return (
      <main className="shell results">
        <section className="results__summary motion-rise" aria-label="Results summary">
          <p className="eyebrow">Flights</p>
          <h1>Search flights</h1>
        </section>
        {/* Live search straight from /flights (one live search per submit). */}
        <FlightsSearchForm today={today} />
        <section className="card results__empty">
          <PrefillFromContext category="flights" />
        </section>
      </main>
    );
  }

  // Guarantee live-searchable dates (default a near-future window when the
  // trip arrived without dates), so live fares show, not estimate fallbacks.
  const roundTripForDates = criteria.tripType === "round-trip";
  const fd = ensureFlightDates(criteria.departDate, criteria.returnDate, roundTripForDates, today);
  criteria.departDate = fd.departDate;
  if (roundTripForDates) criteria.returnDate = fd.returnDate;

  // One live fare lookup for the exact route, dates, cabin and travellers.
  const live = await searchFlightFares({
    origin: criteria.origin,
    destination: criteria.destination,
    tripType: criteria.tripType,
    departDate: criteria.departDate,
    returnDate: criteria.returnDate,
    cabin: criteria.cabin,
    adults: criteria.travellers,
  });
  const showLive = live.status === "live" && live.flights.length > 0;

  const roundTrip = criteria.tripType === "round-trip";
  const travellers = criteria.travellers;

  // Resolved codes when live; otherwise fall back to the raw criteria labels.
  const originLabel = (showLive && live.route.origin) || criteria.origin || "Origin";
  const destinationLabel =
    (showLive && live.route.destination) || criteria.destination || "Destination";
  const routeLabel = `${originLabel} → ${destinationLabel}`;

  // Criteria for the lazy booking lookups (live branch).
  const bookingCriteria: FlightBookingCriteria = {
    origin: criteria.origin,
    destination: criteria.destination,
    tripType: criteria.tripType,
    departDate: criteria.departDate,
    returnDate: criteria.returnDate ?? null,
    cabin: criteria.cabin,
    travellers: criteria.travellers,
  };

  // The compact edit-in-place form keeps the current view params.
  const keep = viewKeep(qs);
  const compactForm = (
    <FlightsSearchForm
      compact
      today={today}
      initial={{
        tripType: criteria.tripType,
        origin: criteria.origin,
        destination: criteria.destination,
        departDate: criteria.departDate,
        returnDate: criteria.returnDate,
        travellers: criteria.travellers,
        cabin: criteria.cabin,
      }}
      keep={keep}
    />
  );

  if (showLive) {
    const count = live.flights.length;
    return (
      <main className="shell results">
        <section className="results__summary motion-rise" aria-label="Results summary">
          <p className="eyebrow">Flights</p>
          <h1>
            {count} {count === 1 ? "flight" : "flights"} with live fares for {routeLabel}
          </h1>
          <p className="results__summary-line" role="status">
            {routeLabel} · {count} {count === 1 ? "flight" : "flights"} ·{" "}
            {roundTrip ? "Round-trip" : "One-way"} · {criteria.cabin} ·{" "}
            {travellers} {travellers === 1 ? "traveller" : "travellers"}
          </p>
        </section>

        {compactForm}
        <FlightCoupons />

        <FlightsResults
          live
          liveFlights={live.flights}
          initialView={view}
          criteria={bookingCriteria}
          travellers={travellers}
          roundTrip={roundTrip}
          currency={live.currency}
          provider={live.provider}
          checkedAt={live.checkedAt}
          checkedLabel={checkedLabel(live.checkedAt)}
          insights={live.insights}
        />
      </main>
    );
  }

  // Estimate branch: Pricing_Engine flights, with the existing error handling.
  const result = runSearch(toInventoryQuery(criteria));
  const criteriaQuery = serializeCriteria(criteria);

  if (result.error) {
    return (
      <main className="shell results">
        <section className="results__summary motion-rise" aria-label="Results summary">
          <p className="eyebrow">Flights</p>
          <h1>We couldn&rsquo;t load flights for {routeLabel}</h1>
        </section>
        <section className="card results__error" role="alert">
          <p>{result.error}</p>
          <Link className="cta" href={`/flights${criteriaQuery ? `?${criteriaQuery}` : ""}`}>
            Retry search
          </Link>
        </section>
      </main>
    );
  }

  const offers = result.flights;
  const notice = liveNotice(live);
  const count = offers.length;

  return (
    <main className="shell results">
      <section className="results__summary motion-rise" aria-label="Results summary">
        <p className="eyebrow">Flights</p>
        <h1>Flights for {routeLabel}</h1>
        <p className="results__summary-line" role="status">
          {routeLabel} · {count} {count === 1 ? "flight" : "flights"} ·{" "}
          {roundTrip ? "Round-trip" : "One-way"} · {criteria.cabin} ·{" "}
          {travellers} {travellers === 1 ? "traveller" : "travellers"}
        </p>
      </section>

      {compactForm}
      <FlightCoupons />

      {notice && (
        <p className="card live-hotel-notice" role="status">
          {notice}
        </p>
      )}

      <FlightsResults
        live={false}
        estimateOffers={offers}
        initialView={view}
        criteria={bookingCriteria}
        travellers={travellers}
        roundTrip={roundTrip}
        currency="INR"
        provider={live.provider}
        checkedAt={live.checkedAt}
        checkedLabel={checkedLabel(live.checkedAt)}
        estimateQuery={criteriaQuery}
      />
    </main>
  );
}
