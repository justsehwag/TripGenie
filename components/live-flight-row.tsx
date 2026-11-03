"use client";

import { useId, useState, type ReactNode } from "react";
import type { LiveFlight } from "@/lib/providers/serpapi-flights";
import { inr } from "@/components/flight-offer-card";
import { ProvenanceLabel } from "@/components/offer-provenance";
import { dayOffset } from "@/lib/ist-time";
import type { OfferMeta } from "@/lib/types";

/**
 * Live flight row (Google Flights via SerpApi).
 *
 * A single wide row for one live itinerary, mirroring the estimate
 * `FlightOfferCard` scaffolding (`.flight-row*`) but driven entirely by the
 * provider-returned `LiveFlight`. Nothing is fabricated: the airline name and
 * logo, flight numbers and layover codes appear only when the provider returned
 * them (Req 21.2). The "Compare & book" control toggles the parent-supplied
 * booking panel (`children`) and never fetches booking options until the
 * traveller opens it - the panel owns that lazy lookup (Req 5.1).
 */

/**
 * Build a live `OfferMeta` for the provenance label (mirrors `liveMeta` in
 * `live-hotel-results.tsx`): mode "live", the provider label, the completion
 * time as `retrievedAt`, and a disclaimer stating the fare is confirmed on the
 * booking site (Req 9.4).
 */
function liveMeta(provider: string, checkedAt: string, checkedLabel: string): OfferMeta {
  const at = Date.parse(checkedAt);
  return {
    provider,
    mode: "live",
    retrievedAt: checkedAt,
    expiresAt: new Date((Number.isFinite(at) ? at : 0) + 45 * 60_000).toISOString(),
    disclaimer: `Live fare checked ${checkedLabel}. The final fare and fare rules are confirmed on the booking site.`,
  };
}

/** Minutes as `Xh Ym` (or `Xh` on the hour). */
function formatDuration(minutes: number): string {
  const safe = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** "Non-stop" / "1 stop" / "N stops" from a stop count. */
function stopsLabel(stops: number): string {
  if (stops <= 0) return "Non-stop";
  return stops === 1 ? "1 stop" : `${stops} stops`;
}

/** The `HH:MM` portion of a "YYYY-MM-DD HH:MM" local timestamp, or the raw value. */
function clockOf(local: string): string {
  const m = /\b(\d{2}:\d{2})\b/.exec(local);
  return m ? m[1] : local;
}

function PlaneIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M21 15.5v-1.8l-8-4.9V3.5a1.5 1.5 0 00-3 0v5.3l-8 4.9v1.8l8-2.4v5.1l-2 1.5V21l3.5-1 3.5 1v-1.3l-2-1.5v-5.1l8 2.4z"
        fill="currentColor"
      />
    </svg>
  );
}

export function LiveFlightRow({
  flight,
  travellers,
  roundTrip,
  currency,
  provider,
  checkedAt,
  checkedLabel,
  pick,
  children,
}: {
  flight: LiveFlight;
  travellers: number;
  roundTrip: boolean;
  currency: string;
  provider: string;
  checkedAt: string;
  checkedLabel: string;
  pick?: { reason: string } | null;
  /** The FlightBookingPanel slotted by the parent, revealed when open. */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = `live-flight-panel-${useId()}`;

  const fmt = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  });
  const money = currency === "INR" ? inr : fmt;

  const offset = dayOffset(flight.departTime, flight.arriveTime);
  const stops = stopsLabel(flight.stops);
  const hasAirlineName = flight.airlines.length > 0;
  const airlineName = flight.airlines.join(", ");
  const travellerWord = travellers === 1 ? "traveller" : "travellers";
  const totalWord = roundTrip ? "round trip total" : "total";

  return (
    <li className="offer-card flight-row flight-row--live">
      <div className="flight-row__link">
        <div className="flight-row__pick">
          {pick && <span className="flight-row__badge">AI&apos;s pick</span>}
          {pick && <span className="flight-row__reason">{pick.reason}</span>}
        </div>

        <div className="flight-row__carrier">
          <span className="flight-row__icon">
            {flight.airlineLogo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="flight-row__logo"
                src={flight.airlineLogo}
                alt=""
                width={24}
                height={24}
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : (
              <PlaneIcon />
            )}
          </span>
          <span className="flight-row__carrier-text">
            {hasAirlineName && <span className="flight-row__airline">{airlineName}</span>}
            {flight.flightNumbers.length > 0 && (
              <span className="flight-row__flightno">{flight.flightNumbers.join(", ")}</span>
            )}
            <span className="flight-row__cabin">{stops}</span>
          </span>
        </div>

        <div className="flight-row__time">
          <span className="flight-row__clock">{clockOf(flight.departTime)}</span>
          <span className="flight-row__city">{flight.departAirport}</span>
        </div>

        <div className="flight-row__path">
          <span className="flight-row__duration">{formatDuration(flight.durationMin)}</span>
          <span className="flight-row__line">
            <span className="flight-row__plane">
              <PlaneIcon size={14} />
            </span>
          </span>
          <span className="flight-row__stops">
            {stops}
            {flight.stops > 0 && flight.layoverAirports.length > 0 && (
              <span className="flight-row__layovers">{` via ${flight.layoverAirports.join(", ")}`}</span>
            )}
          </span>
        </div>

        <div className="flight-row__time flight-row__time--arrive">
          <span className="flight-row__clock">
            {clockOf(flight.arriveTime)}
            {offset > 0 && <sup className="flight-row__nextday">{`+${offset}`}</sup>}
          </span>
          <span className="flight-row__city">{flight.arriveAirport}</span>
        </div>

        <div className="flight-row__price">
          <ProvenanceLabel meta={liveMeta(provider, checkedAt, checkedLabel)} />
          <span className="flight-row__amount">{money.format(flight.farePerPerson)}</span>
          <span className="flight-row__unit">per person</span>
          <span className="flight-row__total">
            {money.format(flight.totalFare)} {totalWord} {"\u00B7"} {travellers} {travellerWord}
          </span>
          <span className="flight-row__checked">Checked {checkedLabel}</span>
          <button
            type="button"
            className="cta flight-row__compare"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={panelId}
          >
            {open ? "Hide booking options" : "Compare & book"}
          </button>
        </div>
      </div>

      {open && (
        <div id={panelId} className="flight-row__panel">
          {children}
        </div>
      )}
    </li>
  );
}
