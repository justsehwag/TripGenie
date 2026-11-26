import type { Metadata } from "next";
import { parseCriteria, type FlightsCriteria } from "@/lib/search-criteria";
import { checkedLabel, todayIst } from "@/lib/ist-time";
import { searchFlightFares } from "@/lib/providers/serpapi-flights";
import {
  classifyFlightAvailability,
  GROUND_TRANSPORT_NOTE,
  NO_FLIGHTS_FOR_DATES,
} from "@/lib/flight-availability";
import { decideFlightsView, parseFlightSort } from "@/lib/flight-list";
import { resolveAirport } from "@/lib/airports";
import { resolveDestination, type ResolvedDestination } from "@/lib/destination-airports";
import { mergeByAirport, type AirportSearch } from "@/lib/flight-groups";
import FlightGroupsList from "@/components/flight-groups-list";
import PrefillFromContext from "@/components/prefill-from-context";
import FlightsSearchForm from "@/components/flights-search-form";
import FlightsAssistantContext, { type AssistantFare } from "@/components/flights-assistant-context";
import type { LiveFlight } from "@/lib/providers/serpapi-flights";
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
 * wrapped in #flight-search. No coupon strip is rendered on this page.
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

/** Compact fare records for the site assistant, from the flights the page renders. */
function assistantFares(flights: readonly LiveFlight[]): AssistantFare[] {
  return flights.slice(0, 100).map((f) => ({
    airline: f.airlines.join(", ") || "Unknown airline",
    stops: f.stops,
    duration: `${Math.floor(f.durationMin / 60)}h ${f.durationMin % 60}m`,
    price: f.farePerPerson,
    priceLabel: `\u20B9${Math.round(f.farePerPerson).toLocaleString("en-IN")} per person`,
  }));
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
        <FlightsAssistantContext criteria={criteria} />
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

  // Resolve typed places. `exact=1` (the "search what I typed" link) skips correction.
  const exactRaw = Array.isArray(raw.exact) ? raw.exact[0] : raw.exact;
  const resolveSide = (text: string): ResolvedDestination => {
    if (exactRaw !== "1") return resolveDestination(text);
    const code = resolveAirport(text);
    const typed = text.trim();
    return code
      ? { kind: "airport", code, typed }
      : { kind: "unresolved", typed, suggestions: [] };
  };
  const originRes = resolveSide(criteria.origin);
  const destRes = resolveSide(criteria.destination);

  /** Link back to this page with one field replaced. */
  const hrefWith = (key: "origin" | "destination", value: string, exact: boolean) => {
    const p = new URLSearchParams(qs);
    p.set(key, value);
    if (exact) p.set("exact", "1");
    else p.delete("exact");
    return `/flights?${p.toString()}`;
  };

  // Pre-check: an unresolvable place means no provider call at all.
  if (originRes.kind !== "airport" || destRes.kind === "unresolved") {
    const names: string[] = [];
    if (originRes.kind !== "airport") names.push(criteria.origin.trim() || "origin");
    if (destRes.kind === "unresolved") names.push(criteria.destination.trim() || "destination");
    const suggestions = [
      ...(originRes.kind === "unresolved"
        ? originRes.suggestions.map((s) => ({ side: "origin" as const, label: s.label }))
        : []),
      ...(destRes.kind === "unresolved"
        ? destRes.suggestions.map((s) => ({ side: "destination" as const, label: s.label }))
        : []),
    ];
    return (
      <main className="shell results">
        {header("No flights for this route")}
        <FlightsAssistantContext criteria={criteria} fares={[]} note="No airport found for this route." />
        {compactForm}
        <section className="card live-hotel-notice" role="status">
          <p>{GROUND_TRANSPORT_NOTE}</p>
          <p>
            We couldn&rsquo;t find an airport for {names.join(" or ")}.{" "}
            <a href="#flight-search">Edit your search</a>
          </p>
          {suggestions.length > 0 && (
            <p>
              Did you mean{" "}
              {suggestions.map((s, i) => (
                <span key={`${s.side}-${s.label}`}>
                  {i > 0 ? ", " : ""}
                  <a href={hrefWith(s.side, s.label, false)}>{s.label}</a>
                </span>
              ))}
              ?
            </p>
          )}
        </section>
      </main>
    );
  }

  const originCode = originRes.code;

  // Correction_Notice: what was searched, what was typed, and a link to search the typed text as is.
  const noticeParts: { text: string; typed: string; side: "origin" | "destination" }[] = [];
  if (originRes.corrected) {
    noticeParts.push({
      text: `Showing flights from ${originRes.corrected.label} (${originCode}).`,
      typed: originRes.typed,
      side: "origin",
    });
  }
  if (destRes.kind === "country") {
    noticeParts.push({
      text: `Showing flights to ${destRes.country} (${destRes.airports
        .filter((a) => a.code !== originCode)
        .map((a) => a.code)
        .join(", ")}).`,
      typed: destRes.typed,
      side: "destination",
    });
  } else if (destRes.corrected) {
    noticeParts.push({
      text: `Showing flights to ${destRes.corrected.label} (${destRes.code}).`,
      typed: destRes.typed,
      side: "destination",
    });
  }
  const correctionNotice =
    noticeParts.length > 0 ? (
      <div className="card flight-notice" role="status">
        {noticeParts.map((n) => (
          <p key={n.side}>
            {n.text} You typed &lsquo;{n.typed}&rsquo;.{" "}
            <a href={hrefWith(n.side, n.typed, true)}>Search &lsquo;{n.typed}&rsquo; instead</a>
          </p>
        ))}
      </div>
    ) : null;

  const roundTripCountry = criteria.tripType === "round-trip";
  if (destRes.kind === "country") {
    const airports = destRes.airports.filter((a) => a.code !== originCode).slice(0, 4);
    if (airports.length === 0) {
      return (
        <main className="shell results">
          {header("No flights for this route")}
          <FlightsAssistantContext criteria={criteria} fares={[]} note="No other airports in this country." />
          {compactForm}
          <section className="card live-hotel-notice" role="status">
            <p>{GROUND_TRANSPORT_NOTE}</p>
            <p>
              <a href="#flight-search">Edit your search</a>
            </p>
          </section>
        </main>
      );
    }
    const results = await Promise.all(
      airports.map((a) =>
        searchFlightFares({
          origin: originCode,
          destination: a.code,
          tripType: criteria.tripType,
          departDate: criteria.departDate,
          returnDate: criteria.returnDate,
          cabin: criteria.cabin,
          adults: criteria.travellers,
        }),
      ),
    );
    const searches: AirportSearch[] = results.map((r, i) => ({
      code: airports[i].code,
      city: airports[i].city,
      name: airports[i].name,
      status: r.status,
      flights: r.flights,
      error: r.error,
    }));
    const merged = mergeByAirport(searches);
    const first = results[0];
    const routeText = `${originCode} → ${destRes.country}`;

    if (merged.total === 0) {
      const firstFailed = results.find((r) => r.status !== "live");
      const allFailed = merged.failed.length === airports.length;
      return (
        <main className="shell results">
          {header(allFailed ? `Flights for ${routeText}` : `No flights found for ${routeText}`)}
          <FlightsAssistantContext
            criteria={criteria}
            fares={[]}
            note={allFailed ? "Live fares unavailable." : "No flights found for these dates."}
          />
          {compactForm}
          {correctionNotice}
          <section className="card live-hotel-notice" role="status">
            <p>
              {allFailed && firstFailed
                ? liveNotice(firstFailed.status, firstFailed.error)
                : NO_FLIGHTS_FOR_DATES}
            </p>
            <p>
              <a href="#flight-search">{allFailed ? "Edit your search" : "Change dates"}</a>
            </p>
          </section>
        </main>
      );
    }

    const countryCriteria: FlightBookingCriteria = {
      origin: originCode,
      destination: airports[0].code,
      tripType: criteria.tripType,
      departDate: criteria.departDate,
      returnDate: criteria.returnDate ?? null,
      cabin: criteria.cabin,
      travellers: criteria.travellers,
    };
    const total = merged.total;
    return (
      <main className="shell results">
        {header(
          `${total} ${total === 1 ? "flight" : "flights"} with live fares for ${routeText}`,
          `${routeText} · ${total} ${total === 1 ? "flight" : "flights"} · ${
            roundTripCountry ? "Round-trip" : "One-way"
          } · ${criteria.cabin} · ${travellers} ${travellers === 1 ? "traveller" : "travellers"}`,
        )}
        <FlightsAssistantContext
          criteria={criteria}
          fares={assistantFares(merged.groups.flatMap((g) => g.flights))}
        />
        {compactForm}
        {correctionNotice}
        <FlightGroupsList
          merged={merged}
          criteria={countryCriteria}
          travellers={travellers}
          roundTrip={roundTripCountry}
          provider={first.provider}
          checkedAt={first.checkedAt}
          checkedLabel={checkedLabel(first.checkedAt)}
          initialSort={sort}
        />
      </main>
    );
  }

  const destCode = destRes.code;

  const live = await searchFlightFares({
    origin: originCode,
    destination: destCode,
    tripType: criteria.tripType,
    departDate: criteria.departDate,
    returnDate: criteria.returnDate,
    cabin: criteria.cabin,
    adults: criteria.travellers,
  });

  const availability = classifyFlightAvailability(originCode, destCode, {
    status: live.status,
    flightCount: live.flights.length,
  });
  const kind = decideFlightsView({
    availability,
    status: live.status,
    flightCount: live.flights.length,
  });

  const routeLabel = `${live.route.origin || originCode} → ${live.route.destination || destCode}`;

  if (kind === "ground-note") {
    return (
      <main className="shell results">
        {header("No flights for this route")}
        <FlightsAssistantContext criteria={criteria} fares={[]} note="No flights on this route; ground transport suggested." />
        {compactForm}
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
        <FlightsAssistantContext criteria={criteria} fares={[]} note="No flights found for these dates." />
        {compactForm}
        {correctionNotice}
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
        <FlightsAssistantContext criteria={criteria} fares={[]} note={liveNotice(live.status, live.error)} />
        {compactForm}
        {correctionNotice}
        <p className="card live-hotel-notice" role="status">
          {liveNotice(live.status, live.error)}
        </p>
      </main>
    );
  }

  const bookingCriteria: FlightBookingCriteria = {
    origin: originCode,
    destination: destCode,
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
      <FlightsAssistantContext criteria={criteria} fares={assistantFares(live.flights)} />
      {compactForm}
      {correctionNotice}
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
