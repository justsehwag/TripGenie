"use client";

/**
 * Stays results (client) - design "10. UI components" / task 11.9.
 *
 * Owns the Stays View_State for one Results_Page. It receives the server's
 * initial parse plus either the live hotels OR the estimate stays (never both,
 * per Req 6.1 / 10.6) and runs the pure view engine on them:
 *
 *   effectiveStaysView -> filterStays -> scoreStays -> sortStays -> page
 *
 * then computes the AI_Pick over the filtered set and renders the toolbar plus
 * the matching list (the live Hotel_List or the estimate grid). Every view
 * change is applied in memory and written to the URL with
 * `window.history.replaceState`, so sorting, filtering and "Show more" never
 * trigger a server round trip or a network call (Req 6.1, 12.1, 12.2). The
 * criteria parameters already in the URL are preserved; only the view
 * parameters are rewritten from the serialised view.
 *
 * Requirements: 6.1, 10.1, 10.6, 10.7, 10.8, 12.1, 12.2, 14.3, 14.4, 14.8,
 * 16.3, 16.4, 18.4, 19.2, 21.5.
 */

import { useMemo, useState } from "react";
import {
  PAGE_SIZE,
  effectiveStaysView,
  filterStays,
  page,
  serializeStaysView,
  sortStays,
  staysCaps,
  staysFilterPills,
  clearAllFilters,
  type StaysView,
  type StayItem,
} from "@/lib/results-view";
import { pickStay, scoreStays } from "@/lib/pick-engine";
import ResultsToolbar from "@/components/results-toolbar";
import LiveHotelResults, { type LiveHotelCriteria } from "@/components/live-hotel-results";
import StayOfferCard from "@/components/stay-offer-card";
import type { LiveHotel } from "@/lib/providers/serpapi-hotels";
import type { StayOffer } from "@/lib/types";

export interface StaysResultsProps {
  /** True for the live Hotel_List, false for the estimate grid. Never both. */
  live: boolean;
  /** Live hotels when `live` is true. */
  liveHotels?: LiveHotel[];
  /** Estimate stays when `live` is false. */
  estimateOffers?: StayOffer[];
  /** The View_State parsed on the server from the URL. */
  initialView: StaysView;
  /** Serialised active criteria, forwarded to each estimate card's detail link. */
  criteriaQuery: string;
  /** Booking criteria passed through to the live Hotel_List. */
  liveCriteria?: LiveHotelCriteria;
  currency: string;
  nights: number;
  provider: string;
  checkedAt: string;
  checkedLabel: string;
}

/** Map a live hotel to the view engine's normalised `StayItem`. */
function hotelToItem(hotel: LiveHotel, index: number): StayItem {
  return {
    key: hotel.token,
    order: index,
    price: hotel.ratePerNight,
    rating: hotel.rating,
    reviews: hotel.reviews,
    hotelClass: hotel.hotelClass,
    style: null,
    freeCancellation: hotel.freeCancellation,
    locationRating: hotel.locationRating,
    amenityCount: hotel.amenityCount,
  };
}

/** Narrow a free-form estimate style string to the view engine's style union. */
function toStayStyle(style: string): StayItem["style"] {
  return style === "Budget" || style === "Comfort" || style === "Luxury" ? style : null;
}

/** Map an estimate stay to the view engine's normalised `StayItem`. */
function offerToItem(offer: StayOffer, index: number): StayItem {
  return {
    key: offer.id,
    order: index,
    price: offer.pricePerNight,
    rating: null,
    reviews: null,
    hotelClass: null,
    style: toStayStyle(offer.stayStyle),
    freeCancellation: null,
    locationRating: null,
    amenityCount: null,
  };
}

/**
 * Rewrite the view parameters in the browser URL without a server round trip,
 * keeping every criteria parameter already present (Req 12.1, 12.2). Any
 * parameter the stays view owns is cleared first, then the serialised view is
 * merged on top, so a cleared filter disappears from the URL.
 */
function writeViewToUrl(view: StaysView): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const next = serializeStaysView(view);
  const owned = ["sort", "stayStyle", "minPrice", "maxPrice", "minRating", "freeCancel", "show"];
  for (const key of owned) url.searchParams.delete(key);
  for (const [key, value] of next) url.searchParams.append(key, value);
  window.history.replaceState(window.history.state, "", url.toString());
}

export default function StaysResults(props: StaysResultsProps) {
  const {
    live,
    liveHotels,
    estimateOffers,
    initialView,
    criteriaQuery,
    liveCriteria,
    currency,
    nights,
    provider,
    checkedAt,
    checkedLabel,
  } = props;

  const [view, setView] = useState<StaysView>(initialView);

  // Normalise the Result_Set once; it never changes after the server render.
  const items = useMemo<StayItem[]>(
    () =>
      live
        ? (liveHotels ?? []).map(hotelToItem)
        : (estimateOffers ?? []).map(offerToItem),
    [live, liveHotels, estimateOffers],
  );

  const caps = useMemo(() => staysCaps(items, live), [items, live]);

  // effectiveStaysView -> filterStays -> scoreStays -> sortStays -> page.
  const effView = useMemo(() => effectiveStaysView(view, caps), [view, caps]);
  const filtered = useMemo(() => filterStays(items, effView), [items, effView]);
  const pick = useMemo(() => pickStay(filtered, { estimated: !live }), [filtered, live]);
  const scores = useMemo(() => scoreStays(filtered), [filtered]);
  const sorted = useMemo(() => sortStays(filtered, effView, scores), [filtered, effView, scores]);
  const { visible, hasMore } = useMemo(() => page(sorted, effView.show), [sorted, effView.show]);

  function applyView(nextRaw: StaysView): void {
    setView(nextRaw);
    writeViewToUrl(nextRaw);
  }

  function showMore(): void {
    applyView({ ...view, show: view.show + PAGE_SIZE });
  }

  // Active filters (named for the empty state), and whether the Result_Set has
  // offers at all. An empty state only appears when filters hide a non-empty
  // Result_Set (Req 18.4); an empty Result_Set is the parent's concern.
  const pills = useMemo(() => staysFilterPills(effView), [effView]);
  const filteredToNothing = items.length > 0 && filtered.length === 0;

  return (
    <section className="stays-results">
      <ResultsToolbar
        kind="stays"
        view={view}
        onChange={applyView}
        caps={caps}
        totalCount={filtered.length}
        shownCount={visible.length}
        countNoun="stays"
      />

      {filteredToNothing ? (
        <div className="results-empty" role="status">
          <p className="results-empty__text">
            No stays match your current filters
            {pills.length > 0 ? <> ({pills.map((p) => p.label).join(", ")})</> : null}.
          </p>
          <button
            type="button"
            className="cta results-empty__clear"
            onClick={() => applyView(clearAllFilters(view))}
          >
            Clear filters
          </button>
        </div>
      ) : live ? (
        <LiveHotelResults
          hotels={visibleLiveHotels(visible, liveHotels ?? [])}
          criteria={liveCriteria ?? emptyLiveCriteria()}
          currency={currency}
          nights={nights}
          provider={provider}
          checkedAt={checkedAt}
          checkedLabel={checkedLabel}
          pickToken={pick?.key}
          pickReason={pick?.reason}
        />
      ) : (
        <ul className="stay-offer-grid" aria-label="Estimated stays">
          {visibleEstimateOffers(visible, estimateOffers ?? []).map((offer) => (
            <li key={offer.id}>
              <StayOfferCard
                offer={offer}
                criteriaQuery={criteriaQuery}
                pick={pick && pick.key === offer.id ? { reason: pick.reason } : undefined}
              />
            </li>
          ))}
        </ul>
      )}

      {hasMore && !filteredToNothing && (
        <div className="results-more">
          <button type="button" className="cta results-more__btn" onClick={showMore}>
            Show more
          </button>
        </div>
      )}
    </section>
  );
}

/** The live hotels for the visible items, in the sorted/paged order (by token). */
function visibleLiveHotels(visible: StayItem[], hotels: LiveHotel[]): LiveHotel[] {
  const byToken = new Map(hotels.map((h) => [h.token, h]));
  const out: LiveHotel[] = [];
  for (const item of visible) {
    const hotel = byToken.get(item.key);
    if (hotel) out.push(hotel);
  }
  return out;
}

/** The estimate offers for the visible items, in the sorted/paged order (by id). */
function visibleEstimateOffers(visible: StayItem[], offers: StayOffer[]): StayOffer[] {
  const byId = new Map(offers.map((o) => [o.id, o]));
  const out: StayOffer[] = [];
  for (const item of visible) {
    const offer = byId.get(item.key);
    if (offer) out.push(offer);
  }
  return out;
}

/** A blank criteria object for the degenerate case where live has no criteria. */
function emptyLiveCriteria(): LiveHotelCriteria {
  return { destination: "", checkIn: "", checkOut: "", adults: 1, rooms: 1 };
}
