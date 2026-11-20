/**
 * Day carousel helpers (pure, client-safe, total: never throw).
 *
 * Slide selection, rotation rules, day media choice and the stop time range.
 * An end time is computed only from `visitMin` or from the next stop's start
 * minus `travelToNextMin`; no other source is ever used.
 */

import type { Activity } from "../types";
import { isValidPhotoRef } from "./maps-link";

export const ROTATION_INTERVAL_MS = 5000;

export interface Slide {
  ref: string;
  name: string;
  time: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** One Slide per stop with a valid first photo (photos[0], else photoRef), in order. */
export function selectSlides(activities: readonly Activity[]): Slide[] {
  const out: Slide[] = [];
  if (!Array.isArray(activities)) return out;
  for (const a of activities) {
    if (!a || typeof a !== "object") continue;
    const first: unknown = Array.isArray(a.photos) ? a.photos[0] : undefined;
    const ref: unknown = isValidPhotoRef(first) ? first : a.photoRef;
    if (!isValidPhotoRef(ref)) continue;
    const title = str(a.title).trim();
    const name = title || str(a.placeName).trim();
    out.push({ ref, name, time: str(a.time) });
  }
  return out;
}

/** Slides minus those whose ref is in `failed`, order kept. */
export function removeFailed(
  slides: readonly Slide[],
  failed: ReadonlySet<string>,
): Slide[] {
  if (!Array.isArray(slides)) return [];
  const has = (r: string) => {
    try {
      return !!failed && failed.has(r);
    } catch {
      return false;
    }
  };
  return slides.filter((s) => !has(s?.ref));
}

/** Wrapping index step. count <= 0 returns 0. */
export function stepIndex(current: number, count: number, dir: 1 | -1): number {
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return 0;
  const n = Math.floor(count);
  const c = typeof current === "number" && Number.isFinite(current) ? Math.trunc(current) : 0;
  const step = dir === -1 ? -1 : 1;
  return (((c + step) % n) + n) % n;
}

/** True only when automatic rotation should run. */
export function shouldRotate(s: {
  count: number;
  hovered: boolean;
  focused: boolean;
  hidden: boolean;
  reducedMotion: boolean;
  active: boolean;
}): boolean {
  if (!s || typeof s !== "object") return false;
  return (
    typeof s.count === "number" &&
    s.count >= 2 &&
    !s.hovered &&
    !s.focused &&
    !s.hidden &&
    !s.reducedMotion &&
    !!s.active
  );
}

export type DayMedia = "carousel" | "fallback-query" | "illustration";

/** No verified stop: fallback-query. Verified with at least one slide: carousel. Else illustration. */
export function chooseDayMedia(activities: readonly Activity[]): DayMedia {
  if (!Array.isArray(activities)) return "fallback-query";
  const anyVerified = activities.some((a) => !!a && typeof a === "object" && a.verified === true);
  if (!anyVerified) return "fallback-query";
  return selectSlides(activities).length > 0 ? "carousel" : "illustration";
}

export interface TimeRange {
  start: string;
  end?: string;
  kind: "range" | "estimate" | "start-only";
  text: string;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Parses "HH:MM" to minutes, or null when not 00:00-23:59. */
export function parseHHMM(t: unknown): number | null {
  if (typeof t !== "string") return null;
  const m = HHMM.exec(t);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function fmt(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Time_Range for stop `a`; `next` is the following stop of the same day, if any. */
export function formatTimeRange(a: Activity, next?: Activity): TimeRange {
  try {
    const raw = a && typeof a === "object" ? a.time : undefined;
    const startText = typeof raw === "string" ? raw : "";
    const startMin = parseHHMM(raw);
    if (startMin === null) return { start: startText, kind: "start-only", text: startText };

    let end: number | null = null;
    let kind: "range" | "estimate" = "range";
    const v: unknown = a.visitMin;
    if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 1440) {
      end = startMin + v;
    } else {
      const nextStart = next && typeof next === "object" ? parseHHMM(next.time) : null;
      const travel: unknown = a.travelToNextMin;
      if (nextStart !== null && typeof travel === "number" && Number.isFinite(travel) && travel >= 0) {
        end = nextStart - travel;
        kind = "estimate";
      }
    }

    if (end === null || !(end > startMin) || end >= 1440) {
      return { start: startText, kind: "start-only", text: startText };
    }
    const endText = fmt(end);
    return {
      start: startText,
      end: endText,
      kind,
      text: kind === "range" ? `${startText} \u2013 ${endText}` : `${startText}, until about ${endText}`,
    };
  } catch {
    const t = a && typeof a === "object" && typeof a.time === "string" ? a.time : "";
    return { start: t, kind: "start-only", text: t };
  }
}
