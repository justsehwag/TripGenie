/**
 * Pure edit-proposal logic for the Trip Assistant: validate, resolve, preview
 * and apply. Client-safe (the panel imports it): no server-only imports.
 * Never mutates its inputs. Add, remove, move and retime go through the shared
 * helpers in lib/itinerary/day-edit.ts, the same code path as Edit Day.
 */
import type { Activity, Itinerary, TripDay } from "../types";
import { recomputeTotals } from "../itinerary-inr";
import {
  appendActivity,
  insertActivityAt,
  moveActivity,
  removeActivityAt,
  setActivityTime,
} from "../itinerary/day-edit";
import { legMinutesUp } from "../itinerary/geo";
import { buildMapsUrl, isSafeMapsUrl, isValidPhotoRef } from "../itinerary/maps-link";
import { sanitizeStoredVerification } from "../itinerary/revalidate";
import { MAX_STOP_PHOTOS } from "../itinerary/activity-fields";
import { isValidWebFields } from "../web-price-sources";
import type { AppliedEdit, EditOp, EditProposal, PlaceRecord, Preview } from "./types";

export { itineraryFingerprint } from "./history";
export type { AppliedEdit } from "./types";

export type ApplyResult =
  | { ok: true; itinerary: Itinerary; inverse: AppliedEdit }
  | {
      ok: false;
      reason: "stale" | "invalid-edit" | "revalidation-failed" | "missing-place";
      detail: string;
    };

export type ValidateResult =
  | { ok: true }
  | {
      ok: false;
      reason: "stale" | "invalid-edit" | "missing-place" | "not-allowed";
      detail: string;
    };

export interface ApplyDeps {
  /** Labels a new Stop's price as an estimate (planner passes withEstimatedActivity). */
  estimate: (a: Activity) => Activity;
  /** Clock for the undo entry; defaults to Date.now. */
  now?: () => number;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_TRAVEL_MIN = 600;
const MAX_DESC_CHARS = 200;
const MAX_BASIS_CHARS = 120;
const DEFAULT_VISIT_MIN = 60;

export function isValidTime(t: unknown): t is string {
  return typeof t === "string" && TIME_RE.test(t);
}

function parseMin(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(typeof t === "string" ? t.trim() : "");
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  return h <= 23 && mm <= 59 ? h * 60 + mm : null;
}

function formatMin(total: number): string {
  const t = Math.min(23 * 60 + 59, Math.max(0, Math.round(total)));
  const h = Math.floor(t / 60);
  const m = t % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function validLocation(v: unknown): v is { lat: number; lng: number } {
  if (!v || typeof v !== "object") return false;
  const { lat, lng } = v as { lat?: unknown; lng?: unknown };
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

function dayOf(it: Itinerary, day: number): TripDay | undefined {
  return it.days.find((d) => d.day === day);
}

/**
 * Resolves the Stop an edit points at. For replace, remove, move and retime:
 * the Stop at `index` when its title equals `expectTitle`, else the only Stop
 * in that day with that title, else null. For add: the day and insertion index
 * (the end of the day when `index` is omitted), or null when the day or index
 * is out of range.
 */
export function resolveTarget(it: Itinerary, edit: EditOp): { day: number; index: number } | null {
  if (!it || !Array.isArray(it.days) || !edit) return null;
  const d = dayOf(it, edit.day);
  if (!d) return null;
  if (edit.op === "add") {
    const at = edit.index === undefined ? d.activities.length : edit.index;
    return Number.isInteger(at) && at >= 0 && at <= d.activities.length ? { day: d.day, index: at } : null;
  }
  const want = typeof edit.expectTitle === "string" ? edit.expectTitle.trim() : "";
  if (!want) return null;
  const same = (a: Activity | undefined) => !!a && typeof a.title === "string" && a.title.trim() === want;
  if (Number.isInteger(edit.index) && same(d.activities[edit.index])) {
    return { day: d.day, index: edit.index };
  }
  const hits: number[] = [];
  d.activities.forEach((a, i) => {
    if (same(a)) hits.push(i);
  });
  return hits.length === 1 ? { day: d.day, index: hits[0] } : null;
}

function placeProblem(edit: EditOp, place: PlaceRecord | undefined): string | null {
  if (edit.op !== "add" && edit.op !== "replace") return null;
  if (!place || typeof place !== "object") return "place record missing";
  if (typeof place.placeId !== "string" || place.placeId === "" || place.placeId !== edit.placeId) {
    return "place record does not match placeId";
  }
  if (typeof place.name !== "string" || place.name.trim() === "") return "place name missing";
  if (!validLocation(place.location)) return "place location invalid";
  return null;
}

function shapeProblem(edit: EditOp): string | null {
  if (!edit || typeof edit !== "object") return "no edit";
  if (!Number.isInteger(edit.day)) return "invalid day";
  switch (edit.op) {
    case "add":
      if (typeof edit.placeId !== "string" || edit.placeId === "") return "placeId required";
      if (edit.time !== undefined && !isValidTime(edit.time)) return "time must be HH:MM";
      return null;
    case "replace":
      return typeof edit.placeId !== "string" || edit.placeId === "" ? "placeId required" : null;
    case "remove":
      return null;
    case "move":
      if (!Number.isInteger(edit.toDay)) return "invalid target day";
      if (edit.time !== undefined && !isValidTime(edit.time)) return "time must be HH:MM";
      return null;
    case "retime":
      return isValidTime(edit.time) ? null : "time must be HH:MM";
    default:
      return "unknown operation";
  }
}

/**
 * Server-side proposal check: the target resolves, add and replace use an
 * allow-listed placeId with a matching place record, and times are HH:MM.
 */
export function validateProposal(
  it: Itinerary,
  p: EditProposal,
  allowedPlaceIds: ReadonlySet<string> | readonly string[],
): ValidateResult {
  try {
    if (!p || typeof p !== "object" || !p.edit) return { ok: false, reason: "invalid-edit", detail: "no edit" };
    const bad = shapeProblem(p.edit);
    if (bad) return { ok: false, reason: "invalid-edit", detail: bad };
    const edit = p.edit;
    if (edit.op === "add" || edit.op === "replace") {
      const allowed = Array.isArray(allowedPlaceIds)
        ? (allowedPlaceIds as readonly string[]).includes(edit.placeId)
        : (allowedPlaceIds as ReadonlySet<string>).has(edit.placeId);
      if (!allowed) return { ok: false, reason: "not-allowed", detail: "placeId was not offered in this conversation" };
      const pp = placeProblem(edit, p.place);
      if (pp) return { ok: false, reason: "missing-place", detail: pp };
    }
    if (!resolveTarget(it, edit)) return { ok: false, reason: "stale", detail: "target stop not found" };
    if (edit.op === "move" && !dayOf(it, edit.toDay)) {
      return { ok: false, reason: "invalid-edit", detail: "target day not found" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "invalid-edit", detail: "invalid proposal" };
  }
}

function newStop(
  it: Itinerary,
  day: number,
  index: number,
  time: string | undefined,
  p: EditProposal,
  deps: ApplyDeps,
): Activity {
  const place = p.place as PlaceRecord;
  const name = place.name.trim();
  const stop: Activity = {
    time: time ?? "Flexible",
    title: name,
    description: (typeof place.address === "string" ? place.address : "").slice(0, MAX_DESC_CHARS),
    cost: 0,
    placeId: place.placeId,
    placeName: name,
    verified: true,
    mapsUrl: isSafeMapsUrl(place.mapsUrl) ? place.mapsUrl : buildMapsUrl(place.placeId, name),
    location: { lat: place.location.lat, lng: place.location.lng },
  };
  if (typeof place.area === "string" && place.area.trim()) stop.area = place.area.trim();
  const photos = (Array.isArray(place.photos) ? place.photos : [])
    .filter((x): x is string => isValidPhotoRef(x))
    .slice(0, MAX_STOP_PHOTOS);
  if (photos.length === 0 && isValidPhotoRef(place.photoRef)) photos.push(place.photoRef);
  if (photos.length > 0) {
    stop.photos = photos;
    stop.photoRef = photos[0];
  }
  if (typeof place.openingHours === "string" && place.openingHours.trim()) stop.openingHours = place.openingHours;
  if (place.hoursLabel === "Typical hours" || place.hoursLabel === "Hours not listed") {
    stop.hoursLabel = place.hoursLabel;
  }
  if (Number.isInteger(place.visitMin) && (place.visitMin as number) >= 1 && (place.visitMin as number) <= 1440) {
    stop.visitMin = place.visitMin;
  }

  if (time === undefined) {
    // Default time: end of the previous Stop (start + visit + travel), else "Flexible".
    const prev = dayOf(it, day)?.activities[index - 1];
    const start = prev ? parseMin(prev.time) : null;
    if (prev && start !== null) {
      const travel =
        prev.location && stop.location ? legMinutesUp(prev.location, stop.location) : (prev.travelToNextMin ?? 0);
      stop.time = formatMin(start + (prev.visitMin ?? DEFAULT_VISIT_MIN) + travel);
    }
  }

  const price = p.price;
  if (
    price &&
    typeof price.inr === "number" &&
    Number.isFinite(price.inr) &&
    price.inr >= 0 &&
    isValidWebFields(price)
  ) {
    stop.cost = Math.round(price.inr);
    stop.costBasis = "person";
    stop.costClass = stop.cost === 0 ? "free-sight" : "paid-sight";
    stop.priceSource = "web";
    if (typeof price.basis === "string" && price.basis.trim()) {
      stop.priceBasis = price.basis.trim().slice(0, MAX_BASIS_CHARS);
    }
    stop.sourceUrl = price.sourceUrl;
    stop.sourceHost = price.sourceHost;
    stop.checkedAt = price.checkedAt;
    return stop;
  }
  return deps.estimate(stop);
}

/** Recomputes travelToNextMin for one day: located neighbours get legMinutesUp, others none. */
function withTravel(day: TripDay): TripDay {
  const acts = day.activities;
  const next = acts.map((a, i) => {
    const b = acts[i + 1];
    if (b && a.location && b.location) {
      const m = Math.min(MAX_TRAVEL_MIN, legMinutesUp(a.location, b.location));
      return a.travelToNextMin === m ? a : { ...a, travelToNextMin: m };
    }
    if (a.travelToNextMin === undefined) return a;
    const { travelToNextMin: _drop, ...rest } = a;
    void _drop;
    return rest as Activity;
  });
  return next.every((a, i) => a === acts[i]) ? day : { ...day, activities: next };
}

function applyEdit(it: Itinerary, p: EditProposal, deps: ApplyDeps): ApplyResult {
  const edit = p.edit;
  const target = resolveTarget(it, edit);
  if (!target) return { ok: false, reason: "stale", detail: "target stop not found" };
  const touched = [edit.day];
  let out: Itinerary;

  switch (edit.op) {
    case "add": {
      const stop = newStop(it, edit.day, target.index, edit.time, p, deps);
      out =
        edit.index === undefined
          ? appendActivity(it, edit.day, stop)
          : insertActivityAt(it, edit.day, target.index, stop);
      break;
    }
    case "replace": {
      const old = dayOf(it, edit.day)!.activities[target.index];
      const stop = newStop(it, edit.day, target.index, isValidTime(old.time) ? old.time : undefined, p, deps);
      if (!isValidTime(old.time)) stop.time = old.time;
      out = insertActivityAt(removeActivityAt(it, edit.day, target.index), edit.day, target.index, stop);
      break;
    }
    case "remove":
      out = removeActivityAt(it, edit.day, target.index);
      break;
    case "move": {
      const dst = dayOf(it, edit.toDay);
      if (!dst) return { ok: false, reason: "invalid-edit", detail: "target day not found" };
      const dstLen = dst.activities.length - (dst.day === edit.day ? 1 : 0);
      const at = edit.toIndex === undefined ? dstLen : edit.toIndex;
      out = moveActivity(it, { day: edit.day, index: target.index }, { day: edit.toDay, index: edit.toIndex });
      if (out === it) return { ok: false, reason: "invalid-edit", detail: "move target out of range" };
      if (edit.time !== undefined) out = setActivityTime(out, edit.toDay, at, edit.time);
      touched.push(edit.toDay);
      break;
    }
    case "retime":
      out = setActivityTime(it, edit.day, target.index, edit.time);
      break;
    default:
      return { ok: false, reason: "invalid-edit", detail: "unknown operation" };
  }
  if (out === it) return { ok: false, reason: "invalid-edit", detail: "edit had no effect" };

  const days = out.days.map((d) => (touched.includes(d.day) ? withTravel(d) : d));
  const next = recomputeTotals({ ...out, days, revised: true });

  if (sanitizeStoredVerification(next) !== next) {
    return { ok: false, reason: "revalidation-failed", detail: "the edited itinerary has an invalid stop field" };
  }
  return {
    ok: true,
    itinerary: next,
    inverse: { before: it, after: next, summary: p.summary, at: (deps.now ?? Date.now)() },
  };
}

/**
 * Applies a proposal without mutating `it`. On any failure the caller keeps
 * the current itinerary. The inverse holds the exact previous itinerary.
 */
export function applyProposal(it: Itinerary, p: EditProposal, deps: ApplyDeps): ApplyResult {
  try {
    if (!it || !Array.isArray(it.days) || !p || !p.edit) {
      return { ok: false, reason: "invalid-edit", detail: "no edit" };
    }
    const bad = shapeProblem(p.edit);
    if (bad) return { ok: false, reason: "invalid-edit", detail: bad };
    const pp = placeProblem(p.edit, p.place);
    if (pp) return { ok: false, reason: "missing-place", detail: pp };
    return applyEdit(it, p, deps);
  } catch {
    return { ok: false, reason: "invalid-edit", detail: "the edit could not be applied" };
  }
}

/** Before and after of the affected day plus total deltas; null when the proposal cannot apply. */
export function previewProposal(it: Itinerary, p: EditProposal, deps: ApplyDeps): Preview | null {
  const r = applyProposal(it, p, deps);
  if (!r.ok) return null;
  const day = p.edit.day;
  const before = dayOf(it, day) ?? null;
  const after = dayOf(r.itinerary, day) ?? null;
  return {
    dayBefore: before,
    dayAfter: after,
    dayTotalDelta: (after?.total ?? 0) - (before?.total ?? 0),
    tripTotalDelta: r.itinerary.totalCost - it.totalCost,
  };
}
