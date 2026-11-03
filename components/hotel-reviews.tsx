"use client";

import { useState } from "react";

/**
 * HotelReviews - on-demand REAL Google reviews for one hotel. Fetches
 * /api/place-details only when expanded (so 30+ hotels do not each call
 * upfront), then shows up to three attributable Google reviews.
 */
interface ReviewItem { author: string; rating: number; text: string; }

export default function HotelReviews({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [items, setItems] = useState<ReviewItem[]>([]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !loaded && !loading) {
      setLoading(true);
      fetch("/api/place-details?" + new URLSearchParams({ name }).toString())
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
        .then((d: { google?: { reviews?: { items?: ReviewItem[] } } | null }) => {
          setItems(d.google?.reviews?.items ?? []);
        })
        .catch(() => setItems([]))
        .finally(() => { setLoaded(true); setLoading(false); });
    }
  }

  return (
    <div className="hotel-reviews">
      <button type="button" className="hotel-reviews__toggle" onClick={toggle} aria-expanded={open}>
        {open ? "Hide" : "Reviews"}
      </button>
      {open && (
        loading ? (
          <p className="hotel-reviews__status">Loading reviews&hellip;</p>
        ) : items.length === 0 ? (
          <p className="hotel-reviews__status">No verified Google reviews yet.</p>
        ) : (
          <ul className="hotel-reviews__list">
            {items.map((rv, i) => (
              <li key={rv.author + "-" + i} className="hotel-reviews__item">
                <span className="hotel-reviews__head"><strong>{rv.author}</strong> <span className="hotel-reviews__stars">&#9733; {rv.rating.toFixed(1)}</span></span>
                <p className="hotel-reviews__text">{rv.text}</p>
              </li>
            ))}
            <li className="hotel-reviews__attr">Reviews from Google</li>
          </ul>
        )
      )}
    </div>
  );
}
