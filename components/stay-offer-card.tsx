/**
 * StayOfferCard — a single StayOffer rendered as a bookable Offer_Card on the
 * Stays Results_Page (Req 7.1–7.5). Renders on a clean white card surface with
 * green accents and subtle dividers (shared `.offer-card` / `.card` tokens, no
 * glass or dark treatment). Displays the StayOffer fields with a clear price
 * hierarchy (primary nightly price prominent, per-night/total details muted —
 * Req 7.2) and the mandatory OfferMeta provenance label via ProvenanceLabel
 * (Req 7.4). The whole card links to the stay Detail_Page at /stays/[id]
 * (Req 7.3/7.5).
 *
 * Prices and ratings are shown exactly as produced on the server; nothing is
 * fabricated here (Req 4 honesty).
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
   *  detail page reproduces the same result set (Req 7.5). */
  criteriaQuery: string;
}

export default function StayOfferCard({ offer, criteriaQuery }: StayOfferCardProps) {
  const nights = Math.max(1, offer.nights);
  const total = offer.pricePerNight * nights;
  const href = criteriaQuery
    ? `/stays/${encodeURIComponent(offer.id)}?${criteriaQuery}`
    : `/stays/${encodeURIComponent(offer.id)}`;

  return (
    <article className="card offer-card motion-rise">
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

      {/* Price hierarchy (Req 7.2): primary nightly price prominent, the
          per-night unit and multi-night total rendered as muted secondary
          details using the shared price-block tokens. */}
      <div className="offer-card__price">
        <span className="offer-card__price-main">{money(offer.pricePerNight)}</span>
        <span className="offer-card__price-unit">per night</span>
        <span className="offer-card__price-total">
          {money(total)} total for {nights} {nights === 1 ? "night" : "nights"}
        </span>
      </div>

      <ProvenanceLabel meta={offer.meta} />
      <EstimatedNotice meta={offer.meta} />

      <Link href={href} className="cta offer-card__cta">
        View property
      </Link>
    </article>
  );
}
