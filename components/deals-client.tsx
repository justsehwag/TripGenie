"use client";

/**
 * DealsClient (Req 26) — the client half of the Deals_Page.
 *
 * Owns the category-filter state (Req 26.3/26.4): selecting a category control
 * re-renders both the editorial body and the bookable-offer body to show only
 * the content tagged with that category (or everything under "All"). No
 * navigation happens on a category change — it is pure client state.
 *
 * The page keeps EDITORIAL recommendation content and BOOKABLE offer content in
 * two visibly distinct regions (Req 26.2): editorial uses the warm `glass`
 * accent cards and carries no price/provenance/savings; bookable offers use the
 * opaque `booking-surface` and each carries its `OfferMeta` provenance label
 * (Req 26.5) plus — only when supplied by the page from the Promotions_Engine —
 * a savings value (Req 26.6). Selecting a bookable offer follows its serialized
 * Results_Page link (Req 26.7).
 *
 * The footer is rendered once by app/layout.tsx (Req 26.8) — not here.
 */

import { useMemo, useState } from "react";

export type DealsCategory = "all" | "stays" | "flights" | "cars";

/** A non-bookable editorial idea — featured destination or seasonal inspiration. */
export interface EditorialItem {
  id: string;
  group: "featured" | "seasonal";
  /** Booking category this idea inspires; drives the category filter. */
  category: "stays" | "flights" | "cars";
  title: string;
  blurb: string;
}

/** OfferMeta provenance flattened for rendering (Req 26.5). */
export interface OfferProvenance {
  provider: string;
  mode: "live" | "estimated" | "cached" | "demo";
  retrievedAt: string;
  expiresAt: string;
  disclaimer: string;
}

/** A bookable offer: carries provenance always, savings only if produced by the engine. */
export interface BookableOffer {
  id: string;
  category: "stays" | "flights" | "cars";
  title: string;
  detail: string;
  priceLabel: string;
  gross: number;
  /** Serialized Results_Page link (Req 26.7). */
  href: string;
  provenance: OfferProvenance;
  /** Present iff the Promotions_Engine produced a discount (Req 26.6). */
  savings?: { amount: number; code: string; payable: number };
}

const CATEGORY_LABEL: Record<DealsCategory, string> = {
  all: "All",
  stays: "Stays",
  flights: "Flights",
  cars: "Cars",
};

/** Human label for a provenance mode, used in the offer badge (Req 26.5). */
function modeLabel(mode: OfferProvenance["mode"]): string {
  switch (mode) {
    case "live":
      return "Live quote";
    case "estimated":
      return "Estimated";
    case "cached":
      return "Cached";
    case "demo":
      return "Demo";
  }
}

/** Provenance badge + disclaimer rendered on every bookable offer (Req 26.5). */
function ProvenanceLabel({ provenance }: { provenance: OfferProvenance }) {
  return (
    <div className={`offer-provenance offer-provenance--${provenance.mode}`}>
      <span className="offer-provenance__badge">{modeLabel(provenance.mode)}</span>
      <span className="offer-provenance__provider">via {provenance.provider}</span>
      <p className="offer-provenance__disclaimer">{provenance.disclaimer}</p>
    </div>
  );
}

export default function DealsClient({
  categories,
  editorial,
  offers,
}: {
  categories: DealsCategory[];
  editorial: EditorialItem[];
  offers: BookableOffer[];
}) {
  const [active, setActive] = useState<DealsCategory>("all");

  const inCategory = (c: "stays" | "flights" | "cars") => active === "all" || active === c;

  const featured = useMemo(
    () => editorial.filter((e) => e.group === "featured" && inCategory(e.category)),
    [editorial, active],
  );
  const seasonal = useMemo(
    () => editorial.filter((e) => e.group === "seasonal" && inCategory(e.category)),
    [editorial, active],
  );
  const shownOffers = useMemo(
    () => offers.filter((o) => inCategory(o.category)),
    [offers, active],
  );

  return (
    <main className="shell deals">
      <section className="motion-rise deals-hero">
        <p className="eyebrow">Ideas and honest prices</p>
        <h1 className="display">Deals &amp; inspiration</h1>
        <p className="lead">
          Browse featured destinations and seasonal ideas, then jump to live-style
          estimated offers. We never invent a discount — a saving only appears when
          our promotions engine actually applies one.
        </p>
      </section>

      {/* Category controls (Req 26.3/26.4) — client-only filtering, no navigation */}
      <section className="deals-filters" aria-label="Filter deals by category">
        <div className="chip-row" role="group" aria-label="Deal categories">
          {categories.map((c) => {
            const selected = active === c;
            return (
              <button
                key={c}
                type="button"
                className={`chip${selected ? " chip-active" : ""}`}
                aria-pressed={selected}
                onClick={() => setActive(c)}
              >
                {CATEGORY_LABEL[c]}
              </button>
            );
          })}
        </div>
      </section>

      {/* EDITORIAL region — visibly distinct from bookable offers (Req 26.2) */}
      <div className="deals-editorial" aria-label="Editorial recommendations">
        <p className="deals-region-tag">Editorial · ideas, not bookings</p>

        {/* Featured destinations (Req 26.1) */}
        <section className="deals-section motion-rise" aria-labelledby="deals-featured-heading">
          <h2 id="deals-featured-heading">Featured destinations</h2>
          {featured.length > 0 ? (
            <div className="card-grid">
              {featured.map((item) => (
                <article key={item.id} className="glass editorial-card">
                  <h3>{item.title}</h3>
                  <p>{item.blurb}</p>
                </article>
              ))}
            </div>
          ) : (
            <p className="deals-empty">No featured destinations in this category.</p>
          )}
        </section>

        {/* Seasonal inspiration (Req 26.1) */}
        <section className="deals-section motion-rise" aria-labelledby="deals-seasonal-heading">
          <h2 id="deals-seasonal-heading">Seasonal inspiration</h2>
          {seasonal.length > 0 ? (
            <div className="card-grid">
              {seasonal.map((item) => (
                <article key={item.id} className="glass editorial-card">
                  <h3>{item.title}</h3>
                  <p>{item.blurb}</p>
                </article>
              ))}
            </div>
          ) : (
            <p className="deals-empty">No seasonal ideas in this category.</p>
          )}
        </section>
      </div>

      {/* BOOKABLE region — opaque surfaces, provenance + engine-only savings */}
      <div className="deals-bookable" aria-label="Bookable offers">
        <p className="deals-region-tag deals-region-tag--bookable">
          Bookable offers · estimated prices
        </p>

        <section className="deals-section motion-rise" aria-labelledby="deals-offers-heading">
          <h2 id="deals-offers-heading">Offers</h2>
          {shownOffers.length > 0 ? (
            <div className="card-grid">
              {shownOffers.map((offer) => (
                <article key={offer.id} className="booking-surface offer-card">
                  <div className="offer-card__head">
                    <h3>{offer.title}</h3>
                    <span className="offer-card__cat">{CATEGORY_LABEL[offer.category]}</span>
                  </div>
                  <p className="offer-card__detail">{offer.detail}</p>
                  <p className="offer-card__price">{offer.priceLabel}</p>

                  {/* Savings shown ONLY when the Promotions_Engine produced one (Req 26.6) */}
                  {offer.savings && (
                    <p className="offer-card__savings">
                      Save INR {offer.savings.amount.toLocaleString("en-IN")} with{" "}
                      <span className="offer-card__code">{offer.savings.code}</span>
                    </p>
                  )}

                  <ProvenanceLabel provenance={offer.provenance} />

                  {/* Selecting the offer navigates to its Results_Page (Req 26.7) */}
                  <a className="cta offer-card__cta" href={offer.href}>
                    View {CATEGORY_LABEL[offer.category].toLowerCase()}
                  </a>
                </article>
              ))}
            </div>
          ) : (
            <p className="deals-empty">No offers in this category right now.</p>
          )}
        </section>
      </div>
    </main>
  );
}
