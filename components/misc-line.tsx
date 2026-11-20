"use client";

import { useId, useState } from "react";
import type { TripDay } from "@/lib/types";
import { formatInr } from "@/lib/itinerary-inr";
import { priceBadgeText } from "@/lib/itinerary/labels";
import {
  MISC_MISSING_PREFIX,
  MISC_NONE_TEXT,
  MISC_NOT_IN_TOTAL,
  MISC_UNAVAILABLE_TEXT,
  MISC_WEB_TITLE,
} from "@/lib/itinerary/misc-estimate-shared";
import type { MiscEntry } from "@/components/use-misc-estimate";
import { CheckedAt, SourceLink } from "@/components/web-price-bits";

export interface MiscLineProps {
  day: TripDay;
  result: MiscEntry | undefined;
}

const WEB_BADGE_TEXT = priceBadgeText({ priceSource: "web", webDetails: { checked: true } });

/** Presentational "Misc (web prices)" row. Never reads or writes day.total or activity cost. */
export function MiscLine({ day, result }: MiscLineProps) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const stops = Array.isArray(day?.activities) ? day.activities.length : 0;
  if (stops === 0) return null;

  if (result === undefined || result === "loading") {
    return (
      <div className="misc-line" aria-busy="true">
        <span className="misc-line__label">{MISC_WEB_TITLE}</span>
        <span className="misc-line__placeholder" aria-hidden="true">…</span>
      </div>
    );
  }

  if (result.status === "unavailable") {
    return (
      <div className="misc-line">
        <span className="misc-line__label">{MISC_WEB_TITLE}</span>
        <span className="misc-line__placeholder">{MISC_UNAVAILABLE_TEXT}</span>
      </div>
    );
  }

  const missing = result.missing;
  const hasMissing = missing.length > 0;
  const showButton = result.status === "ok" || hasMissing;

  const toggle = showButton ? (
    <button
      type="button"
      className="misc-line__toggle"
      aria-expanded={open}
      aria-controls={detailId}
      onClick={() => setOpen((v) => !v)}
    >
      {open ? "Hide" : "Details"}
    </button>
  ) : null;

  const missingLine = hasMissing ? (
    <p className="misc-line__missing">{MISC_MISSING_PREFIX + missing.join(", ")}</p>
  ) : null;

  return (
    <div className="misc-line">
      <span className="misc-line__label">{MISC_WEB_TITLE}</span>
      {result.status === "ok" ? (
        <>
          <span className="misc-line__sum">{formatInr(result.sumInr)}</span>
          <span className="misc-line__not-in-total">{MISC_NOT_IN_TOTAL}</span>
        </>
      ) : (
        <span className="misc-line__placeholder">{MISC_NONE_TEXT}</span>
      )}
      {toggle}
      {open && showButton ? (
        <div className="misc-line__detail" id={detailId}>
          {result.status === "ok" ? (
            <ul>
              {result.items.map((it, i) => (
                <li className="misc-line__item" key={i + ":" + it.label}>
                  <span>{it.label}</span>
                  <span>{formatInr(it.amountInr)}</span>
                  {it.basis ? <span>{it.basis}</span> : null}
                  <span className="price-badge price-badge--web">{WEB_BADGE_TEXT}</span>
                  <SourceLink url={it.sourceUrl} host={it.sourceHost} />
                  <CheckedAt iso={it.checkedAt} />
                </li>
              ))}
            </ul>
          ) : null}
          {missingLine}
        </div>
      ) : null}
    </div>
  );
}
