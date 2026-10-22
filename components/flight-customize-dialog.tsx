"use client";

/**
 * Flight customization dialog (TripGenie parity with TripSaathi FR-31). A small
 * client island that lets the traveller switch the selected flight between a
 * direct (non-stop) and a one-stop routing, previews fare + duration for each,
 * and - on accept - persists the chosen flight to the shared browser-local
 * session key so Flights and the Itinerary reflect it immediately.
 *
 * Token-only styling via the existing cta/btn/field classes plus the auth-glass
 * dialog classes added to globals.css; no new :root token vars, no emoji.
 */

import { useState } from "react";
import type { FlightOffer } from "@/lib/types";
import {
  previewRouting,
  routingOf,
  customizeFlight,
  type Routing,
} from "@/lib/flight-customize";

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

function fmtDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** The customized flight TripGenie persists for Itinerary/Flights to read. */
export interface SelectedFlight {
  flightNo: string;
  date: string;
  depart: string;
  arrive: string;
  stops: number;
  farePerPerson: number;
  routing: Routing;
}

const STORAGE_KEY = "tripgenie.selectedFlight";

function persist(selected: SelectedFlight) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selected));
  } catch {
    // Non-fatal: the accepted selection still renders in-page this session.
  }
}

export default function FlightCustomizeDialog({ offer }: { offer: FlightOffer }) {
  const [open, setOpen] = useState(false);
  const [routing, setRouting] = useState<Routing>(routingOf(offer));
  const [accepted, setAccepted] = useState<SelectedFlight | null>(null);

  const options: Routing[] = ["direct", "one-stop"];

  function accept() {
    const next = customizeFlight(offer, routing);
    const selected: SelectedFlight = {
      flightNo: next.flightNo,
      date: next.date,
      depart: next.depart,
      arrive: next.arrive,
      stops: next.stops,
      farePerPerson: next.farePerPerson,
      routing,
    };
    persist(selected);
    setAccepted(selected);
    setOpen(false);
  }

  return (
    <div className="flight-customize">
      <button type="button" className="btn flight-customize__open" onClick={() => setOpen(true)}>
        Customize flight
      </button>

      {accepted && (
        <p className="notice flight-customize__accepted" role="status">
          Selected {accepted.routing === "direct" ? "non-stop" : "one-stop"} ·{" "}
          {accepted.flightNo} · {accepted.depart}-{accepted.arrive} ·{" "}
          {inr.format(accepted.farePerPerson)} / person. Flights and your itinerary now use this flight.
        </p>
      )}

      {open && (
        <div className="fc-dialog" role="dialog" aria-modal="true" aria-labelledby="fc-title">
          <div className="fc-dialog__backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="fc-dialog__panel auth-glass">
            <h2 id="fc-title" className="fc-dialog__title">Customize your flight</h2>
            <p className="fc-dialog__sub">{offer.origin} to {offer.destination} · {offer.flightNo}</p>

            <div className="fc-options" role="radiogroup" aria-label="Routing">
              {options.map((opt) => {
                const p = previewRouting(offer, opt);
                const selected = routing === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={`fc-option${selected ? " fc-option--selected" : ""}`}
                    onClick={() => setRouting(opt)}
                  >
                    <span className="fc-option__name">{opt === "direct" ? "Non-stop" : "One-stop"}</span>
                    <span className="fc-option__meta">{fmtDuration(p.durationMinutes)} · arrives {p.arrive}</span>
                    <span className="fc-option__fare">{inr.format(p.farePerPerson)} / person</span>
                  </button>
                );
              })}
            </div>

            <div className="fc-dialog__actions">
              <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" className="cta" onClick={accept}>Accept selection</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}