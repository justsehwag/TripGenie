/**
 * Wire contract of POST /api/ai with action "itinerary-batch".
 *
 * Pure, total and client-safe: no server imports, and no function here throws
 * for any input. Used by the route (validateBatchRequest, unavailable) and by
 * the browser (readBatchResponse).
 */
import {
  BATCH_DAYS,
  MAX_NAME_CHARS,
  MAX_TRIP_DAYS,
  MAX_USED_PLACES,
} from "@/lib/itinerary/constants";
import { cleanNewActivityFields } from "@/lib/itinerary/activity-fields";
import { isSafeMapsUrl } from "@/lib/itinerary/maps-link";
import { cleanUsedName } from "@/lib/itinerary/text";
import type { Activity, SourceLink, TripContext, TripDay } from "@/lib/types";

const MAX_DESTINATION_CHARS = 100;
const MAX_DAY_TRIPS_USED = 3;

export interface BatchRequest {
  action: "itinerary-batch";
  context: TripContext;
  fromDay: number;
  dayCount: number;
  usedPlaces: string[];
  /** ISO yyyy-mm-dd, optional. */
  startDate?: string;
  /** Day trips already accepted in earlier batches. */
  dayTripsUsed?: number;
}

export type BatchReason = "not-configured" | "unavailable" | "unverified";

export interface BatchResponse {
  source: "model" | "unavailable";
  /** Required when source is "unavailable"; optional note otherwise. */
  reason?: BatchReason;
  fromDay: number;
  dayCount: number;
  /** Verified_Days only, ascending. */
  days: TripDay[];
  verifiedDays: number[];
  withheldDays: number[];
  truncated: boolean;
  /** First batch, when grounding contributed. */
  sources?: SourceLink[];
  stats: { proposed: number; verified: number; removed: number; ms: number };
}

const REASONS: readonly BatchReason[] = ["not-configured", "unavailable", "unverified"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/** True for a real calendar date written yyyy-mm-dd. */
function isRealIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const y = Number(v.slice(0, 4));
  const m = Number(v.slice(5, 7));
  const d = Number(v.slice(8, 10));
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * Validates a request body (Requirement 5.11). Never throws. On success the
 * returned value carries cleaned used places (entries that clean to "" are
 * dropped) and `totalDays` is the trip length from the context.
 */
export function validateBatchRequest(
  body: unknown,
): { ok: true; value: BatchRequest; totalDays: number } | { ok: false; error: string } {
  try {
    if (!isRecord(body)) return { ok: false, error: "Invalid request body." };
    const context = body.context;
    if (!isRecord(context)) return { ok: false, error: "Missing trip context." };

    const destination = context.destination;
    if (typeof destination !== "string") return { ok: false, error: "Invalid destination." };
    const dest = destination.trim();
    if (dest.length === 0 || dest.length > MAX_DESTINATION_CHARS) {
      return { ok: false, error: "Invalid destination." };
    }

    const totalDays = context.durationDays;
    if (!isInt(totalDays) || totalDays < 1 || totalDays > MAX_TRIP_DAYS) {
      return { ok: false, error: "Invalid trip length." };
    }

    const { fromDay, dayCount } = body;
    if (!isInt(dayCount) || dayCount < 1 || dayCount > BATCH_DAYS) {
      return { ok: false, error: "Invalid dayCount." };
    }
    if (!isInt(fromDay) || fromDay < 1 || fromDay + dayCount - 1 > totalDays) {
      return { ok: false, error: "Invalid fromDay." };
    }

    const rawUsed = body.usedPlaces ?? [];
    if (!Array.isArray(rawUsed) || rawUsed.length > MAX_USED_PLACES) {
      return { ok: false, error: "Invalid usedPlaces." };
    }
    const usedPlaces: string[] = [];
    for (const entry of rawUsed) {
      if (typeof entry !== "string" || entry.length > MAX_NAME_CHARS) {
        return { ok: false, error: "Invalid usedPlaces." };
      }
      const cleaned = cleanUsedName(entry);
      if (cleaned) usedPlaces.push(cleaned);
    }

    let startDate: string | undefined;
    if (body.startDate !== undefined && body.startDate !== null) {
      if (!isRealIsoDate(body.startDate)) return { ok: false, error: "Invalid startDate." };
      startDate = body.startDate;
    }

    let dayTripsUsed: number | undefined;
    if (body.dayTripsUsed !== undefined && body.dayTripsUsed !== null) {
      const n = body.dayTripsUsed;
      if (!isInt(n) || n < 0 || n > MAX_DAY_TRIPS_USED) {
        return { ok: false, error: "Invalid dayTripsUsed." };
      }
      dayTripsUsed = n;
    }

    const value: BatchRequest = {
      action: "itinerary-batch",
      context: { ...(context as TripContext), destination: dest },
      fromDay,
      dayCount,
      usedPlaces,
    };
    if (startDate !== undefined) value.startDate = startDate;
    if (dayTripsUsed !== undefined) value.dayTripsUsed = dayTripsUsed;
    return { ok: true, value, totalDays };
  } catch {
    return { ok: false, error: "Invalid request body." };
  }
}

/**
 * The "cannot verify" outcome: no days, every requested day withheld. The
 * range is echoed as given; counters are zero.
 */
export function unavailable(
  req: Pick<BatchRequest, "fromDay" | "dayCount">,
  reason: BatchReason,
  ms = 0,
): BatchResponse {
  const fromDay = isInt(req?.fromDay) ? req.fromDay : 1;
  const dayCount = isInt(req?.dayCount) ? req.dayCount : 0;
  const withheldDays: number[] = [];
  for (let i = 0; i < dayCount && i < MAX_TRIP_DAYS; i++) withheldDays.push(fromDay + i);
  return {
    source: "unavailable",
    reason,
    fromDay,
    dayCount,
    days: [],
    verifiedDays: [],
    withheldDays,
    truncated: false,
    stats: { proposed: 0, verified: 0, removed: 0, ms: Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0 },
  };
}

function readDayList(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_TRIP_DAYS) return null;
  const out: number[] = [];
  for (const v of raw) {
    if (!isInt(v) || v < 1 || v > MAX_TRIP_DAYS) return null;
    out.push(v);
  }
  return out;
}

/**
 * Re-validates an activity flagged `verified: true`: it needs a non-empty
 * `placeId` and a safe `mapsUrl`. When either fails, only `verified`,
 * `placeId` and `mapsUrl` are removed and the rest of the activity is kept
 * (same policy as Requirement 12.5). Returns the same object when unchanged.
 */
function revalidateActivity(a: Activity): Activity {
  if (a.verified !== true) return a;
  const idOk = typeof a.placeId === "string" && a.placeId.trim().length > 0;
  if (idOk && isSafeMapsUrl(a.mapsUrl)) return a;
  const { verified: _v, placeId: _p, mapsUrl: _m, ...rest } = a;
  void _v;
  void _p;
  void _m;
  return rest as Activity;
}

function readDay(raw: unknown): TripDay | null {
  if (!isRecord(raw) || !isInt(raw.day) || !Array.isArray(raw.activities)) return null;
  let changed = false;
  const activities: Activity[] = [];
  for (const a of raw.activities) {
    if (!isRecord(a)) return null;
    let checked = revalidateActivity(a as unknown as Activity);
    const fields = cleanNewActivityFields(checked as unknown as Record<string, unknown>);
    if (fields) checked = fields as unknown as Activity;
    if (checked !== (a as unknown)) changed = true;
    activities.push(checked);
  }
  return changed ? ({ ...(raw as unknown as TripDay), activities } as TripDay) : (raw as unknown as TripDay);
}

function readSources(raw: unknown): SourceLink[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SourceLink[] = [];
  for (const s of raw) {
    if (
      isRecord(s) &&
      typeof s.title === "string" &&
      typeof s.url === "string" &&
      typeof s.host === "string" &&
      s.url.startsWith("https://")
    ) {
      out.push({ title: s.title, url: s.url, host: s.host });
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Defensive client-side read of a response body. Returns null for any
 * malformed body: wrong types, ranges outside the request window, days that
 * are not ascending, verified/withheld lists that disagree with `days`, or an
 * "unavailable" response that carries days or lacks a reason. Never throws.
 */
export function readBatchResponse(json: unknown): BatchResponse | null {
  try {
    if (!isRecord(json)) return null;
    const { source } = json;
    if (source !== "model" && source !== "unavailable") return null;

    const { fromDay, dayCount } = json;
    if (!isInt(fromDay) || fromDay < 1 || fromDay > MAX_TRIP_DAYS) return null;
    if (!isInt(dayCount) || dayCount < 1 || dayCount > BATCH_DAYS) return null;
    const last = fromDay + dayCount - 1;
    if (last > MAX_TRIP_DAYS) return null;

    let reason: BatchReason | undefined;
    if (json.reason !== undefined) {
      if (!REASONS.includes(json.reason as BatchReason)) return null;
      reason = json.reason as BatchReason;
    }
    if (source === "unavailable" && reason === undefined) return null;

    if (!Array.isArray(json.days) || json.days.length > dayCount) return null;
    const days: TripDay[] = [];
    let prev = fromDay - 1;
    for (const raw of json.days) {
      const d = readDay(raw);
      if (!d || d.day <= prev || d.day > last) return null;
      prev = d.day;
      days.push(d);
    }
    if (source === "unavailable" && days.length > 0) return null;

    const verifiedDays = readDayList(json.verifiedDays);
    const withheldDays = readDayList(json.withheldDays);
    if (!verifiedDays || !withheldDays) return null;
    const dayNumbers = days.map((d) => d.day);
    if (verifiedDays.length !== dayNumbers.length || verifiedDays.some((v, i) => v !== dayNumbers[i])) {
      return null;
    }
    for (const w of withheldDays) {
      if (w < fromDay || w > last || dayNumbers.includes(w)) return null;
    }
    if (new Set(withheldDays).size !== withheldDays.length) return null;

    if (typeof json.truncated !== "boolean") return null;

    const st = json.stats;
    if (!isRecord(st)) return null;
    const { proposed, verified, removed, ms } = st;
    for (const n of [proposed, verified, removed, ms]) {
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
    }

    const out: BatchResponse = {
      source,
      fromDay,
      dayCount,
      days,
      verifiedDays,
      withheldDays: [...withheldDays].sort((a, b) => a - b),
      truncated: json.truncated,
      stats: {
        proposed: proposed as number,
        verified: verified as number,
        removed: removed as number,
        ms: ms as number,
      },
    };
    if (reason !== undefined) out.reason = reason;
    const sources = readSources(json.sources);
    if (sources) out.sources = sources;
    return out;
  } catch {
    return null;
  }
}
