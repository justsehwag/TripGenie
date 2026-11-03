"use client";

import { useState } from "react";
import BrandLoader from "@/components/brand-loader";
import type { LiveHotel, HotelBookingOffer, HotelOffersResult } from "@/lib/providers/serpapi-hotels";
import { ProvenanceLabel } from "@/components/offer-provenance";
import type { OfferMeta } from "@/lib/types";

/**
 * Live hotel results (Google Hotels via SerpApi).
 *
 * Renders the server-fetched list of hotels with REAL prices for the searched
 * dates and guests. "Compare & book" lazily loads every booking site's offer
 * for that hotel from /api/hotel-rates/offers; each offer links straight to
 * that site, where the traveller books and pays. TripGenie never takes payment,
 * and every price is labelled with its source and the time it was checked.
 */

export interface LiveHotelCriteria {
  destination: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  rooms: number;
}

type OffersState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; result: HotelOffersResult };

function money(currency: string) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 });
}

function liveMeta(provider: string, checkedAt: string, checkedLabel: string): OfferMeta {
  const at = Date.parse(checkedAt);
  return {
    provider,
    mode: "live",
    retrievedAt: checkedAt,
    expiresAt: new Date((Number.isFinite(at) ? at : 0) + 10 * 60_000).toISOString(),
    disclaimer: `Live price checked ${checkedLabel}. The final price is confirmed on the booking site.`,
  };
}

function Stars({ n }: { n: number }) {
  return <span className="live-hotel__stars" aria-label={`${n}-star hotel`}>{`${n}-star`}</span>;
}

function OfferRow({ offer, fmt }: { offer: HotelBookingOffer; fmt: Intl.NumberFormat }) {
  return (
    <li className="live-offer">
      <span className="live-offer__source">
        {offer.logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="live-offer__logo" src={offer.logo} alt="" width={20} height={20} loading="lazy" referrerPolicy="no-referrer" />
        ) : (
          <span className="live-offer__logo live-offer__logo--blank" aria-hidden="true" />
        )}
        <span className="live-offer__name">{offer.source}</span>
        {offer.official && <span className="live-offer__badge">Official site</span>}
        {offer.freeCancellation && <span className="live-offer__perk">Free cancellation</span>}
      </span>
      <span className="live-offer__price">
        {offer.ratePerNight !== null ? (
          <>
            <span className="live-offer__amount">{fmt.format(offer.ratePerNight)}</span>
            <span className="live-offer__unit"> / night</span>
          </>
        ) : (
          <span className="live-offer__unit">Price shown on site</span>
        )}
        {offer.totalRate !== null && <span className="live-offer__total">{fmt.format(offer.totalRate)} total</span>}
      </span>
      <a
        className="cta live-offer__book"
        href={offer.link}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Book on ${offer.source} (opens in a new tab)`}
      >
        Book on {offer.source}
        <span aria-hidden="true">{" \u2197"}</span>
      </a>
    </li>
  );
}

function HotelCard({
  hotel,
  criteria,
  currency,
  nights,
  provider,
  checkedAt,
  checkedLabel,
  pickReason,
}: {
  hotel: LiveHotel;
  criteria: LiveHotelCriteria;
  currency: string;
  nights: number;
  provider: string;
  checkedAt: string;
  checkedLabel: string;
  /** When set, this hotel is the AI's pick; the reason is shown beside the badge. */
  pickReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<OffersState>({ kind: "idle" });
  const fmt = money(currency);
  const panelId = `live-offers-${hotel.token}`;

  async function load() {
    setState({ kind: "loading" });
    const qs = new URLSearchParams({
      token: hotel.token,
      destination: criteria.destination,
      checkIn: criteria.checkIn,
      checkOut: criteria.checkOut,
      adults: String(criteria.adults),
    });
    try {
      const res = await fetch(`/api/hotel-rates/offers?${qs.toString()}`, { cache: "no-store" });
      const data = (await res.json()) as HotelOffersResult;
      if (data.status !== "live") {
        setState({ kind: "error", message: data.error ?? "Booking options are unavailable right now." });
        return;
      }
      setState({ kind: "ready", result: data });
    } catch {
      setState({ kind: "error", message: "Booking options are unavailable right now." });
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && (state.kind === "idle" || state.kind === "error")) void load();
  }

  return (
    <li className="live-hotel">
      <div className="live-hotel__row">
        <div className="live-hotel__media">
          {hotel.thumbnail ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={hotel.thumbnail} alt={hotel.name} loading="lazy" referrerPolicy="no-referrer" />
          ) : (
            <span className="live-hotel__placeholder" aria-hidden="true" />
          )}
        </div>

        <div className="live-hotel__body">
          {pickReason !== undefined && (
            <p className="live-hotel__pick">
              <span className="ai-pick-badge">AI&apos;s pick</span>
              {pickReason ? <span className="live-hotel__reason">{pickReason}</span> : null}
            </p>
          )}
          <h3 className="live-hotel__name">{hotel.name}</h3>
          <p className="live-hotel__meta">
            {hotel.hotelClass !== null && <Stars n={Math.round(hotel.hotelClass)} />}
            {hotel.rating !== null && (
              <span className="live-hotel__rating">
                {hotel.rating.toFixed(1)}
                {hotel.reviews !== null && ` (${Math.round(hotel.reviews).toLocaleString("en-IN")} reviews)`}
              </span>
            )}
          </p>
          {hotel.description && <p className="live-hotel__desc">{hotel.description}</p>}
          {hotel.amenities.length > 0 && (
            <ul className="live-hotel__amenities" aria-label="Amenities">
              {hotel.amenities.slice(0, 4).map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="live-hotel__price">
          <ProvenanceLabel meta={liveMeta(provider, checkedAt, checkedLabel)} />
          <span className="live-hotel__amount">{fmt.format(hotel.ratePerNight)}</span>
          <span className="live-hotel__unit">per night, incl. taxes &amp; fees</span>
          {hotel.totalRate !== null && (
            <span className="live-hotel__total">
              {fmt.format(hotel.totalRate)} total {"\u00B7"} {nights} {nights === 1 ? "night" : "nights"}
            </span>
          )}
          <span className="live-hotel__checked">Checked {checkedLabel}</span>
          <button
            type="button"
            className="cta live-hotel__compare"
            onClick={toggle}
            aria-expanded={open}
            aria-controls={panelId}
          >
            {open ? "Hide booking options" : "Compare & book"}
          </button>
        </div>
      </div>

      {open && (
        <div id={panelId} className="live-hotel__offers">
          {state.kind === "loading" && (
            <div className="live-hotel__status">
              <BrandLoader label="Checking live prices on booking sites" size={110} />
            </div>
          )}
          {state.kind === "error" && (
            <p className="live-hotel__status live-hotel__status--error" role="alert">
              {state.message}{" "}
              <button type="button" className="btn" onClick={() => void load()}>
                Try again
              </button>
            </p>
          )}
          {state.kind === "ready" &&
            (state.result.offers.length > 0 ? (
              <ul className="live-offer-list" aria-label={`Booking options for ${hotel.name}`}>
                {state.result.offers.map((o) => (
                  <OfferRow key={o.source} offer={o} fmt={fmt} />
                ))}
              </ul>
            ) : (
              <p className="live-hotel__status">
                No bookable rates were returned for these dates.{" "}
                {hotel.website && (
                  <a href={hotel.website} target="_blank" rel="noopener noreferrer">
                    Visit the hotel website{" \u2197"}
                  </a>
                )}
              </p>
            ))}
          <p className="live-hotel__note">
            You book and pay on the site you choose; TripGenie takes no payment. Prices were checked{" "}
            {checkedLabel} for {criteria.adults} {criteria.adults === 1 ? "guest" : "guests"}
            {criteria.rooms > 1 ? ` (${criteria.rooms} rooms requested)` : ""}. The final price, room type and
            cancellation terms are confirmed on that site and can change.
          </p>
        </div>
      )}
    </li>
  );
}

export default function LiveHotelResults({
  hotels,
  criteria,
  currency,
  nights,
  provider,
  checkedAt,
  checkedLabel,
  pickToken,
  pickReason,
}: {
  hotels: LiveHotel[];
  criteria: LiveHotelCriteria;
  currency: string;
  nights: number;
  provider: string;
  checkedAt: string;
  checkedLabel: string;
  /** Token of the hotel the Pick_Engine chose; its card shows the AI badge. */
  pickToken?: string;
  /** Reason shown beside the badge on the picked hotel's card. */
  pickReason?: string;
}) {
  return (
    <ul className="live-hotel-list" aria-label="Stays with live prices">
      {hotels.map((h) => (
        <HotelCard
          key={h.token}
          hotel={h}
          criteria={criteria}
          currency={currency}
          nights={nights}
          provider={provider}
          checkedAt={checkedAt}
          checkedLabel={checkedLabel}
          pickReason={pickToken !== undefined && h.token === pickToken ? pickReason ?? "" : undefined}
        />
      ))}
    </ul>
  );
}