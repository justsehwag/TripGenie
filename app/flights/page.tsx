import type { Metadata } from "next";
import { parseCriteria, type FlightsCriteria } from "@/lib/search-criteria";
import { checkedLabel, todayIst } from "@/lib/ist-time";
import { searchFlightFares } from "@/lib/providers/serpapi-flights";
import {
  classifyFlightAvailability,
  unresolvedSides,
  GROUND_TRANSPORT_NOTE,
  NO_FLIGHTS_FOR_DATES,
} from "@/lib/flight-availability";
import { decideFlightsView, parseFlightSort } from "@/lib/flight-list";
import PrefillFromContext from "@/components/prefill-from-context";
import FlightCoupons from "@/components/flight-coupons";
import FlightsSearchForm from "@/components/flights-search-form";
import FlightOptionsList from "@/components/flight-options-list";
import type { FlightBookingCriteria } from "@/components/flight-booking-panel";

export const metadata: Metadata = { title: "Flights - Tripsaathi AI" };

/**
 * Flights page (server component), trip-planning-v2 task 11.1.
 *
 * Body decision:
 *   1. No origin AND no destination: full search form + context prefill.
 *   2. Origin or destination has no airport: no provider call. Compact form plus
 *      the Ground_Transport_Note naming the unresolved place(s) (Req 11.1, 11.2).
 *   3. Otherwise one live search, then `decideFlightsView`:
 *        "no-flights"  -> "No flights found for these dates" + Change dates (11.3)
 *        "notice-only" -> live notice, no fares (11.4, 13.4)
 *        "list"        -> FlightOptionsList with provenance (12.x, 13.x)
 *
 * No estimated fares are ever rendered here (Req 13.4). The compact form is
 * wrapped in #flight-search and FlightCoupons is kept (Req 12.12).
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

/** Default a near-future window when the URL carried a route but no valid dates. */
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

/** Why no fares are shown when the live provider cannot supply them. */
function liveNotice(status: string, error?: string): string {
  switch (status) {
    case "unconfigured":
      return "Live fares aren't connected yet, so no flights are shown.";
    case "invalid":
      return `${error ?? "Check your search."} No flights are shown.`;
    case "unavailable":
    case "error":
    case "timeout":
      return "Live fares are temporarily unavailable, so no flights are shown.";
    default:
      return "Live fares couldn't be loaded, so no flights are shown.";
  }
}

export default async function FlightsResultsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const raw = await searchParams;
  const qs = serializeRaw(raw);
  const criteria = parseCriteria("flights", qs) as FlightsCriteria;
  const sort = parseFlightSort(Array.isArray(raw.sort) ? raw.sort[0] : raw.sort);
  const today = todayIst();

  const hasSearch = criteria.origin.trim() !== "" || criteria.destination.trim() !== "";
  if (!hasSearch) {
    return (
      <main className="shell results">
        <section className="results__summary motion-rise" aria-label="Results summary">
          <p className="eyebrow">Flights</p>
          <h1>Search flights</h1>
        </section>
        <FlightsSearchForm today={today} />
        <section className="card results__empty">
          <PrefillFromContext category="flights" />
        </section>
      </main>
    );
  }

  const roundTrip = criteria.tripType === "round-trip";
  const fd = ensureFlightDates(criteria.departDate, criteria.returnDate, roundTrip, today);
  criteria.departDate = fd.departDate;
  if (roundTrip) criteria.returnDate = fd.returnDate;
  const travellers = criteria.travellers;

  const compactForm = (
    <div id="flight-search">
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
        keep={{ sort }}
      />
    </div>
  );

  const header = (title: string, line?: string) => (
    <section className="results__summary motion-rise" aria-label="Results summary">
      <p className="eyebrow">Flights</p>
      <h1>{title}</h1>
      {line && (
        <p className="results__summary-line" role="status">
          {line}
        </p>
      )}
    </section>
  );

  // Pre-check: an unresolvable place means no provider call at all.
  const pre = classifyFlightAvailability(criteria.origin, criteria.destination);
  if (pre === "no-airport") {
    const sides = unresolvedSides(criteria.origin, criteria.destination);
    const names = sides.map((s) => (s === "origin" ? criteria.origin : criteria.destination).trim() || s);
    return (
      <main className="shell results">
        {header("No flights for this route")}
        {compactForm}
        <FlightCoupons />
        <section className="card live-hotel-notice" role="status">
          <p>{GROUND_TRANSPORT_NOTE}</p>
          <p>
            We couldn&rsquo;t find an airport for {names.join(" or ")}.{" "}
            <a href="#flight-search">Edit your search</a>
          </p>
        </section>
      </main>
    );
  }

  const live = await searchFlightFares({
    origin: criteria.origin,
    destination: criteria.destination,
    tripType: criteria.tripType,
    departDate: criteria.departDate,
    returnDate: criteria.returnDate,
    cabin: criteria.cabin,
    adults: criteria.travellers,
  });

  const availability = classifyFlightAvailability(criteria.origin, criteria.destination, {
    status: live.status,
    flightCount: live.flights.length,
  });
  const kind = decideFlightsView({
    availability,
    status: live.status,
    flightCount: live.flights.length,
  });

  const routeLabel = `${live.route.origin || criteria.origin} → ${live.route.destination || criteria.destination}`;

  if (kind === "ground-note") {
    return (
      <main className="shell results">
        {header("No flights for this route")}
        {compactForm}
        <FlightCoupons />
        <section className="card live-hotel-notice" role="status">
          <p>{GROUND_TRANSPORT_NOTE}</p>
          <p>
            <a href="#flight-search">Edit your search</a>
          </p>
        </section>
      </main>
    );
  }

  if (kind === "no-flights") {
    return (
      <main className="shell results">
        {header(`No flights found for ${routeLabel}`)}
        {compactForm}
        <FlightCoupons />
        <section className="card live-hotel-notice" role="status">
          <p>{NO_FLIGHTS_FOR_DATES}</p>
          <p>
            <a href="#flight-search">Change dates</a>
          </p>
        </section>
      </main>
    );
  }

  if (kind === "notice-only") {
    return (
      <main className="shell results">
        {header(`Flights for ${routeLabel}`)}
        {compactForm}
        <FlightCoupons />
        <p className="card live-hotel-notice" role="status">
          {liveNotice(live.status, live.error)}
        </p>
      </main>
    );
  }

  const bookingCriteria: FlightBookingCriteria = {
    origin: criteria.origin,
    destination: criteria.destination,
    tripType: criteria.tripType,
    departDate: criteria.departDate,
    returnDate: criteria.returnDate ?? null,
    cabin: criteria.cabin,
    travellers: criteria.travellers,
  };
  const count = live.flights.length;

  return (
    <main className="shell results">
      {header(
        `${count} ${count === 1 ? "flight" : "flights"} with live fares for ${routeLabel}`,
        `${routeLabel} · ${count} ${count === 1 ? "flight" : "flights"} · ${
          roundTrip ? "Round-trip" : "One-way"
        } · ${criteria.cabin} · ${travellers} ${travellers === 1 ? "traveller" : "travellers"}`,
      )}
      {compactForm}
      <FlightCoupons />
      <FlightOptionsList
        flights={live.flights}
        criteria={bookingCriteria}
        travellers={travellers}
        roundTrip={roundTrip}
        provider={live.provider}
        checkedAt={live.checkedAt}
        checkedLabel={checkedLabel(live.checkedAt)}
        initialSort={sort}
      />
    </main>
  );
}
