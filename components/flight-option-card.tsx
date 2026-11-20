"use client";

import { useId, useState } from "react";
import type { LiveFlight } from "@/lib/providers/serpapi-flights";
import { dayOffset } from "@/lib/ist-time";
import { stopsLabel } from "@/lib/flight-list";
import FlightBookingPanel, {
  type BookingCacheEntry,
  type FlightBookingCriteria,
} from "@/components/flight-booking-panel";

/**
 * One flight option card (trip-planning-v2 Req 12.1-12.4, 12.6, 12.8-12.10, 12.13).
 * Vendor prices load on demand: FlightBookingPanel is mounted only after the
 * traveller opens "Compare vendors". Only types come from the server-only adapter.
 */

export interface FlightOptionCardProps {
  flight: LiveFlight;
  travellers: number;
  roundTrip: boolean;
  isCheapest: boolean;
  provider: string;
  checkedAt: string;
  checkedLabel: string;
  criteria: FlightBookingCriteria;
  cache: Map<string, BookingCacheEntry>;
}

const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

function formatDuration(minutes: number): string {
  const safe = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function clockOf(local: string): string {
  const m = /\b(\d{2}:\d{2})\b/.exec(local);
  return m ? m[1] : local;
}

export default function FlightOptionCard({
  flight,
  travellers,
  roundTrip,
  isCheapest,
  checkedLabel,
  criteria,
  cache,
}: FlightOptionCardProps) {
  const [open, setOpen] = useState(false);
  const panelId = `flight-vendors-${useId()}`;

  const offset = dayOffset(flight.departTime, flight.arriveTime);
  const airline = flight.airlines.join(", ");
  const people = Number.isFinite(travellers) && travellers >= 1 ? Math.floor(travellers) : 1;
  const stops = stopsLabel(flight.stops);

  return (
    <li className={`flight-option${isCheapest ? " flight-option--cheapest" : ""}`}>
      <div className="flight-option__head">
        {flight.airlineLogo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="flight-option__logo"
            src={flight.airlineLogo}
            alt=""
            width={24}
            height={24}
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : null}
        <span className="flight-option__airline">
          {airline}
          {flight.flightNumbers.length > 0 ? (
            <span className="flight-option__flightno">{` ${flight.flightNumbers.join(", ")}`}</span>
          ) : null}
        </span>
        {isCheapest ? (
          <span className="flight-option__badge" aria-label="Cheapest option">
            Cheapest
          </span>
        ) : null}
      </div>

      <div className="flight-option__times">
        <span className="flight-option__time">
          <span className="flight-option__clock">{clockOf(flight.departTime)}</span>
          <span className="flight-option__airport">{flight.departAirport}</span>
        </span>
        <span className="flight-option__path">
          <span className="flight-option__duration">{formatDuration(flight.durationMin)}</span>
          <span className="flight-option__stops">
            {stops}
            {flight.stops > 0 && flight.layoverAirports.length > 0
              ? ` via ${flight.layoverAirports.join(", ")}`
              : ""}
          </span>
        </span>
        <span className="flight-option__time">
          <span className="flight-option__clock">
            {clockOf(flight.arriveTime)}
            {offset > 0 ? <sup className="flight-option__nextday">{`+${offset}`}</sup> : null}
          </span>
          <span className="flight-option__airport">{flight.arriveAirport}</span>
        </span>
      </div>

      <div className="flight-option__price">
        <span className="flight-option__amount">{inr.format(flight.farePerPerson)}</span>
        <span className="flight-option__unit">per person</span>
        <span className="flight-option__total">
          {inr.format(flight.totalFare)} {roundTrip ? "round trip total" : "total"} {"\u00B7"} {people}{" "}
          {people === 1 ? "traveller" : "travellers"}
        </span>
        <span className="flight-option__checked">Checked {checkedLabel}</span>
      </div>

      <button
        type="button"
        className="btn flight-option__compare"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Hide vendors" : "Compare vendors"}
      </button>

      <div id={panelId} className="flight-option__vendors" hidden={!open}>
        {open ? (
          <FlightBookingPanel
            id={`${panelId}-panel`}
            flight={flight}
            criteria={criteria}
            isRoundTrip={roundTrip}
            cache={cache}
          />
        ) : null}
      </div>
    </li>
  );
}
