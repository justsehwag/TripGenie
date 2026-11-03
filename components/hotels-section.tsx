"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import HotelReviews from "@/components/hotel-reviews";

/**
 * HotelsSection - 30+ real lodging options for the trip via /api/hotels
 * (Google Places). Shows ONLY real Google ratings/review counts, with sort
 * (rating / price / nearest) and filter (minimum rating, price band). Each
 * hotel also shows an approximate straight-line distance to planned spots.
 */

interface HotelDistance { spot: string; km: number; }
interface Hotel {
  placeId: string;
  name: string;
  rating: number | null;
  userRatingCount: number | null;
  priceLevel: number | null;
  address: string;
  photos: Array<{ src: string; attribution: string }>;
  distances: HotelDistance[];
}

function withWidth(src: string, w: number): string { return src + (src.includes("?") ? "&w=" + w : "?w=" + w); }
function priceBand(level: number | null): string { return level === null ? "" : "$".repeat(Math.max(1, Math.min(4, level + 1))); }
function nearestKm(h: Hotel): number { return h.distances.length ? Math.min(...h.distances.map((d) => d.km)) : Number.POSITIVE_INFINITY; }

type Sort = "rating" | "reviews" | "price-asc" | "price-desc" | "nearest";

export default function HotelsSection({ destination, spots }: { destination: string; spots: string[] }) {
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<Sort>("rating");
  const [minRating, setMinRating] = useState(0);
  const [maxPrice, setMaxPrice] = useState(4);
  const reqRef = useRef(0);

  useEffect(() => {
    const dest = destination.trim();
    if (!dest) { setHotels([]); setLoading(false); return; }
    const id = ++reqRef.current;
    setLoading(true);
    const params = new URLSearchParams({ destination: dest });
    if (spots.length > 0) params.set("spots", spots.slice(0, 8).join(","));
    fetch("/api/hotels?" + params.toString())
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((d: { hotels?: Hotel[] }) => { if (reqRef.current === id) setHotels(Array.isArray(d.hotels) ? d.hotels : []); })
      .catch(() => { if (reqRef.current === id) setHotels([]); })
      .finally(() => { if (reqRef.current === id) setLoading(false); });
  }, [destination, spots]);

  const visible = useMemo(() => {
    // Only REAL ratings: a hotel must have a Google rating to appear.
    let list = hotels.filter((h) => typeof h.rating === "number");
    if (minRating > 0) list = list.filter((h) => (h.rating ?? 0) >= minRating);
    if (maxPrice < 4) list = list.filter((h) => h.priceLevel === null || h.priceLevel <= maxPrice);
    const sorted = [...list];
    if (sort === "rating") sorted.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    else if (sort === "reviews") sorted.sort((a, b) => (b.userRatingCount ?? 0) - (a.userRatingCount ?? 0));
    else if (sort === "price-asc") sorted.sort((a, b) => (a.priceLevel ?? 99) - (b.priceLevel ?? 99));
    else if (sort === "price-desc") sorted.sort((a, b) => (b.priceLevel ?? -1) - (a.priceLevel ?? -1));
    else if (sort === "nearest") sorted.sort((a, b) => nearestKm(a) - nearestKm(b));
    return sorted;
  }, [hotels, sort, minRating, maxPrice]);

  if (loading) {
    return (
      <section className="hotels" aria-busy="true">
        <h2 className="section-title hotels__title">Hotels near your trip</h2>
        <p className="hotels__loading">Finding real stays near {destination}&hellip;</p>
      </section>
    );
  }
  if (hotels.length === 0) return null;

  return (
    <section className="hotels" aria-label="Hotels near your trip">
      <h2 className="section-title hotels__title">Hotels near your trip</h2>
      <p className="eyebrow">{visible.length} real stays from Google near your planned places. Ratings and reviews are real; distances are approximate.</p>

      <div className="hotels__controls card">
        <label className="field"><span>Sort by</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="rating">Top rated</option>
            <option value="reviews">Most reviewed</option>
            <option value="price-asc">Price: low to high</option>
            <option value="price-desc">Price: high to low</option>
            <option value="nearest">Nearest to my plan</option>
          </select>
        </label>
        <label className="field"><span>Min rating</span>
          <select value={minRating} onChange={(e) => setMinRating(Number(e.target.value))}>
            <option value={0}>Any</option>
            <option value={3}>3.0+</option>
            <option value={4}>4.0+</option>
            <option value={4.5}>4.5+</option>
          </select>
        </label>
        <label className="field"><span>Max price</span>
          <select value={maxPrice} onChange={(e) => setMaxPrice(Number(e.target.value))}>
            <option value={4}>Any</option>
            <option value={1}>$</option>
            <option value={2}>$$</option>
            <option value={3}>$$$</option>
          </select>
        </label>
      </div>

      {visible.length === 0 ? (
        <p className="hotels__loading">No hotels match these filters. Try relaxing them.</p>
      ) : (
      <div className="hotels__grid">
        {visible.map((h) => {
          const photo = h.photos[0];
          const nearest = [...h.distances].sort((a, b) => a.km - b.km).slice(0, 3);
          return (
            <article key={h.placeId} className="hotel-card card">
              <div className="hotel-card__media img-layer">
                {photo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="hotel-card__img" src={withWidth(photo.src, 640)} alt={h.name} loading="lazy" />
                ) : <span className="hotel-card__img hotel-card__img--empty" aria-hidden="true" />}
                <span className="hotel-card__rating">&#9733; {(h.rating as number).toFixed(1)}{h.userRatingCount !== null ? " (" + h.userRatingCount.toLocaleString() + ")" : ""}</span>
              </div>
              <div className="hotel-card__body">
                <h3 className="hotel-card__name">{h.name}</h3>
                {priceBand(h.priceLevel) && <span className="hotel-card__price">{priceBand(h.priceLevel)}</span>}
                {h.address && <p className="hotel-card__address">{h.address}</p>}
                {nearest.length > 0 && (
                  <ul className="hotel-card__distances">
                    {nearest.map((d) => (
                      <li key={d.spot} className="hotel-card__distance"><span className="hotel-card__distance-km">~{d.km} km</span> from {d.spot}</li>
                    ))}
                  </ul>
                )}
                <span className="hotel-card__brand">Google</span>
                <HotelReviews name={h.name} />
              </div>
            </article>
          );
        })}
      </div>
      )}
    </section>
  );
}
