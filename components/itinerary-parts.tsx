"use client";

import { useState } from "react";
import GooglePlaceMedia from "@/components/google-place-media";
import { illustration } from "@/lib/illustrations";
import { isSafeMapsUrl, isValidPhotoRef } from "@/lib/itinerary/maps-link";
import {
  TRUST_SENTENCE,
  LEGACY_NOTE,
  VERIFIED_TEXT,
  verifiedLinkLabel,
  hasCertaintyClaim,
  travelLabel,
  withheldText,
  retryLabel,
  failureTitle,
  failureReason,
  NO_PRICE_TEXT,
  NO_TIP_TEXT,
  NO_BOOKING_TEXT,
  NO_BEST_TIME_TEXT,
  NOT_CHECKED_TEXT,
  NOT_CHECKED_UNAVAILABLE_TEXT,
  HOURS_NOT_LISTED,
  TIP_LABEL,
  BOOKING_LABEL,
  BEST_TIME_LABEL,
  priceBadgeText,
} from "@/lib/itinerary/labels";
import { SourceLink, CheckedAt } from "@/components/web-price-bits";
import type { TimelineSlot } from "@/lib/itinerary/completeness";
import type { BatchReason } from "@/lib/itinerary/batch-wire";
import type { Activity, TripDay, WebDetail } from "@/lib/types";

/** Presentational pieces of the trustworthy itinerary. Every string is rendered as React text. */

const LOCATION_PIN = illustration("location-pin");

export interface RetryButtonProps {
  label: string;
  busy: boolean;
  onClick: () => void;
}

export function RetryButton({ label, busy, onClick }: RetryButtonProps) {
  return (
    <button
      type="button"
      className="btn retry-btn"
      aria-label={label}
      aria-busy={busy}
      disabled={busy}
      onClick={onClick}
    >
      {busy ? "Retrying\u2026" : "Retry"}
    </button>
  );
}

export interface ItineraryBannerProps {
  /** "6 of 10 days verified"; empty string hides the count. */
  verifiedLabel: string;
  /** True for itineraries saved before place verification. */
  legacy: boolean;
}

export function ItineraryBanner({ verifiedLabel, legacy }: ItineraryBannerProps) {
  return (
    <div className="itin-banner">
      {verifiedLabel && <p className="itin-banner__count">{verifiedLabel}</p>}
      <p className="itin-banner__trust">{TRUST_SENTENCE}</p>
      {legacy && <p className="itin-banner__legacy">{LEGACY_NOTE}</p>}
    </div>
  );
}

/** Returns "" for non-strings, blank text and text that claims certainty. */
export function safeText(s: unknown): string {
  if (typeof s !== "string") return "";
  const t = s.trim();
  return t.length === 0 || hasCertaintyClaim(t) ? "" : t;
}

/** Opening hours line, or "" when the Stop has nothing to show. */
export function hoursLine(a: Pick<Activity, "openingHours" | "hoursLabel">): string {
  if (a.hoursLabel === "Hours not listed") return HOURS_NOT_LISTED;
  const hours = safeText(a.openingHours);
  if (!hours) return "";
  return [safeText(a.hoursLabel), hours].filter(Boolean).join(": ");
}

/** A detail that can be shown: safe excerpt, safe host and a source URL. */
function usableDetail(d: WebDetail | undefined): d is WebDetail {
  return !!d && typeof d === "object" && !!safeText(d.text) && !!safeText(d.sourceHost) && typeof d.sourceUrl === "string";
}

function DetailLine({ label, detail, missing, checked, unavailable }: {
  label: string;
  detail: WebDetail | undefined;
  missing: string;
  checked: boolean;
  unavailable?: boolean;
}) {
  if (!usableDetail(detail)) {
    const notChecked = unavailable ? NOT_CHECKED_UNAVAILABLE_TEXT : NOT_CHECKED_TEXT;
    return <span className="price-cell__note">{checked ? missing : `${label}: ${notChecked}`}</span>;
  }
  return (
    <span className="stop-meta__area">
      {label}: {safeText(detail.text)}{" "}
      <SourceLink url={detail.sourceUrl} host={safeText(detail.sourceHost)} />{" "}
      <CheckedAt iso={detail.checkedAt} />
    </span>
  );
}

function hasAcceptedWebPrice(a: Activity): boolean {
  return a.priceSource === "web" && !!safeText(a.sourceHost) && typeof a.sourceUrl === "string" && typeof a.checkedAt === "string";
}

/** Note for a places-first Stop with no accepted web price; null otherwise. */
export function PriceCellNote({ a }: { a: Activity }) {
  if (!a || !a.webDetails || hasAcceptedWebPrice(a)) return null;
  return (
    <span className="price-cell__note">
      {a.webDetails.checked === true
        ? NO_PRICE_TEXT
        : a.webDetails.unavailable === true ? NOT_CHECKED_UNAVAILABLE_TEXT : NOT_CHECKED_TEXT}
    </span>
  );
}

export interface StopPhotoProps {
  a: Activity;
}

/** First photo of a Stop; the location-pin illustration when there is none or it fails to load. */
export function StopPhoto({ a }: StopPhotoProps) {
  const first = Array.isArray(a.photos) ? a.photos[0] : undefined;
  const ref = isValidPhotoRef(first) ? first : null;
  const [failedRef, setFailedRef] = useState<string | null>(null);
  if (ref && failedRef !== ref) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={"/api/place-photo?ref=" + encodeURIComponent(ref) + "&w=160"}
        alt={(safeText(a.placeName) || safeText(a.title) || "Place") + " - Google photo"}
        width={160}
        loading="lazy"
        onError={() => setFailedRef(ref)}
      />
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={LOCATION_PIN.src} alt="" width={LOCATION_PIN.width} height={LOCATION_PIN.height} />
  );
}

export interface StopMetaProps {
  a: Activity;
  hasNext: boolean;
}

export function StopMeta({ a, hasNext }: StopMetaProps) {
  const placeName = safeText(a.placeName) || safeText(a.title);
  const area = safeText(a.area);
  const hours = hoursLine(a);
  const wd = a.webDetails;
  const showBadge = !!wd && hasAcceptedWebPrice(a);
  return (
    <span className="stop-meta">
      {area && <span className="stop-meta__area">{area}</span>}
      {a.verified === true && a.placeId && (isSafeMapsUrl(a.mapsUrl)
        ? (
          <a
            className="verified-link"
            href={a.mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={verifiedLinkLabel(placeName)}
          >
            {VERIFIED_TEXT}
          </a>
        )
        : <span className="verified-link verified-link--text">{VERIFIED_TEXT}</span>)}
      {hasNext && typeof a.travelToNextMin === "number" && (
        <span className="travel-estimate">Next stop: {travelLabel(a.travelToNextMin)}</span>
      )}
      {hours && <span className="stop-meta__area">{hours}</span>}
      {showBadge && (
        <span className="stop-meta__area">
          <span className="price-badge price-badge--web">{priceBadgeText(a)}</span>{" "}
          <SourceLink url={a.sourceUrl as string} host={safeText(a.sourceHost)} />{" "}
          <CheckedAt iso={a.checkedAt as string} />
        </span>
      )}
      {wd && (
        <>
          <DetailLine label={TIP_LABEL} detail={wd.tip} missing={NO_TIP_TEXT} checked={wd.checked === true} unavailable={wd.unavailable === true} />
          <DetailLine label={BOOKING_LABEL} detail={wd.booking} missing={NO_BOOKING_TEXT} checked={wd.checked === true} unavailable={wd.unavailable === true} />
          <DetailLine label={BEST_TIME_LABEL} detail={wd.bestTime} missing={NO_BEST_TIME_TEXT} checked={wd.checked === true} unavailable={wd.unavailable === true} />
        </>
      )}
    </span>
  );
}

export interface DayHeroProps {
  day: TripDay;
  /** Verified, distinct photo for this day, from pickDayHeroes. */
  hero?: { photoRef: string; name: string };
  /** Query for the legacy GooglePlaceMedia fallback. */
  fallbackQuery: string;
}

export function DayHero({ day, hero, fallbackQuery }: DayHeroProps) {
  const [failedRef, setFailedRef] = useState<string | null>(null);
  const hasVerified = Array.isArray(day.activities) && day.activities.some((a) => a && a.verified === true);

  if (!hasVerified) return <GooglePlaceMedia query={fallbackQuery} />;

  const photoOk = !!hero && isValidPhotoRef(hero.photoRef) && failedRef !== hero.photoRef;
  if (hero && photoOk) {
    return (
      <div className="gpm day-hero">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="day-hero__img"
          src={"/api/place-photo?ref=" + encodeURIComponent(hero.photoRef) + "&w=1280"}
          alt={(hero.name || "Place") + " - Google photo"}
          loading="lazy"
          onError={() => setFailedRef(hero.photoRef)}
        />
        <span className="gpm__brand">Google</span>
      </div>
    );
  }
  return (
    <div className="gpm day-hero">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="day-hero__img day-hero__img--illustration"
        src={LOCATION_PIN.src}
        alt=""
        width={LOCATION_PIN.width}
        height={LOCATION_PIN.height}
      />
    </div>
  );
}

export interface PlaceholderCardProps {
  slot: Extract<TimelineSlot, { kind: "placeholder" }>;
  busy: boolean;
  onRetry: () => void;
}

export function PlaceholderCard({ slot, busy, onRetry }: PlaceholderCardProps) {
  if (slot.status === "withheld") {
    return (
      <article className="card day-placeholder day-placeholder--withheld">
        <p className="day-placeholder__text">{withheldText(slot.from, slot.to)}</p>
        <RetryButton label={retryLabel(slot.from, slot.to)} busy={busy} onClick={onRetry} />
      </article>
    );
  }
  return (
    <article className="card day-placeholder day-placeholder--skeleton" aria-hidden="true">
      <span className="skeleton__block skeleton__block--title" />
      <span className="skeleton__block skeleton__block--line" />
    </article>
  );
}

export interface ItineraryFailureProps {
  reason: BatchReason | undefined;
  busy: boolean;
  onRetry: () => void;
}

export function ItineraryFailure({ reason, busy, onRetry }: ItineraryFailureProps) {
  return (
    <section className="card itin-fail" role="alert">
      <h2 className="itin-fail__title">{failureTitle}</h2>
      <p className="itin-fail__reason">{failureReason(reason)}</p>
      <RetryButton label="Retry" busy={busy} onClick={onRetry} />
    </section>
  );
}
