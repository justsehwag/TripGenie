/**
 * Batch text parsing (pure, total: never throws, linear time).
 *
 * Parses the model's truncation-prone JSON one complete day object at a time,
 * so a response cut mid-day still yields every day that finished. Server use.
 */

import { sanitizeDisplayText } from "./text";
import type { StopKind } from "./place-key";

export interface ProposedStop {
  time: string;
  place: string;
  area: string;
  kind: StopKind;
  description: string;
  cost: number;
}
export interface ProposedDay {
  title: string;
  dayTrip: boolean;
  stops: ProposedStop[];
}
export interface ParsedBatch {
  days: ProposedDay[];
  truncated: boolean;
}

const MAX_TIME = 20;
const MAX_PLACE = 100;
const MAX_AREA = 60;
const MAX_DESC = 160;
const MAX_TITLE = 80;
const MAX_COST = 10_000_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toKind(v: unknown): StopKind {
  return v === "meal" || v === "experience" || v === "sight" ? v : "sight";
}

function toCost(v: unknown): number {
  let n = NaN;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && v.trim() !== "") n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_COST, Math.round(n));
}

/** One activity object to a stop, or null when it has no place. */
function toStop(raw: unknown): ProposedStop | null {
  if (!isRecord(raw)) return null;
  const place = sanitizeDisplayText(raw.place, MAX_PLACE);
  if (!place) return null;
  return {
    time: sanitizeDisplayText(raw.time, MAX_TIME),
    place,
    area: sanitizeDisplayText(raw.area, MAX_AREA),
    kind: toKind(raw.kind),
    description: sanitizeDisplayText(raw.description, MAX_DESC),
    cost: toCost(raw.cost),
  };
}

/** One day object to a day, or null when it has no usable activity. */
function toDay(raw: unknown): ProposedDay | null {
  if (!isRecord(raw)) return null;
  const acts = Array.isArray(raw.activities) ? raw.activities : [];
  const stops: ProposedStop[] = [];
  for (const a of acts) {
    const s = toStop(a);
    if (s) stops.push(s);
  }
  if (stops.length === 0) return null;
  return {
    title: sanitizeDisplayText(raw.title, MAX_TITLE),
    dayTrip: raw.dayTrip === true,
    stops,
  };
}

/** Index just after `"key"` `:` `[`, or -1. Linear: each occurrence is visited once. */
function findArrayStart(text: string, key: string): number {
  const needle = `"${key}"`;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return -1;
    let i = at + needle.length;
    while (i < text.length && isSpace(text.charCodeAt(i))) i++;
    if (text[i] === ":") {
      i++;
      while (i < text.length && isSpace(text.charCodeAt(i))) i++;
      if (text[i] === "[") return i + 1;
    }
    from = at + needle.length;
  }
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

/**
 * Walks the array whose first element position is `start`, calling `onObject`
 * with the source slice of every balanced top-level object. Returns true when
 * the closing `]` was reached, false when the text ended first (including
 * inside an object, which is discarded).
 */
function scanObjects(
  text: string,
  start: number,
  onObject: (slice: string) => void,
): boolean {
  const n = text.length;
  let i = start;
  while (i < n) {
    const ch = text[i];
    if (ch === "]") return true;
    if (ch === '"') {
      // A stray string element: skip it.
      i++;
      while (i < n) {
        const c = text[i];
        if (c === "\\") i += 2;
        else if (c === '"') break;
        else i++;
      }
      i++;
      continue;
    }
    if (ch !== "{") {
      i++;
      continue;
    }
    const objStart = i;
    let depth = 0;
    let inString = false;
    let closed = false;
    while (i < n) {
      const c = text[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          closed = true;
          i++;
          break;
        }
      }
      i++;
    }
    if (!closed) return false;
    onObject(text.slice(objStart, i));
  }
  return false;
}

function tryParse(slice: string): unknown {
  try {
    return JSON.parse(slice);
  } catch {
    return undefined;
  }
}

/** Parses the model text into complete days. Total; never throws. */
export function parseBatchText(text: string, expectedDays: number): ParsedBatch {
  const out: ParsedBatch = { days: [], truncated: false };
  try {
    if (typeof text !== "string" || text.length === 0) return out;
    const limit =
      typeof expectedDays === "number" && Number.isFinite(expectedDays)
        ? Math.floor(expectedDays)
        : 0;
    const start = findArrayStart(text, "days");
    if (start < 0) return out;
    const closed = scanObjects(text, start, (slice) => {
      if (out.days.length >= limit) return;
      const day = toDay(tryParse(slice));
      if (day) out.days.push(day);
    });
    out.truncated = !closed;
    if (limit <= 0) out.days = [];
    return out;
  } catch {
    return { days: out.days, truncated: true };
  }
}

/** Canonical JSON of {"days":[...]}; parseBatchText of it round-trips. */
export function encodeProposedDays(days: readonly ProposedDay[]): string {
  const outDays: Array<Record<string, unknown>> = [];
  try {
    for (const d of Array.isArray(days) ? days : []) {
      if (!d || !Array.isArray(d.stops)) continue;
      const activities: Array<Record<string, unknown>> = [];
      for (const s of d.stops) {
        const stop = toStop(s);
        if (!stop) continue;
        activities.push({
          time: stop.time,
          place: stop.place,
          area: stop.area,
          kind: stop.kind,
          description: stop.description,
          cost: stop.cost,
        });
      }
      if (activities.length === 0) continue;
      outDays.push({
        title: sanitizeDisplayText(d.title, MAX_TITLE),
        dayTrip: d.dayTrip === true,
        activities,
      });
    }
  } catch {
    // fall through with what was collected
  }
  return JSON.stringify({ days: outDays });
}

/** Parses the repair response `{ "replacements": [ { day, slot, activity } ] }`. */
export function parseRepairText(
  text: string,
): Array<{ day: number; slot: number; stop: ProposedStop }> {
  const out: Array<{ day: number; slot: number; stop: ProposedStop }> = [];
  try {
    if (typeof text !== "string" || text.length === 0) return out;
    const start = findArrayStart(text, "replacements");
    if (start < 0) return out;
    scanObjects(text, start, (slice) => {
      const o = tryParse(slice);
      if (!isRecord(o)) return;
      const day = o.day;
      const slot = o.slot;
      if (
        typeof day !== "number" ||
        typeof slot !== "number" ||
        !Number.isInteger(day) ||
        !Number.isInteger(slot) ||
        day < 0 ||
        slot < 0
      ) {
        return;
      }
      const stop = toStop(o.activity);
      if (stop) out.push({ day, slot, stop });
    });
  } catch {
    // return what was collected
  }
  return out;
}
