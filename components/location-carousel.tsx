"use client";

import { useEffect, useRef, useState } from "react";

/**
 * LocationCarousel - a small auto-advancing image carousel for a plan location.
 * Fetches up to four real photos for the query from the existing /api/image
 * route (Wikipedia thumbnail + Picsum fallback), cross-fades every 5s, pauses
 * on hover/focus, and honors prefers-reduced-motion. Reuses existing card/image
 * classes; adds no new design token.
 */
export default function LocationCarousel({ query, seed = 0 }: { query: string; seed?: number }) {
  const [urls, setUrls] = useState<string[]>([]);
  const [i, setI] = useState(0);
  const pausedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const q = query.trim();
    if (!q) { setUrls([]); return; }
    const base = Math.max(0, Math.trunc(seed)) * 4;
    const slots = [base, base + 1, base + 2, base + 3];
    Promise.all(
      slots.map((s) =>
        fetch("/api/image?" + new URLSearchParams({ kind: "destination", query: q, slot: String(s) }).toString())
          .then((r) => (r.ok ? r.json() : null))
          .then((d: { url?: string } | null) => (d && typeof d.url === "string" ? d.url : null))
          .catch(() => null),
      ),
    ).then((res) => {
      if (cancelled) return;
      const uniq = Array.from(new Set(res.filter((u): u is string => Boolean(u))));
      setUrls(uniq);
      setI(0);
    });
    return () => { cancelled = true; };
  }, [query, seed]);

  useEffect(() => {
    if (urls.length < 2) return;
    const reduce = typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;
    if (reduce) return;
    const id = window.setInterval(() => {
      if (pausedRef.current) return;
      setI((prev) => (prev + 1) % urls.length);
    }, 5000);
    return () => window.clearInterval(id);
  }, [urls]);

  if (urls.length === 0) return null;

  return (
    <div
      className="loc-carousel"
      onMouseEnter={() => { pausedRef.current = true; }}
      onMouseLeave={() => { pausedRef.current = false; }}
      onFocusCapture={() => { pausedRef.current = true; }}
      onBlurCapture={() => { pausedRef.current = false; }}
      aria-roledescription="carousel"
      aria-label={"Photos of " + query}
    >
      <div className="loc-carousel__stage">
        {urls.map((u, idx) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={u}
            className={"loc-carousel__img" + (idx === i ? " is-active" : "")}
            src={u}
            alt={idx === i ? ("View of " + query) : ""}
            loading="lazy"
            aria-hidden={idx !== i}
          />
        ))}
      </div>
      {urls.length > 1 && (
        <div className="loc-carousel__dots" role="tablist" aria-label="Choose photo">
          {urls.map((u, idx) => (
            <button
              key={u}
              type="button"
              className={"loc-carousel__dot" + (idx === i ? " is-active" : "")}
              aria-label={"Show photo " + (idx + 1)}
              aria-selected={idx === i}
              role="tab"
              onClick={() => setI(idx)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

