"use client";

/**
 * Client imagery helper for the Hopper-style homepage.
 *
 * `useDestinationImage` fetches `/api/image?kind=destination&query=<q>&slot=<n>`
 * on mount and returns the resolved `{ url, label }`. While the request is in
 * flight — or if it throws / returns a non-OK status — the hook reports `url:
 * null` so callers can render a CSS gradient placeholder instead. The API's
 * `label` is preferred for alt text, falling back to the query string.
 *
 * `DestinationImageLayer` renders the resolved photo as an absolutely-positioned
 * background image (object-fit: cover) with a gradient placeholder underneath,
 * so a missing/slow image never leaves an empty box and never shifts layout.
 */

import { useEffect, useState } from "react";

export interface DestinationImage {
  /** Resolved image URL, or null while loading / on failure (render a gradient). */
  url: string | null;
  /** Alt text — the API label when available, else the query. */
  alt: string;
}

/** Fetch a destination photo for a given query + slot; gradient fallback on failure. */
export function useDestinationImage(query: string, slot: number): DestinationImage {
  const [state, setState] = useState<DestinationImage>({ url: null, alt: query });

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({
      kind: "destination",
      query,
      slot: String(slot),
    });
    fetch(`/api/image?${params.toString()}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: { url?: string; label?: string }) => {
        if (cancelled) return;
        if (data && typeof data.url === "string") {
          setState({ url: data.url, alt: data.label || query });
        }
      })
      .catch(() => {
        // Leave url: null so the caller keeps its gradient placeholder.
        if (!cancelled) setState((s) => ({ url: null, alt: s.alt }));
      });
    return () => {
      cancelled = true;
    };
  }, [query, slot]);

  return state;
}

/**
 * A full-bleed image layer with a gradient placeholder underneath. Intended to
 * sit inside a `position: relative` container (hero / destination card / deal
 * card). Renders solid image backgrounds (NOT glass), per the visible-surface
 * glass budget.
 */
export function DestinationImageLayer({
  query,
  slot,
  className = "",
}: {
  query: string;
  slot: number;
  className?: string;
}) {
  const { url, alt } = useDestinationImage(query, slot);
  return (
    <div className={`img-layer ${className}`.trim()} aria-hidden={!url}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="img-layer__img" src={url} alt={alt} loading="lazy" />
      ) : null}
    </div>
  );
}
