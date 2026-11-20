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

import { useCallback, useEffect, useState } from "react";
import type { SizeClass } from "@/lib/wiki-image-policy";

export interface DestinationImage {
  /** Resolved image URL, or null while loading / on failure (render a gradient). */
  url: string | null;
  /** `<1x url> 1x, <2x url> 2x` when the route returned one; otherwise undefined. */
  srcSet: string | undefined;
  /** Alt text — the API label when available, else the query. */
  alt: string;
  /** Wire to `<img onError>`: drops the failed URL so the Image_Fallback shows (Req 11.10). */
  onError: () => void;
}

/** The route's `url` when it is a non-empty string; null for `url: null` or anything else (Req 11.10). */
export function usableImageUrl(data: unknown): string | null {
  const u = data && typeof data === "object" ? (data as { url?: unknown }).url : null;
  return typeof u === "string" && u.trim() !== "" ? u : null;
}

/** The route's `srcset` when it is a non-empty string; undefined otherwise. */
export function usableSrcSet(data: unknown): string | undefined {
  const s = data && typeof data === "object" ? (data as { srcset?: unknown }).srcset : undefined;
  return typeof s === "string" && s.trim() !== "" ? s : undefined;
}

/** Fetch a destination photo for a given query + slot; gradient fallback on failure. */
export function useDestinationImage(
  query: string,
  slot: number,
  size: SizeClass = "card",
): DestinationImage {
  const [state, setState] = useState<{ url: string | null; srcSet: string | undefined; alt: string }>({
    url: null,
    srcSet: undefined,
    alt: query,
  });

  useEffect(() => {
    let cancelled = false;
    setState({ url: null, srcSet: undefined, alt: query });
    const params = new URLSearchParams({
      kind: "destination",
      query,
      slot: String(slot),
      size,
    });
    fetch(`/api/image?${params.toString()}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: { url?: string | null; label?: string }) => {
        if (cancelled) return;
        const u = usableImageUrl(data);
        // `url: null` keeps the Image_Fallback; never an <img> with a null src.
        setState({ url: u, srcSet: u ? usableSrcSet(data) : undefined, alt: (data && data.label) || query });
      })
      .catch(() => {
        // Leave url: null so the caller keeps its gradient placeholder.
        if (!cancelled) setState((s) => ({ url: null, srcSet: undefined, alt: s.alt }));
      });
    return () => {
      cancelled = true;
    };
  }, [query, slot, size]);

  const onError = useCallback(() => setState((s) => ({ url: null, srcSet: undefined, alt: s.alt })), []);
  return { url: state.url, srcSet: state.srcSet, alt: state.alt, onError };
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
  const { url, srcSet, alt, onError } = useDestinationImage(query, slot, "card");
  return (
    <div className={`img-layer ${className}`.trim()} aria-hidden={!url}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="img-layer__img" src={url} srcSet={srcSet} alt={alt} loading="lazy" onError={onError} />
      ) : null}
    </div>
  );
}
