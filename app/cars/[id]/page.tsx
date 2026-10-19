import Link from "next/link";

import { parseCriteria, serializeCriteria, type CarsCriteria } from "@/lib/search-criteria";
import { runSearch } from "@/lib/search";
import type { InventoryQuery } from "@/lib/inventory-adapter";
import type { CarOffer } from "@/lib/types";
import ProvenanceLabel from "@/components/provenance-label";

export const metadata = { title: "Car detail - TripGenie" };

/**
 * Car Detail_Page (server component) — design "Booking Site ▸ Detail_Page",
 * Req 25.9/25.10/25.11.
 *
 * The offer is looked up by the `[id]` route param within the result set of the
 * same `Search_Criteria` carried on the URL — so the detail page reproduces the
 * identical offer the Results_Page produced (Req 25.6 / 28.1 discipline). It
 * renders the full car offer detail and the mandatory `OfferMeta` provenance
 * label (Req 25.10); when the provenance is estimated the page states no payment
 * is taken and no valid rental is issued (Req 25.11). A detail page is a core
 * booking surface, so it renders opaque at ≥4.5:1 contrast via `booking-surface`
 * (Req 15.4/15.5).
 */

type RouteParams = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v ?? undefined;
}

function queryStringFrom(params: Record<string, string | string[] | undefined>): string {
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const flat = one(value);
    if (flat !== undefined && flat !== "") p.set(key, flat);
  }
  return p.toString();
}

function rentalDaysFromCriteria(c: CarsCriteria): number {
  if (!c.pickupDate || !c.returnDate) return 1;
  const start = Date.parse(c.pickupDate);
  const end = Date.parse(c.returnDate);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 1;
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.max(1, Math.round((end - start) / dayMs));
}

function toInventoryQuery(c: CarsCriteria): InventoryQuery {
  return {
    origin: "",
    destination: c.pickupLocation,
    cabin: "Economy",
    stayStyle: "Comfort",
    nights: rentalDaysFromCriteria(c),
    pickupLocation: c.pickupLocation,
    dropoffLocation: c.dropoffLocation,
    rentalDays: rentalDaysFromCriteria(c),
  };
}

function money(n: number): string {
  return `₹${n.toLocaleString("en-IN")}`;
}

export default async function CarDetailPage({
  params,
  searchParams,
}: {
  params: RouteParams;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const raw = await searchParams;
  const qs = queryStringFrom(raw);

  const criteria = parseCriteria("cars", qs) as CarsCriteria;
  const canonicalQs = serializeCriteria(criteria);
  const backHref = `/cars${canonicalQs ? `?${canonicalQs}` : ""}`;

  const hasSearch = criteria.pickupLocation.trim().length > 0;
  const offer: CarOffer | undefined = hasSearch
    ? runSearch(toInventoryQuery(criteria)).cars.find((c) => c.id === id)
    : undefined;

  if (!offer) {
    return (
      <main className="shell car-detail motion-rise">
        <p className="eyebrow">Car rental</p>
        <h1>Car not found</h1>
        <p className="lead" role="note">
          We couldn&apos;t reproduce that rental car from the current search.
          It may have expired — rerun your search to see fresh offers.
        </p>
        <Link href={backHref} className="cta">
          Back to results
        </Link>
      </main>
    );
  }

  const total = offer.pricePerDay * offer.days;

  return (
    <main className="shell car-detail motion-rise">
      <p className="eyebrow">Car rental</p>
      <Link href={backHref} className="inline-link detail-back">
        ← Back to results
      </Link>

      <h1>{offer.carClass}</h1>
      <p className="lead">
        {offer.transmission[0].toUpperCase() + offer.transmission.slice(1)} ·{" "}
        {offer.seats} seats · {offer.days} {offer.days === 1 ? "day" : "days"}
      </p>

      {/* Full offer detail on an opaque, legible surface (Req 15.4/15.5, 25.10). */}
      <section className="booking-surface detail-panel" aria-label="Rental car detail">
        <dl className="detail-facts">
          <div className="row">
            <dt>Car class</dt>
            <dd>{offer.carClass}</dd>
          </div>
          <div className="row">
            <dt>Transmission</dt>
            <dd>{offer.transmission[0].toUpperCase() + offer.transmission.slice(1)}</dd>
          </div>
          <div className="row">
            <dt>Seats</dt>
            <dd>{offer.seats}</dd>
          </div>
          <div className="row">
            <dt>Pickup location</dt>
            <dd>{offer.pickupLocation}</dd>
          </div>
          <div className="row">
            <dt>Drop-off location</dt>
            <dd>{offer.dropoffLocation}</dd>
          </div>
          <div className="row">
            <dt>Rental length</dt>
            <dd>
              {offer.days} {offer.days === 1 ? "day" : "days"}
            </dd>
          </div>
          <div className="row">
            <dt>Price per day</dt>
            <dd>{money(offer.pricePerDay)}</dd>
          </div>
          <div className="row">
            <dt>Estimated total</dt>
            <dd>{money(total)}</dd>
          </div>
        </dl>
      </section>

      {/* Mandatory provenance label (Req 25.10); estimated carries the
          no-payment / no-rental disclosure (Req 25.11). */}
      <div className="detail-provenance">
        <ProvenanceLabel meta={offer.meta} />
      </div>

      {offer.meta.reviewSummary ? (
        <section className="booking-surface detail-reviews" aria-label="Reviews">
          <h2>Reviews</h2>
          <p>
            {offer.meta.reviewSummary.rating.toFixed(1)} / 5 from{" "}
            {offer.meta.reviewSummary.count.toLocaleString("en-IN")} reviews ·{" "}
            {offer.meta.reviewSummary.source}
          </p>
        </section>
      ) : null}
    </main>
  );
}
