"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FlightBookingOption,
  FlightBookingResult,
  FlightFaresResult,
  LiveFlight,
} from "@/lib/providers/serpapi-flights";
import { checkedLabel, dayOffset } from "@/lib/ist-time";
import { BookingRequestButton } from "@/components/booking-request-button";
import BrandLoader from "@/components/brand-loader";

/**
 * FlightBookingPanel - the expandable "Compare & book" area for one live flight
 * row (Req 5.1-5.12, 19.1). It is lazy by construction: nothing is requested
 * until the parent opens the panel, and every loaded result is written into a
 * shared booking cache `Map` (keyed by the token the parent supplies) so that
 * closing and reopening a panel never triggers a new request (Req 5.12).
 *
 * Two flows, driven by `flight.tokenKind`:
 *  - ONE-WAY outbound ("booking"): open goes straight to
 *    /api/flight-fares/booking and lists the booking options (Req 5.2).
 *  - ROUND-TRIP outbound ("departure"): open calls /api/flight-fares/returns to
 *    list return legs; selecting a return leg (which carries its own booking
 *    token) calls /api/flight-fares/booking for that pairing (Req 5.3, 5.4).
 *    A "Change return flight" control returns to the leg list (Req 5.3).
 *
 * The options are rendered with BookingRequestButton, which opens the chosen
 * site in a new tab and takes no payment here (Req 5.5-5.8). Loading shows a
 * `role="status"` skeleton (Req 5.9); a failed or non-live lookup shows a
 * `role="alert"` with "Try again" (Req 5.10); and the panel always states that
 * the traveller books and pays on the chosen site (Req 5.11).
 *
 * Only TYPES are imported from the server-only flights adapter.
 */

/** Search criteria needed to rebuild the lazy lookup query strings. */
export interface FlightBookingCriteria {
  origin: string;
  destination: string;
  tripType: "round-trip" | "one-way";
  departDate: string;
  returnDate?: string | null;
  cabin: string;
  travellers: number;
}

/** A loaded result cached by the parent, keyed by token (Req 5.12). */
export type BookingCacheEntry =
  | { kind: "returns"; result: FlightFaresResult }
  | { kind: "options"; result: FlightBookingResult };

type FetchState<T> =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; result: T };

/**
 * State machine (design "Booking panel state machine"):
 *   Idle -> LoadingReturns | LoadingOptions
 *   LoadingReturns -> Returns | Error
 *   Returns -> LoadingOptions (select return leg)
 *   LoadingOptions -> Options | Error
 *   Options -> Returns (change return leg)
 *   Error -> LoadingReturns | LoadingOptions (try again)
 */
type PanelState =
  | { phase: "idle" }
  | { phase: "loadingReturns" }
  | { phase: "returns"; result: FlightFaresResult }
  | { phase: "returnsError"; message: string }
  // A return leg has been chosen; `leg` is kept so we can offer "change leg".
  | { phase: "loadingOptions"; leg: LiveFlight | null }
  | { phase: "options"; leg: LiveFlight | null; result: FlightBookingResult }
  | { phase: "optionsError"; leg: LiveFlight | null; message: string };

const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

/** Build the shared query string for both lazy lookups. */
function baseParams(criteria: FlightBookingCriteria): URLSearchParams {
  const qs = new URLSearchParams({
    origin: criteria.origin,
    destination: criteria.destination,
    tripType: criteria.tripType,
    departDate: criteria.departDate,
    cabin: criteria.cabin,
    travellers: String(criteria.travellers),
  });
  if (criteria.returnDate) qs.set("returnDate", criteria.returnDate);
  return qs;
}

function timeOnly(local: string): string {
  const parts = local.trim().split(" ");
  return parts.length > 1 ? parts[1] : local;
}

/** One return-leg summary line, kept intentionally compact. */
function ReturnLeg({
  leg,
  onSelect,
}: {
  leg: LiveFlight;
  onSelect: (leg: LiveFlight) => void;
}) {
  const plus = dayOffset(leg.departTime, leg.arriveTime);
  const airline = leg.airlines.length > 0 ? leg.airlines.join(", ") : null;
  const stopsText =
    leg.stops === 0 ? "Non-stop" : `${leg.stops} ${leg.stops === 1 ? "stop" : "stops"}`;
  return (
    <li className="flight-booking__leg">
      <button
        type="button"
        className="btn flight-booking__leg-btn"
        onClick={() => onSelect(leg)}
      >
        <span className="flight-booking__leg-times">
          {timeOnly(leg.departTime)} {leg.departAirport} {"\u2192"} {timeOnly(leg.arriveTime)}{" "}
          {leg.arriveAirport}
          {plus > 0 ? <span className="flight-booking__leg-offset">{` +${plus}`}</span> : null}
        </span>
        <span className="flight-booking__leg-meta">
          {airline ? <span className="flight-booking__leg-airline">{airline}</span> : null}
          <span className="flight-booking__leg-stops">{stopsText}</span>
          <span className="flight-booking__leg-fare">{inr.format(leg.totalFare)}</span>
        </span>
      </button>
    </li>
  );
}

/** The loaded booking options, or a friendly empty-state message. */
function OptionsList({
  options,
  checkedAt,
}: {
  options: FlightBookingOption[];
  checkedAt: string;
}) {
  if (options.length === 0) {
    return (
      <p className="flight-booking__status">
        No booking sites were returned for this flight. Fares change often; try another option or
        search again.
      </p>
    );
  }
  return (
    <ul className="live-offer-list flight-booking__options" aria-label="Flight booking options">
      {options.map((o: FlightBookingOption, i: number) => (
        <li className="live-offer" key={`${o.source}-${o.optionTitle ?? ""}-${i}`}>
          <span className="live-offer__source">
            <span className="live-offer__name">{o.source}</span>
            {o.isAirline ? <span className="live-offer__badge">Airline</span> : null}
            {o.optionTitle ? <span className="live-offer__perk">{o.optionTitle}</span> : null}
          </span>
          <BookingRequestButton
            source={o.source}
            url={o.request.url}
            method={o.request.method}
            fields={o.request.fields}
            logo={o.logo}
            price={o.price}
          />
        </li>
      ))}
      <li className="flight-booking__checked" aria-hidden="false">
        <span className="live-offer__unit">Checked {checkedLabel(checkedAt)}</span>
      </li>
    </ul>
  );
}

export interface FlightBookingPanelProps {
  /** The panel's DOM id, referenced by the row's aria-controls. */
  id: string;
  /** The live flight this panel books. */
  flight: LiveFlight;
  /** Search criteria to rebuild the lookup query strings. */
  criteria: FlightBookingCriteria;
  /** True when the search is round-trip (outbound carries a departure token). */
  isRoundTrip: boolean;
  /** Shared booking cache, keyed by token; written on first load (Req 5.12). */
  cache: Map<string, BookingCacheEntry>;
}

export default function FlightBookingPanel({
  id,
  flight,
  criteria,
  isRoundTrip,
  cache,
}: FlightBookingPanelProps) {
  const [state, setState] = useState<PanelState>({ phase: "idle" });

  // A round-trip outbound with a departure token lists return legs first; a
  // one-way (or any booking-token itinerary) goes straight to options.
  const needsReturns = isRoundTrip && flight.tokenKind === "departure";

  const loadOptions = useCallback(
    async (bookingToken: string, leg: LiveFlight | null) => {
      setState({ phase: "loadingOptions", leg });
      const cached = cache.get(bookingToken);
      if (cached && cached.kind === "options") {
        setState({ phase: "options", leg, result: cached.result });
        return;
      }
      const qs = baseParams(criteria);
      qs.set("bookingToken", bookingToken);
      try {
        const res = await fetch(`/api/flight-fares/booking?${qs.toString()}`, {
          cache: "no-store",
        });
        const data = (await res.json()) as FlightBookingResult;
        if (data.status !== "live") {
          setState({
            phase: "optionsError",
            leg,
            message: data.error ?? "Booking options are unavailable right now.",
          });
          return;
        }
        cache.set(bookingToken, { kind: "options", result: data });
        setState({ phase: "options", leg, result: data });
      } catch {
        setState({
          phase: "optionsError",
          leg,
          message: "Booking options are unavailable right now.",
        });
      }
    },
    [cache, criteria],
  );

  const loadReturns = useCallback(async () => {
    setState({ phase: "loadingReturns" });
    const cached = cache.get(flight.token);
    if (cached && cached.kind === "returns") {
      setState({ phase: "returns", result: cached.result });
      return;
    }
    const qs = baseParams(criteria);
    qs.set("departureToken", flight.token);
    try {
      const res = await fetch(`/api/flight-fares/returns?${qs.toString()}`, {
        cache: "no-store",
      });
      const data = (await res.json()) as FlightFaresResult;
      if (data.status !== "live") {
        setState({
          phase: "returnsError",
          message: data.error ?? "Return flights are unavailable right now.",
        });
        return;
      }
      cache.set(flight.token, { kind: "returns", result: data });
      setState({ phase: "returns", result: data });
    } catch {
      setState({ phase: "returnsError", message: "Return flights are unavailable right now." });
    }
  }, [cache, criteria, flight.token]);

  // Kick off the first lookup exactly once, when the panel mounts (the parent
  // only mounts the panel while "Compare & book" is open, so this is the lazy
  // entry point). A ref guards against the effect re-running.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (needsReturns) void loadReturns();
    else void loadOptions(flight.token, null);
  }, [needsReturns, loadReturns, loadOptions, flight.token]);

  function retry() {
    if (state.phase === "returnsError") {
      void loadReturns();
    } else if (state.phase === "optionsError") {
      if (state.leg) void loadOptions(state.leg.token, state.leg);
      else void loadOptions(flight.token, null);
    }
  }

  function selectLeg(leg: LiveFlight) {
    void loadOptions(leg.token, leg);
  }

  function changeLeg() {
    const cached = cache.get(flight.token);
    if (cached && cached.kind === "returns") {
      setState({ phase: "returns", result: cached.result });
    } else {
      void loadReturns();
    }
  }

  const loading = state.phase === "loadingReturns" || state.phase === "loadingOptions";
  const errored = state.phase === "returnsError" || state.phase === "optionsError";

  return (
    <div id={id} className="flight-booking live-hotel__offers">
      {loading && (
        <div className="flight-booking__status live-hotel__status">
          <BrandLoader
            label={state.phase === "loadingReturns" ? "Finding return flights" : "Checking booking sites"}
            size={110}
          />
        </div>
      )}

      {errored && (
        <p className="flight-booking__status live-hotel__status--error" role="alert">
          {state.message}{" "}
          <button type="button" className="btn" onClick={retry}>
            Try again
          </button>
        </p>
      )}

      {state.phase === "returns" && (
        <div className="flight-booking__returns">
          {state.result.flights.length > 0 ? (
            <>
              <p className="flight-booking__hint">Choose a return flight to compare booking sites:</p>
              <ul className="flight-booking__legs" aria-label="Return flights">
                {state.result.flights.map((leg: LiveFlight) => (
                  <ReturnLeg key={leg.token} leg={leg} onSelect={selectLeg} />
                ))}
              </ul>
            </>
          ) : (
            <p className="flight-booking__status">
              No return flights were returned for these dates. Try different dates or search again.
            </p>
          )}
        </div>
      )}

      {state.phase === "options" && (
        <div className="flight-booking__options-wrap">
          {state.leg ? (
            <p className="flight-booking__selected">
              Return: {timeOnly(state.leg.departTime)} {state.leg.departAirport} {"\u2192"}{" "}
              {timeOnly(state.leg.arriveTime)} {state.leg.arriveAirport}{" "}
              <button type="button" className="btn flight-booking__change" onClick={changeLeg}>
                Change return flight
              </button>
            </p>
          ) : null}
          <OptionsList options={state.result.options} checkedAt={state.result.checkedAt} />
        </div>
      )}

      <p className="flight-booking__note live-hotel__note">
        You book and pay on the chosen site; TripGenie takes no payment. The final fare and fare
        rules are confirmed there and can change.
      </p>
    </div>
  );
}
