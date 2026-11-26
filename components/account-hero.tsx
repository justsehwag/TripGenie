"use client";

/**
 * AccountHero - a cinematic, FULL-SCREEN immersive backdrop for the account
 * page. A real destination photo (via the existing `useDestinationImage` hook)
 * fills the entire viewport behind everything, under layered gradient scrims
 * for depth and legibility, with a slow Ken-Burns zoom, a drifting light bloom,
 * and a subtle animated flight-path arc. The overlaid headline sits bottom-left
 * with a strong scrim so it stays bold and readable over any photo.
 *
 * The card (sign-in or profile) is rendered by the parent as a sibling that
 * floats OVER this backdrop. While the photo loads (or on failure) the hook
 * returns url:null and the backdrop keeps an animated gradient - never an empty
 * box, never layout shift. Purely presentational; client-safe imports only.
 */

import { useEffect, useState } from "react";
import { useDestinationImage } from "@/components/destination-image";

/** Scenic queries; one is chosen per mount so the backdrop varies by visit. */
const HERO_QUERIES = [
  "Santorini greece blue domes sunset",
  "Swiss alps turquoise lake",
  "Kyoto japan temple autumn",
  "Maldives overwater villa turquoise",
  "Banff canada mountain lake",
  "Amalfi coast italy cliffs",
] as const;

export function AccountHero({
  eyebrow,
  title,
  subtitle,
  points = [],
  query: queryProp,
  onImageError,
  onImageLoad,
  media,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  points?: string[];
  /** Optional externally-controlled query (welcome screen rotation). When
   *  omitted, falls back to the internal random pick (unchanged behavior). */
  query?: string;
  /** Optional: called when the hero <img> fails to load. */
  onImageError?: () => void;
  /** Optional: called when the hero <img> finishes loading. */
  onImageLoad?: () => void;
  /** Optional: rendered in place of the photo layer when provided. */
  media?: React.ReactNode;
}) {
  // Choose the query on the client after mount (avoids SSR/CSR mismatch from
  // Math.random, and keeps the first paint a clean gradient).
  const [query, setQuery] = useState<string>(queryProp ?? HERO_QUERIES[0]);
  useEffect(() => {
    if (queryProp !== undefined) return; // externally controlled; skip random pick
    setQuery(HERO_QUERIES[Math.floor(Math.random() * HERO_QUERIES.length)]);
  }, [queryProp]);
  useEffect(() => {
    if (queryProp !== undefined) setQuery(queryProp);
  }, [queryProp]);
  const { url, srcSet, alt, onError } = useDestinationImage(query, 0, "cover");

  return (
    <div className="account-cine" aria-hidden={!url ? undefined : undefined}>
      {/* Full-bleed photo (or animated gradient while loading). */}
      <div className="account-cine__media">
        {media ? (
          media
        ) : url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="account-cine__img" src={url} srcSet={srcSet} alt={alt}
            onError={() => { onError(); onImageError?.(); }}
            onLoad={() => onImageLoad?.()} />
        ) : (
          <div className="account-cine__placeholder" aria-hidden="true" />
        )}
      </div>

      {/* Layered scrims: a global darken for contrast + a bottom-left pool so
          the headline is always legible, plus a drifting warm light bloom. */}
      <div className="account-cine__scrim" aria-hidden="true" />
      <div className="account-cine__bloom" aria-hidden="true" />

      {/* Animated flight-path arc accent (dashes travelling along a great-circle
          style curve). Purely decorative. */}
      <svg className="account-cine__arc" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <defs>
          <linearGradient id="account-arc-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--color-soft-green)" stopOpacity="0.0" />
            <stop offset="50%" stopColor="var(--color-primary-green)" stopOpacity="0.9" />
            <stop offset="100%" stopColor="var(--color-action-orange)" stopOpacity="0.9" />
          </linearGradient>
        </defs>
        <path
          className="account-cine__arc-path"
          d="M-40 760 C 360 420, 820 380, 1500 120"
          fill="none"
          stroke="url(#account-arc-grad)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray="10 14"
        />
        <circle className="account-cine__arc-dot" r="5" fill="#FFFFFF">
          <animateMotion dur="9s" repeatCount="indefinite" rotate="auto"
            path="M-40 760 C 360 420, 820 380, 1500 120" />
        </circle>
      </svg>

      {/* Overlaid headline, bottom-left, on the scrim pool. */}
      <div className="account-cine__content">
        <p className="account-cine__eyebrow">{eyebrow}</p>
        <h1 className="account-cine__title">{title}</h1>
        <p className="account-cine__subtitle">{subtitle}</p>
        {points.length > 0 && (
          <ul className="account-cine__points">
            {points.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}