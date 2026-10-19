import Link from "next/link";
import type { FlightOffer } from "@/lib/types";
import { flightOfferFare } from "@/lib/workspace";
import { ProvenanceLabel, EstimatedNotice } from "@/components/offer-provenance";

/**
 * Flight offer card (Req 24.9, 24.10, 24.12). Presentational server component:
 * renders the FlightOffer fields, the fare per person and the fare multiplied
 * by the traveller count (from the Pricing Engine via `flightOfferFare`,
 * reusing Req 8), the OfferMeta provenance label, and — when the offer is
 * estimated — the no-payment / no-ticket disclosure. The whole card links to
 * the flight Detail_Page, carrying the search query string so the detail page
 * reproduces the identical result set and looks the offer up by id (Req 24.10).
 */

/** INR currency formatter shared across the flights surfaces. */
export const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

/**
 * Minutes between an ISO `HH:MM` departure and arrival, treating an arrival that
 * is not after departure as landing the next day. Pure and deterministic, so
 * the results page can sort by it without any clock dependency (Req 24.8).
 */
export function flightDurationMinutes(depart: string, arrive: string): number {
  const toMin = (t: string) => {
    const [h, m] = t.split(":").map((n) => Number.parseInt(n, 10));
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  };
  const d = toMin(depart);
  const a = toMin(arrive);
  const span = a > d ? a - d : a + 24 * 60 - d;
  return span;
}

/** Format a minute count as `Xh Ym` for display. */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function FlightOfferCard({
  offer,
  travellers,
  query,
}: {
  offer: FlightOffer;
  travellers: number;
  query: string;
}) {
  const fare = flightOfferFare(offer.farePerPerson, travellers);
  const duration = flightDurationMinutes(offer.depart, offer.arrive);
  const stopsLabel =
    offer.stops === 0 ? "Non-stop" : offer.stops === 1 ? "1 stop" : `${offer.stops} stops`;
  const href = `/flights/${encodeURIComponent(offer.id)}${query ? `?${query}` : ""}`;

  return (
    <li className="offer-card booking-surface motion-rise">
      <Link className="offer-card__link" href={href}>
        <div className="offer-card__head">
          <div>
            <p className="offer-card__route">
              {offer.origin} <span aria-hidden="true">→</span> {offer.destination}
            </p>
            <p className="offer-card__sub">
              {offer.flightNo} · {offer.cabin}
            </p>
          </div>
          <ProvenanceLabel meta={offer.meta} />
        </div>

        <dl className="offer-card__facts">
          <div>
            <dt>Departs</dt>
            <dd>{offer.depart}</dd>
          </div>
          <div>
            <dt>Arrives</dt>
            <dd>{offer.arrive}</dd>
          </div>
          <div>
            <dt>Duration</dt>
            <dd>{formatDuration(duration)}</dd>
          </div>
          <div>
            <dt>Stops</dt>
            <dd>{stopsLabel}</dd>
          </div>
          <div>
            <dt>Date</dt>
            <dd>{offer.date}</dd>
          </div>
        </dl>

        <div className="offer-card__fare">
          <p className="offer-card__fare-person">
            <span className="offer-card__fare-amount">{inr.format(fare.perPerson)}</span>
            <span className="offer-card__fare-unit"> / person</span>
          </p>
          <p className="offer-card__fare-party">
            {inr.format(fare.party)} for {fare.travellers}{" "}
            {fare.travellers === 1 ? "traveller" : "travellers"}
          </p>
        </div>
      </Link>

      <EstimatedNotice meta={offer.meta} />
    </li>
  );
}
