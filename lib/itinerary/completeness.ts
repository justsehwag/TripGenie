/**
 * Completeness bookkeeping for progressively built itineraries.
 *
 * Pure, total and client-safe: every function tolerates malformed input and
 * never throws. Invariant kept by mergeBatch: verifiedDays, withheldDays and
 * pendingDays are sorted, pairwise disjoint and together cover 1..requestedDays.
 */
import { MAX_TRIP_DAYS } from "@/lib/itinerary/constants";
import type { Itinerary, ItineraryCompleteness, TripDay } from "@/lib/types";

/** Minimal structural view of a batch response (BatchResponse satisfies it). */
export interface BatchCompletenessInput {
  verifiedDays: readonly number[];
  withheldDays: readonly number[];
}

export type TimelineSlot =
  | { kind: "day"; day: TripDay }
  | { kind: "placeholder"; from: number; to: number; status: "pending" | "loading" | "withheld" };

function clampTotal(totalDays: unknown): number {
  const n = typeof totalDays === "number" && Number.isFinite(totalDays) ? Math.floor(totalDays) : 1;
  return Math.min(MAX_TRIP_DAYS, Math.max(1, n));
}

function dayList(raw: unknown, total: number): number[] {
  const out = new Set<number>();
  if (Array.isArray(raw)) {
    for (const v of raw) {
      if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= total) out.add(v);
    }
  }
  return [...out].sort((a, b) => a - b);
}

function daysOf(it: Itinerary | null | undefined): TripDay[] {
  return it && Array.isArray(it.days)
    ? it.days.filter((d) => d && typeof d === "object" && Number.isInteger(d.day))
    : [];
}

function dayCost(d: TripDay): number {
  if (typeof d.total === "number" && Number.isFinite(d.total)) return d.total;
  let sum = 0;
  if (Array.isArray(d.activities)) {
    for (const a of d.activities) {
      if (a && typeof a.cost === "number" && Number.isFinite(a.cost)) sum += a.cost;
    }
  }
  return sum;
}

/** All requested days pending. */
export function initialCompleteness(totalDays: number): ItineraryCompleteness {
  const n = clampTotal(totalDays);
  return {
    requestedDays: n,
    verifiedDays: [],
    withheldDays: [],
    pendingDays: Array.from({ length: n }, (_, i) => i + 1),
  };
}

/**
 * Merge a verified batch into the running itinerary. Existing day objects are
 * kept as-is (the existing day wins on a duplicate), days are sorted and
 * de-duplicated, totalCost is recomputed and completeness stays disjoint and
 * covering 1..totalDays.
 */
export function mergeBatch(
  it: Itinerary | null,
  batch: Itinerary,
  resp: BatchCompletenessInput,
  totalDays: number,
): Itinerary {
  const total = clampTotal(totalDays);
  const byDay = new Map<number, TripDay>();
  for (const d of daysOf(it)) if (d.day >= 1 && d.day <= total && !byDay.has(d.day)) byDay.set(d.day, d);
  for (const d of daysOf(batch)) if (d.day >= 1 && d.day <= total && !byDay.has(d.day)) byDay.set(d.day, d);
  const days = [...byDay.values()].sort((a, b) => a.day - b.day);

  const verified = new Set(days.map((d) => d.day));
  const prevWithheld = dayList(it?.completeness?.withheldDays, total);
  const respVerified = dayList(resp?.verifiedDays, total);
  const respWithheld = dayList(resp?.withheldDays, total);
  const withheld = new Set<number>();
  for (const d of [...prevWithheld, ...respWithheld]) if (!verified.has(d)) withheld.add(d);
  // A day the response covered but did not verify is withheld, never pending.
  for (const d of [...respVerified, ...respWithheld]) if (!verified.has(d)) withheld.add(d);
  const pending: number[] = [];
  for (let d = 1; d <= total; d++) if (!verified.has(d) && !withheld.has(d)) pending.push(d);

  const completeness: ItineraryCompleteness = {
    requestedDays: total,
    verifiedDays: [...verified].sort((a, b) => a - b),
    withheldDays: [...withheld].sort((a, b) => a - b),
    pendingDays: pending,
  };

  const base = it ?? batch;
  const merged: Itinerary = {
    ...base,
    days,
    totalCost: days.reduce((s, d) => s + dayCost(d), 0),
    completeness,
  };
  if (!merged.sources && batch?.sources) merged.sources = batch.sources;
  return merged;
}

/** Turn pending days into withheld days. Returns the same object when none are pending. */
export function settlePending(it: Itinerary): Itinerary {
  const c = it?.completeness;
  if (!c || !Array.isArray(c.pendingDays) || c.pendingDays.length === 0) return it;
  const verified = new Set(c.verifiedDays ?? []);
  const withheld = new Set<number>(c.withheldDays ?? []);
  for (const d of c.pendingDays) if (!verified.has(d)) withheld.add(d);
  const next: ItineraryCompleteness = {
    requestedDays: c.requestedDays,
    verifiedDays: c.verifiedDays,
    withheldDays: [...withheld].sort((a, b) => a - b),
  };
  return { ...it, completeness: next };
}

/** True when nothing is withheld or pending. */
export function isComplete(it: Itinerary): boolean {
  const c = it?.completeness;
  if (!c) return true;
  return (c.withheldDays?.length ?? 0) === 0 && (c.pendingDays?.length ?? 0) === 0;
}

/** "6 of 10 days verified" */
export function verifiedLabel(c: ItineraryCompleteness): string {
  const v = c?.verifiedDays?.length ?? 0;
  const n = c?.requestedDays ?? v;
  return `${v} of ${n} days verified`;
}

const ACTIVITIES_COMPLETE_LABEL = "Activities (web, AI and category prices)";

/** "Activities (web, AI and category prices)" or "Activities for 6 of 10 days" */
export function activitiesLabel(c: ItineraryCompleteness | undefined): string {
  if (!c) return ACTIVITIES_COMPLETE_LABEL;
  const v = c.verifiedDays?.length ?? 0;
  const n = c.requestedDays ?? v;
  return v >= n ? ACTIVITIES_COMPLETE_LABEL : `Activities for ${v} of ${n} days`;
}

/** True when completeness is present or any activity carries verification data. */
export function hasVerificationData(it: Itinerary): boolean {
  if (!it) return false;
  if (it.completeness) return true;
  for (const d of daysOf(it)) {
    if (!Array.isArray(d.activities)) continue;
    for (const a of d.activities) if (a && (a.verified === true || typeof a.placeId === "string")) return true;
  }
  return false;
}

/**
 * Verified days in day order, with one placeholder per contiguous run of
 * non-verified days. A run is "loading" when any of its days is in flight,
 * else "withheld" when any of its days is withheld, else "pending".
 */
export function buildTimeline(it: Itinerary, inFlight: ReadonlySet<number>): TimelineSlot[] {
  const byDay = new Map<number, TripDay>();
  for (const d of daysOf(it)) if (!byDay.has(d.day)) byDay.set(d.day, d);
  const c = it?.completeness;
  let last = 0;
  for (const k of byDay.keys()) last = Math.max(last, k);
  const total = Math.max(last, c && Number.isInteger(c.requestedDays) ? c.requestedDays : 0);
  const withheld = new Set<number>(c?.withheldDays ?? []);
  const flying = inFlight ?? new Set<number>();

  const out: TimelineSlot[] = [];
  let runStart = 0;
  const flush = (end: number) => {
    if (runStart === 0) return;
    let status: "pending" | "loading" | "withheld" = "pending";
    let anyLoading = false;
    let anyWithheld = false;
    for (let d = runStart; d <= end; d++) {
      if (flying.has(d)) anyLoading = true;
      if (withheld.has(d)) anyWithheld = true;
    }
    if (anyLoading) status = "loading";
    else if (anyWithheld) status = "withheld";
    out.push({ kind: "placeholder", from: runStart, to: end, status });
    runStart = 0;
  };
  for (let d = 1; d <= total; d++) {
    const day = byDay.get(d);
    if (day) {
      flush(d - 1);
      out.push({ kind: "day", day });
    } else if (runStart === 0) {
      runStart = d;
    }
  }
  flush(total);
  return out;
}
