import type { Metadata } from "next";
import Link from "next/link";
import { parseCriteria, serializeCriteria, type FlightsCriteria } from "@/lib/search-criteria";
import { runSearch } from "@/lib/search";
import type { FlightOffer } from "@/lib/types";
import type { InventoryQuery } from "@/lib/inventory-adapter";
import { flightOfferFare } from "@/lib/workspace";
import { ProvenanceLabel, EstimatedNotice } from "@/components/offer-provenance";
import {
  inr,
  flightDurationMinutes,
  formatDuration,
} from "@/components/flight-offer-card";

export const metadata: Metadata = { title: "Flight detail - TripGenie" };

/**
 * Flight Detail_Page (server component) — design "Booking Site ▸ Detail_Page".
 *
 * Reproduces the flights search from the URL `Search_Criteria` (Req 28.1), looks
 * up the selected `FlightOffer` by its `[id]` within that result set, and renders
 * the full flight detail with its OfferMeta provenance label (Req 24.11). When
 * the offer is estimated, the page carries the no-payment / no-ticket disclosure
 * (Req 24.12); review content renders only when attributable (Req 4.12/4.13).
 *
 * Requirements: 24.10, 24.11, 24.12.
 */

type RawSearchParams = Record<string, string | string[] | undefined>;

function firstValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

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

function toInventoryQuery(c: FlightsCriteria): InventoryQuery {
  return {
    origin: c.origin,
    destination: c.destination,
    cabin: c.cabin,
    stayStyle: "Standard",
    nights: 1,
  };
}

export default async function FlightDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const { id } = await params;
  const raw = await searchParams;

  const criteria = parseCriteria("flights", serializeRaw(raw)) as FlightsCriteria;
  const result = runSearch(toInventoryQuery(criteria));
  const offerId = decodeURIComponent(id);
  const offer: FlightOffer | undefined = result.flights.find((f) => f.id === offerId);

  const query = serializeCriteria(criteria);
  const backHref = `/flights${query ? `?${query}` : ""}`;

  if (!offer) {
    return (
      <main className="shell detail">
        <p className="eyebrow">Flights</p>
        <h1>Flight not available</h1>
        <p className="lead">
          This flight is no longer part of the current results. Return to the
          results to pick another flight.
        </p>
        <Link className="cta" href={backHref}>
          Back to flights
        </Link>
      </main>
    );
  }

  const fare = flightOfferFare(offer.farePerPerson, criteria.travellers);
  const duration = flightDurationMinutes(offer.depart, offer.arrive);
  const stopsLabel =
    offer.stops === 0 ? "Non-stop" : offer.stops === 1 ? "1 stop" : `${offer.stops} stops`;
  const review = offer.meta.reviewSummary;

  return (
    <main className="shell detail">
      <Link className="detail__back" href={backHref}>
        <span aria-hidden="true">←</span> Back to flights
      </Link>

      <header className="detail__head">
        <p className="eyebrow">Flight detail</p>
        <h1>
          {offer.origin} <span aria-hidden="true">→</span> {offer.destination}
        </h1>
        <p className="detail__sub">
          {offer.flightNo} · {offer.cabin} · {stopsLabel}
        </p>
        <ProvenanceLabel meta={offer.meta} />
      </header>

      <section className="detail__body card motion-rise">
        <dl className="detail__facts">
          <div>
            <dt>Flight</dt>
            <dd>{offer.flightNo}</dd>
          </div>
          <div>
            <dt>Date</dt>
            <dd>{offer.date}</dd>
          </div>
          <div>
            <dt>Departs</dt>
            <dd>
              {offer.depart} · {offer.origin}
            </dd>
          </div>
          <div>
            <dt>Arrives</dt>
            <dd>
              {offer.arrive} · {offer.destination}
            </dd>
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
            <dt>Cabin</dt>
            <dd>{offer.cabin}</dd>
          </div>
          <div>
            <dt>Trip type</dt>
            <dd>{criteria.tripType === "round-trip" ? "Round-trip" : "One-way"}</dd>
          </div>
        </dl>

        <div className="detail__fare">
          <p className="detail__fare-person">
            <span className="offer-card__fare-amount">{inr.format(fare.perPerson)}</span>
            <span className="offer-card__fare-unit"> / person</span>
          </p>
          <p className="detail__fare-party">
            {inr.format(fare.party)} total for {fare.travellers}{" "}
            {fare.travellers === 1 ? "traveller" : "travellers"}
          </p>
        </div>

        {review && (
          <section className="detail__review" aria-label="Traveller reviews">
            <h2>Reviews</h2>
            <p>
              {review.rating.toFixed(1)} / 5 from {review.count} reviews ·{" "}
              {review.source}
            </p>
          </section>
        )}

        <EstimatedNotice meta={offer.meta} />
      </section>
    </main>
  );
}
