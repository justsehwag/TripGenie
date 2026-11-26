"use client";

import type { MergedFlights } from "@/lib/flight-groups";
import type { FlightBookingCriteria } from "@/components/flight-booking-panel";
import type { FlightSortKey } from "@/lib/flight-list";
import FlightOptionsList from "@/components/flight-options-list";

/**
 * Country search results grouped by arrival airport (search-typos-flights Req 5.2-5.5, 5.7).
 * Each group reuses FlightOptionsList with that airport's IATA code as destination.
 */

export interface FlightGroupsListProps {
  merged: MergedFlights;
  /** Criteria of the search; `destination` is replaced per group. */
  criteria: FlightBookingCriteria;
  travellers: number;
  roundTrip: boolean;
  provider: string;
  checkedAt: string;
  checkedLabel: string;
  initialSort: FlightSortKey;
}

function cityList(items: { code: string; city: string }[]): string {
  return items.map((a) => `${a.city} (${a.code})`).join(", ");
}

export default function FlightGroupsList({
  merged,
  criteria,
  travellers,
  roundTrip,
  provider,
  checkedAt,
  checkedLabel,
  initialSort,
}: FlightGroupsListProps) {
  const { groups, empty, failed } = merged;

  return (
    <div className="flight-groups">
      {groups.map((g) => (
        <section
          key={g.code}
          className="flight-group"
          aria-labelledby={`flight-group-${g.code}`}
        >
          <header className="flight-group__head">
            <h2 id={`flight-group-${g.code}`}>
              {g.city}
              <span className="flight-group__status">
                {" "}
                {g.name} ({g.code}) · {g.flights.length}{" "}
                {g.flights.length === 1 ? "flight" : "flights"}
              </span>
            </h2>
          </header>
          <FlightOptionsList
            flights={g.flights}
            criteria={{ ...criteria, destination: g.code }}
            travellers={travellers}
            roundTrip={roundTrip}
            provider={provider}
            checkedAt={checkedAt}
            checkedLabel={checkedLabel}
            initialSort={initialSort}
          />
        </section>
      ))}

      {empty.length > 0 ? (
        <p className="flight-notice" role="status">
          No flights found for {cityList(empty)} on these dates.
        </p>
      ) : null}
      {failed.length > 0 ? (
        <p className="flight-notice" role="status">
          Couldn&apos;t load fares for {cityList(failed)}. Try again in a moment.
        </p>
      ) : null}
    </div>
  );
}
