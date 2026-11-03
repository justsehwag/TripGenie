"use client";

import { useEffect, useRef, useState } from "react";

/**
 * GooglePlaceMedia - the day-card hero for the itinerary. Shows ONLY the
 * auto-rotating real Google photos of the day's main place plus its rating.
 * Reviews are intentionally NOT shown here - they belong under each place in
 * the "Know more" detail (so a loosely-matched place never leaks an unrelated
 * review onto the day). Renders nothing on a Google fallback.
 */

interface GoogleBlock {
  rating: number | null;
  userRatingCount: number | null;
  photos: Array<{ src: string; attribution: string }>;
}
interface PlaceDetailsResponse { google?: GoogleBlock | null; }

function withWidth(src: string, w: number): string {
  return src + (src.includes("?") ? "&w=" + w : "?w=" + w);
}

export default function GooglePlaceMedia({ query }: { query: string }) {
  const [google, setGoogle] = useState<GoogleBlock | null>(null);
  const [active, setActive] = useState(0);
  const reqRef = useRef(0);
  const pausedRef = useRef(false);

  useEffect(() => {
    const q = query.trim();
    if (!q) { setGoogle(null); return; }
    const id = ++reqRef.current;
    const t = window.setTimeout(() => {
      fetch("/api/place-details?" + new URLSearchParams({ name: q, attractions: "1" }).toString())
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
        .then((d: PlaceDetailsResponse) => {
          if (reqRef.current !== id) return;
          setGoogle(d.google ?? null);
          setActive(0);
        })
        .catch(() => { if (reqRef.current === id) setGoogle(null); });
    }, 150);
    return () => window.clearTimeout(t);
  }, [query]);

  const photoCount = google?.photos.length ?? 0;
  useEffect(() => {
    if (photoCount < 2) return;
    const reduce = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false;
    if (reduce) return;
    const id = window.setInterval(() => { if (!pausedRef.current) setActive((p) => (p + 1) % photoCount); }, 5000);
    return () => window.clearInterval(id);
  }, [photoCount]);

  if (!google || google.photos.length === 0) return null;
  const photos = google.photos.slice(0, 8);
  const rating = typeof google.rating === "number" && Number.isFinite(google.rating) ? google.rating : null;
  const count = typeof google.userRatingCount === "number" && Number.isFinite(google.userRatingCount) ? google.userRatingCount : null;
  const activeIdx = Math.min(active, photos.length - 1);

  return (
    <div className="gpm">
      <div
        className="gpm__hero img-layer"
        onMouseEnter={() => { pausedRef.current = true; }}
        onMouseLeave={() => { pausedRef.current = false; }}
        aria-roledescription="carousel"
        aria-label={"Photos of " + query}
      >
        {photos.map((p, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={p.src}
            className={"gpm__hero-img" + (i === activeIdx ? " is-active" : "")}
            src={withWidth(p.src, 1280)}
            alt={i === activeIdx ? (query + " - Google photo") : ""}
            loading="lazy"
            aria-hidden={i !== activeIdx}
          />
        ))}
        {rating !== null && (
          <span className="gpm__rating" aria-label={"Google rating " + rating.toFixed(1) + " out of 5"}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 3.5l2.6 5.3 5.9.86-4.25 4.14 1 5.86L12 17.9l-5.25 2.77 1-5.86L3.5 9.66l5.9-.86L12 3.5z" fill="currentColor" />
            </svg>
            {rating.toFixed(1)}{count !== null ? " (" + count.toLocaleString() + ")" : ""}
          </span>
        )}
        <span className="gpm__brand">Google</span>
      </div>
      {photos.length > 1 && (
        <div className="gpm__thumbs" role="tablist" aria-label={"More photos of " + query}>
          {photos.map((p, i) => (
            <button
              key={p.src}
              type="button"
              className={"gpm__thumb" + (i === activeIdx ? " is-active" : "")}
              aria-label={"Show photo " + (i + 1)}
              aria-selected={i === activeIdx}
              role="tab"
              onClick={() => setActive(i)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={withWidth(p.src, 220)} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
