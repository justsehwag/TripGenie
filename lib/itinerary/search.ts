import type { Activity, Itinerary, TripDay } from "../types";
import { stopKey } from "./stop-expand";

const COMBINING = /\p{M}/gu;
const SPACE = /\s/u;

/** NFD, strip combining marks, lowercase, collapse whitespace, trim. */
export function normalise(text: string): string {
  if (typeof text !== "string" || text.length === 0) return "";
  return text
    .normalize("NFD")
    .toLowerCase()
    .replace(COMBINING, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** True when the normalised haystack contains the (already normalised) query. */
export function matchText(haystack: string, normalisedQuery: string): boolean {
  if (!normalisedQuery) return false;
  return normalise(haystack ?? "").includes(normalisedQuery);
}

/**
 * Ranges [start, end) in the ORIGINAL text (UTF-16 offsets on code point
 * boundaries) where the normalised query occurs. Non-overlapping, ascending.
 */
export function findRanges(text: string, query: string): Array<[number, number]> {
  const q = normalise(query ?? "");
  if (!q || typeof text !== "string" || text.length === 0) return [];

  let norm = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let pendingSpace = false;
  let pendingStart = 0;
  let pendingEnd = 0;
  let offset = 0;

  for (const ch of text) {
    const s = offset;
    const e = offset + ch.length;
    offset = e;
    if (SPACE.test(ch)) {
      if (norm.length > 0) {
        if (!pendingSpace) {
          pendingSpace = true;
          pendingStart = s;
        }
        pendingEnd = e;
      }
      continue;
    }
    const piece = ch.normalize("NFD").toLowerCase().replace(COMBINING, "");
    if (piece.length === 0) continue;
    if (pendingSpace) {
      norm += " ";
      starts.push(pendingStart);
      ends.push(pendingEnd);
      pendingSpace = false;
    }
    for (let i = 0; i < piece.length; i++) {
      norm += piece[i];
      starts.push(s);
      ends.push(e);
    }
  }

  const out: Array<[number, number]> = [];
  let from = 0;
  while (from <= norm.length - q.length) {
    const at = norm.indexOf(q, from);
    if (at < 0) break;
    const start = starts[at];
    const end = ends[at + q.length - 1];
    const last = out[out.length - 1];
    if (last && start < last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      out.push([start, end]);
    }
    from = at + q.length;
  }
  return out;
}

export interface StopMatch {
  stopId: string;
  titleOrBody: boolean;
  detailsOnly: boolean;
}

export interface DayMatch {
  dayId: string;
  titleMatch: boolean;
  fields: ("title" | "theme" | "date")[];
}

export interface FilterResult {
  active: boolean;
  visibleDays: Set<string>;
  visibleStops: Map<string, Set<string>>;
  dayMatches: Map<string, DayMatch>;
  stopMatches: Map<string, StopMatch>;
  detailsMatchStopIds: Set<string>;
  count: number;
}

function bodyFields(a: Activity): Array<string | undefined> {
  return [a.title, a.description, a.area, a.category, a.placeName];
}

function detailFields(a: Activity): Array<string | undefined> {
  const w = a.webDetails;
  return [a.openingHours, a.costNote, w?.tip?.text, w?.bestTime?.text, w?.booking?.text];
}

function anyMatch(fields: Array<string | undefined>, q: string): boolean {
  for (const f of fields) {
    if (typeof f === "string" && f && matchText(f, q)) return true;
  }
  return false;
}

export function filterItinerary(itinerary: Itinerary, query: string): FilterResult {
  const q = normalise(query ?? "");
  const active = q.length > 0;
  const days: TripDay[] = Array.isArray(itinerary?.days) ? itinerary.days : [];

  const result: FilterResult = {
    active,
    visibleDays: new Set(),
    visibleStops: new Map(),
    dayMatches: new Map(),
    stopMatches: new Map(),
    detailsMatchStopIds: new Set(),
    count: 0,
  };

  for (const d of days) {
    const dayId = String(d.day);
    const acts: Activity[] = Array.isArray(d.activities) ? d.activities : [];
    const stops = new Set<string>();

    if (!active) {
      result.visibleDays.add(dayId);
      acts.forEach((_, i) => stops.add(stopKey(d.day, i)));
      result.visibleStops.set(dayId, stops);
      continue;
    }

    const fields: DayMatch["fields"] = [];
    if (typeof d.title === "string" && matchText(d.title, q)) fields.push("title");
    if (typeof d.theme === "string" && matchText(d.theme, q)) fields.push("theme");
    if (typeof d.date === "string" && matchText(d.date, q)) fields.push("date");
    const titleMatch = fields.includes("title");
    if (fields.length > 0) {
      result.dayMatches.set(dayId, { dayId, titleMatch, fields });
      result.count += 1;
    }

    let anyStop = false;
    acts.forEach((a, i) => {
      const id = stopKey(d.day, i);
      const body = anyMatch(bodyFields(a), q);
      const details = anyMatch(detailFields(a), q);
      if (body || details) {
        const detailsOnly = !body && details;
        result.stopMatches.set(id, { stopId: id, titleOrBody: body, detailsOnly });
        if (detailsOnly) result.detailsMatchStopIds.add(id);
        result.count += 1;
        stops.add(id);
        anyStop = true;
      } else if (titleMatch) {
        stops.add(id);
      }
    });

    if (titleMatch || anyStop) {
      result.visibleDays.add(dayId);
      result.visibleStops.set(dayId, stops);
    }
  }

  return result;
}
