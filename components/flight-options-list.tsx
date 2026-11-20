"use client";

import { useMemo, useRef, useState } from "react";
import type { LiveFlight } from "@/lib/providers/serpapi-flights";
import {
  cheapestKey,
  parseFlightSort,
  sortFlightOptions,
  type FlightSortKey,
  type SortableFlight,
} from "@/lib/flight-list";
import type { BookingCacheEntry, FlightBookingCriteria } from "@/components/flight-booking-panel";
import FlightOptionCard from "@/components/flight-option-card";

/**
 * Flights page list (trip-planning-v2 Req 12.1, 12.5, 12.6, 12.11, 12.15, 13.1-13.3).
 * Single sort control; changing it rewrites only the `sort` query param.
 */

export interface FlightOptionsListProps {
  flights: LiveFlight[];
  criteria: FlightBookingCriteria;
  travellers: number;
  roundTrip: boolean;
  provider: string;
  checkedAt: string;
  checkedLabel: string;
  initialSort: FlightSortKey;
}

type Row = SortableFlight & { flight: LiveFlight };

export default function FlightOptionsList({
  flights,
  criteria,
  travellers,
  roundTrip,
  provider,
  checkedAt,
  checkedLabel,
  initialSort,
}: FlightOptionsListProps) {
  const [sort, setSort] = useState<FlightSortKey>(parseFlightSort(initialSort));
  const cacheRef = useRef<Map<string, BookingCacheEntry>>(new Map());

  const rows: Row[] = useMemo(
    () =>
      flights.map((f, i) => ({
        key: f.token,
        order: i,
        fare: f.farePerPerson,
        durationMin: f.durationMin,
        departKey: f.departTime,
        flight: f,
      })),
    [flights],
  );

  // Computed over the unsorted list so the highlight is stable across sorts.
  const cheapest = useMemo(() => cheapestKey(rows), [rows]);
  const sorted = useMemo(() => sortFlightOptions(rows, sort), [rows, sort]);

  function onSort(value: string) {
    const next = parseFlightSort(value);
    setSort(next);
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    params.set("sort", next);
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}?${params.toString()}`,
    );
  }

  return (
    <div className="flight-options">
      <div className="flight-options__toolbar">
        <label className="flight-options__sort">
          <span>Sort by </span>
          <select value={sort} onChange={(e) => onSort(e.target.value)}>
            <option value="cheapest">Price (lowest first)</option>
            <option value="fastest">Duration (shortest)</option>
            <option value="earliest">Departure (earliest)</option>
          </select>
        </label>
      </div>

      <ul className="flight-option-list" aria-label="Flights with live fares">
        {sorted.map((r) => (
          <FlightOptionCard
            key={r.key}
            flight={r.flight}
            travellers={travellers}
            roundTrip={roundTrip}
            isCheapest={r.key === cheapest}
            provider={provider}
            checkedAt={checkedAt}
            checkedLabel={checkedLabel}
            criteria={criteria}
            cache={cacheRef.current}
          />
        ))}
      </ul>

      <p className="flight-options__provenance">
        Fares from {provider}. Checked {checkedLabel}. You book and pay on the vendor&apos;s site;
        Tripsaathi AI is not the seller of any flight and takes no payment.
      </p>
    </div>
  );
}
