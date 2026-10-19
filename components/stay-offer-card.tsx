/**
 * StayOfferCard — a single StayOffer rendered as a bookable card on the Stays
 * Results_Page (task 34.1, Req 23.7). Displays the StayOffer fields and the
 * OfferMeta provenance label (via OfferProvenance); for estimated offers it
 * carries the no-payment / no-valid-room disclosure (Req 23.10). The whole card
 * links to the stay Detail_Page at /stays/[id] (Req 23.8).
 *
 * The card is an opaque `booking-surface` (price/detail must be fully legible at
 * ≥4.5:1 contrast — Req 15.4/15.5), not glass. Prices and ratings are shown
 * exactly as produced on the server; nothing is fabricated here (Req 4 honesty).
 */

import Link from "next/link";
import type { StayOffer } from "@/lib/types";
import { ProvenanceLabel, EstimatedNotice } from "./offer-provenance";

/** Format an integer amount as INR-style currency without a decimal tail. */
function money(amount: number): string {
  return `₹${Math.round(amount).toLocaleString("en-IN")}`;
}

export interface StayOfferCardProps {
  offer: StayOffer;
  /** Query string of the active criteria, forwarded to the detail link so the
   *  detail page reproduces the same result set (Req 28.1). */
  criteriaQuery: string;
}

export default function StayOfferCard({ offer, criteriaQuery }: StayOfferCardProps) {
  const nights = Math.max(1, offer.nights);
  const total = offer.pricePerNight * nights;
  const href = criteriaQuery
    ? `/stays/${encodeURIComponent(offer.id)}?${criteriaQuery}`
    : `/stays/${encodeURIComponent(offer.id)}`;

  return (
    <article className="booking-surface offer-card motion-rise">
      <Link href={href} className="offer-card__link">
        <h3 className="offer-card__title">
          {offer.stayStyle} stay in {offer.destination}
        </h3>
      </Link>

      <dl className="offer-card__facts">
        <div>
          <dt>Style</dt>
          <dd>{offer.stayStyle}</dd>
        </div>
        <div>
          <dt>Nights</dt>
          <dd>{nights}</dd>
        </div>
        <div>
          <dt>Per night</dt>
          <dd>{money(offer.pricePerNight)}</dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd>
            {money(total)} <span className="offer-card__muted">for {nights} nights</span>
          </dd>
        </div>
      </dl>

      {offer.representative && (
        <p className="offer-card__note">Representative photo — not the exact property image.</p>
      )}

      {offer.meta.reviewSummary ? (
        <p className="offer-card__reviews">
          {offer.meta.reviewSummary.rating.toFixed(1)} ({offer.meta.reviewSummary.count} reviews,{" "}
          {offer.meta.reviewSummary.source})
        </p>
      ) : null}

      <ProvenanceLabel meta={offer.meta} />
      <EstimatedNotice meta={offer.meta} />

      <Link href={href} className="cta offer-card__cta">
        View property
      </Link>
    </article>
  );
}
