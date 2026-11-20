/**
 * Planner state machine for progressive, batch-wise itinerary generation.
 *
 * Pure, total, deterministic and client-safe: no clock, no randomness, no
 * server imports, and no function here throws for any state or event.
 *
 * Invariants kept after every transition:
 * - at most one slot is "loading", and `inFlight` is that slot's id (or null);
 * - `verified`, `withheld` and `pending` are sorted, pairwise disjoint and
 *   cover 1..totalDays;
 * - `days` are ascending and never replaced once verified;
 * - `usedPlaces` and `dayTripsUsed` are derived from `days`.
 */
import { AUTO_RETRY_MAX, BATCH_DAYS, MAX_TRIP_DAYS, MAX_USED_PLACES, RANGE_RETRY_MAX } from "@/lib/itinerary/constants";
import type { BatchReason, BatchRequest, BatchResponse } from "@/lib/itinerary/batch-wire";
import { batchRanges } from "@/lib/itinerary/pace";
import { nameKey } from "@/lib/itinerary/place-key";
import { cleanUsedName } from "@/lib/itinerary/text";
import type { Itinerary, TripContext, TripDay } from "@/lib/types";

export type BatchStatus = "pending" | "loading" | "done" | "failed";

export interface BatchSlot {
  id: number;
  fromDay: number;
  dayCount: number;
  status: BatchStatus;
  /** Requests made for this slot. */
  attempts: number;
  /** Automatic retries used for this slot (at most AUTO_RETRY_MAX). */
  auto: number;
  /** Automatic range retries behind this slot (absent means 0, at most RANGE_RETRY_MAX). */
  rangeAuto?: number;
}

export interface BatchState {
  tripKey: string;
  totalDays: number;
  /** Ascending by fromDay. */
  slots: BatchSlot[];
  /** Verified days, ascending. */
  days: TripDay[];
  verified: number[];
  withheld: number[];
  pending: number[];
  /** Deduplicated names of verified stops, at most MAX_USED_PLACES. */
  usedPlaces: string[];
  dayTripsUsed: number;
  /** Slot id of the single request in flight. */
  inFlight: number | null;
  phase: "idle" | "running" | "partial" | "complete" | "failed";
  reason?: BatchReason;
  /** Next unused slot id (ids are never reused within a trip). */
  nextSlotId: number;
}

export type BatchEvent =
  | { type: "start"; tripKey: string; totalDays: number }
  | { type: "resume"; tripKey: string; itinerary: Itinerary }
  | { type: "request"; slotId: number }
  | { type: "response"; slotId: number; tripKey: string; resp: BatchResponse }
  | { type: "network-error"; slotId: number; tripKey: string }
  | { type: "retry"; fromDay: number; toDay: number }
  | { type: "auto-retry" }
  | { type: "cancel" };

const MAX_DAY_TRIPS_WIRE = 3;

function clampTotal(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : 1;
  return Math.min(MAX_TRIP_DAYS, Math.max(1, v));
}

function isDayNo(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_TRIP_DAYS;
}

function sortedUnique(list: Iterable<number>): number[] {
  return [...new Set(list)].sort((a, b) => a - b);
}

function rangeOf(fromDay: number, dayCount: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < dayCount; i++) out.push(fromDay + i);
  return out;
}

export function initBatchState(): BatchState {
  return {
    tripKey: "",
    totalDays: 0,
    slots: [],
    days: [],
    verified: [],
    withheld: [],
    pending: [],
    usedPlaces: [],
    dayTripsUsed: 0,
    inFlight: null,
    phase: "idle",
    nextSlotId: 1,
  };
}

/** Contiguous runs of a list of day numbers. */
export function retryRuns(withheld: readonly number[]): Array<{ from: number; to: number }> {
  const days = sortedUnique((Array.isArray(withheld) ? withheld : []).filter(isDayNo));
  const runs: Array<{ from: number; to: number }> = [];
  for (const d of days) {
    const last = runs[runs.length - 1];
    if (last && d === last.to + 1) last.to = d;
    else runs.push({ from: d, to: d });
  }
  return runs;
}

/** Stable key of the inputs that define a trip. */
export function tripKeyOf(ctx: TripContext): string {
  try {
    const c = (ctx ?? {}) as TripContext;
    const str = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const interests = Array.isArray(c.interests)
      ? c.interests.filter((i): i is string => typeof i === "string").map((i) => i.trim().toLowerCase()).sort()
      : [];
    return JSON.stringify([
      str(c.origin),
      str(c.destination),
      num(c.durationDays),
      num(c.travellers?.adults),
      num(c.travellers?.children),
      str(c.budgetLevel),
      str(c.diet),
      str(c.pace),
      interests,
      str(c.selectedFlight?.flightNo),
      str(c.selectedFlight?.date),
    ]);
  } catch {
    return "";
  }
}

/** Names of verified stops, deduplicated by name key, in day order. */
function usedPlacesOf(days: readonly TripDay[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of days) {
    if (!d || !Array.isArray(d.activities)) continue;
    for (const a of d.activities) {
      if (!a || a.verified !== true) continue;
      const name = cleanUsedName(
        typeof a.placeName === "string" && a.placeName.trim() ? a.placeName : a.title,
      );
      if (!name) continue;
      const key = nameKey(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(name);
      if (out.length >= MAX_USED_PLACES) return out;
    }
  }
  return out;
}

interface Draft {
  tripKey: string;
  totalDays: number;
  slots: BatchSlot[];
  days: TripDay[];
  withheld: Iterable<number>;
  inFlight: number | null;
  nextSlotId: number;
  /** Explicit phase; undefined means derive it. */
  phase?: BatchState["phase"];
  reason?: BatchReason;
}

/** Recomputes every derived field so the invariants hold. */
function finalize(d: Draft): BatchState {
  const total = d.totalDays;
  const days = [...d.days].sort((a, b) => a.day - b.day);
  const verifiedSet = new Set(days.map((x) => x.day));
  const withheldSet = new Set<number>();
  for (const w of d.withheld) if (w >= 1 && w <= total && !verifiedSet.has(w)) withheldSet.add(w);
  const pending: number[] = [];
  for (let i = 1; i <= total; i++) if (!verifiedSet.has(i) && !withheldSet.has(i)) pending.push(i);

  const slots = [...d.slots].sort((a, b) => a.fromDay - b.fromDay || a.id - b.id);
  const active = slots.some((s) => s.status === "pending" || s.status === "loading");
  let phase = d.phase;
  if (!phase) {
    if (total > 0 && pending.length === 0 && withheldSet.size === 0) phase = "complete";
    else if (active) phase = "running";
    else phase = withheldSet.size > 0 ? "partial" : "idle";
  }

  const out: BatchState = {
    tripKey: d.tripKey,
    totalDays: total,
    slots,
    days,
    verified: [...verifiedSet].sort((a, b) => a - b),
    withheld: [...withheldSet].sort((a, b) => a - b),
    pending,
    usedPlaces: usedPlacesOf(days),
    dayTripsUsed: days.filter((x) => x.dayTrip === true).length,
    inFlight: d.inFlight,
    phase,
    nextSlotId: d.nextSlotId,
  };
  if (d.reason !== undefined) out.reason = d.reason;
  return out;
}

function draftOf(s: BatchState): Draft {
  return {
    tripKey: s.tripKey,
    totalDays: s.totalDays,
    slots: s.slots.map((x) => ({ ...x })),
    days: s.days,
    withheld: s.withheld,
    inFlight: s.inFlight,
    nextSlotId: s.nextSlotId,
    reason: s.reason,
  };
}

/** Splits a run of days into slots of at most BATCH_DAYS days. */
function slotsForRun(from: number, to: number, firstId: number, rangeAuto?: number): BatchSlot[] {
  const out: BatchSlot[] = [];
  let id = firstId;
  for (let start = from; start <= to; start += BATCH_DAYS) {
    const count = Math.min(BATCH_DAYS, to - start + 1);
    const slot: BatchSlot = { id: id++, fromDay: start, dayCount: count, status: "pending", attempts: 0, auto: 0 };
    if (rangeAuto !== undefined) slot.rangeAuto = rangeAuto;
    out.push(slot);
  }
  return out;
}

export function nextSlot(s: BatchState): BatchSlot | null {
  try {
    if (!s || s.phase !== "running" || s.inFlight !== null) return null;
    let best: BatchSlot | null = null;
    for (const slot of s.slots) {
      if (slot.status !== "pending") continue;
      if (!best || slot.fromDay < best.fromDay || (slot.fromDay === best.fromDay && slot.id < best.id)) best = slot;
    }
    return best;
  } catch {
    return null;
  }
}

export function buildRequest(
  s: BatchState,
  slot: BatchSlot,
  ctx: TripContext,
  startDate?: string,
): BatchRequest {
  const req: BatchRequest = {
    action: "itinerary-batch",
    context: { ...(ctx ?? {}), durationDays: s.totalDays },
    fromDay: slot.fromDay,
    dayCount: slot.dayCount,
    usedPlaces: s.usedPlaces.slice(0, MAX_USED_PLACES),
    dayTripsUsed: Math.min(MAX_DAY_TRIPS_WIRE, Math.max(0, s.dayTripsUsed)),
  };
  if (typeof startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) req.startDate = startDate;
  return req;
}

/** Applies a failure of the in-flight slot. */
function failSlot(
  s: BatchState,
  slotId: number,
  reason: BatchReason,
  allowAuto: boolean,
): BatchState {
  const d = draftOf(s);
  const slot = d.slots.find((x) => x.id === slotId);
  if (!slot) return s;
  d.inFlight = null;
  if (allowAuto && reason !== "not-configured" && slot.auto < AUTO_RETRY_MAX) {
    slot.auto += 1;
    slot.status = "pending";
    return finalize(d);
  }
  slot.status = "failed";
  const withheld = new Set<number>(d.withheld);
  for (const day of rangeOf(slot.fromDay, slot.dayCount)) withheld.add(day);
  d.withheld = withheld;
  d.reason = reason;
  const firstSlot = [...d.slots].sort((a, b) => a.fromDay - b.fromDay || a.id - b.id)[0];
  if (s.days.length === 0 && firstSlot && firstSlot.id === slot.id) d.phase = "failed";
  return finalize(d);
}

function onStart(e: Extract<BatchEvent, { type: "start" }>): BatchState {
  const total = clampTotal(e.totalDays);
  const ranges = batchRanges(total);
  const slots: BatchSlot[] = ranges.map((r, i) => ({
    id: i + 1,
    fromDay: r.fromDay,
    dayCount: r.dayCount,
    status: "pending",
    attempts: 0,
    auto: 0,
  }));
  return finalize({
    tripKey: typeof e.tripKey === "string" ? e.tripKey : "",
    totalDays: total,
    slots,
    days: [],
    withheld: [],
    inFlight: null,
    nextSlotId: slots.length + 1,
    phase: "running",
  });
}

function onResume(e: Extract<BatchEvent, { type: "resume" }>): BatchState {
  const it = e.itinerary;
  const days: TripDay[] = [];
  const seen = new Set<number>();
  const rawDays = it && Array.isArray(it.days) ? it.days : [];
  for (const d of rawDays) {
    if (d && typeof d === "object" && isDayNo(d.day) && !seen.has(d.day)) {
      seen.add(d.day);
      days.push(d);
    }
  }
  const c = it?.completeness;
  let maxDay = 0;
  for (const d of days) maxDay = Math.max(maxDay, d.day);
  const total = c ? clampTotal(c.requestedDays) : clampTotal(maxDay);
  const inRange = days.filter((d) => d.day <= total);
  const verified = new Set(inRange.map((d) => d.day));

  const pendingIn = new Set<number>();
  if (c && Array.isArray(c.pendingDays)) {
    for (const p of c.pendingDays) if (isDayNo(p) && p <= total && !verified.has(p)) pendingIn.add(p);
  }
  const withheld = new Set<number>();
  for (let day = 1; day <= total; day++) {
    if (verified.has(day)) continue;
    // A day that is neither verified nor listed pending is withheld.
    if (!c || !pendingIn.has(day) || (Array.isArray(c.withheldDays) && c.withheldDays.includes(day))) {
      if (c) withheld.add(day);
    }
  }
  if (!c) {
    // No completeness: every stored day is verified, nothing else is known.
    withheld.clear();
  }
  const pendingDays = sortedUnique(
    [...pendingIn].filter((p) => !withheld.has(p)),
  );

  const slots: BatchSlot[] = [];
  let id = 1;
  for (const run of retryRuns(pendingDays)) {
    for (const slot of slotsForRun(run.from, run.to, id)) {
      slots.push(slot);
      id = slot.id + 1;
    }
  }
  return finalize({
    tripKey: typeof e.tripKey === "string" ? e.tripKey : "",
    totalDays: total,
    slots,
    days: inRange,
    withheld,
    inFlight: null,
    nextSlotId: id,
    phase: slots.length > 0 ? "running" : undefined,
  });
}

function onRequest(s: BatchState, e: Extract<BatchEvent, { type: "request" }>): BatchState {
  if (s.inFlight !== null) return s;
  const next = nextSlot(s);
  if (!next || next.id !== e.slotId) return s;
  const d = draftOf(s);
  const slot = d.slots.find((x) => x.id === next.id);
  if (!slot) return s;
  slot.status = "loading";
  slot.attempts += 1;
  d.inFlight = slot.id;
  return finalize(d);
}

function onResponse(s: BatchState, e: Extract<BatchEvent, { type: "response" }>): BatchState {
  if (e.tripKey !== s.tripKey || s.inFlight === null || e.slotId !== s.inFlight) return s;
  const slot = s.slots.find((x) => x.id === s.inFlight);
  if (!slot || slot.status !== "loading") return s;
  const resp = e.resp;
  if (!resp || typeof resp !== "object") return failSlot(s, slot.id, "unavailable", true);

  if (resp.source === "unavailable") {
    const reason: BatchReason =
      resp.reason === "not-configured" || resp.reason === "unverified" || resp.reason === "unavailable"
        ? resp.reason
        : "unavailable";
    // First slot with nothing verified: end in "failed" without an automatic retry.
    const first = s.days.length === 0 && s.slots[0]?.id === slot.id;
    return failSlot(s, slot.id, reason, !first);
  }
  if (resp.source !== "model" || resp.fromDay !== slot.fromDay || resp.dayCount !== slot.dayCount) {
    return failSlot(s, slot.id, "unavailable", true);
  }

  const d = draftOf(s);
  const target = d.slots.find((x) => x.id === slot.id);
  if (!target) return s;
  const slotDays = rangeOf(slot.fromDay, slot.dayCount);
  const have = new Set(s.days.map((x) => x.day));
  const accepted: TripDay[] = [];
  const respDays = Array.isArray(resp.days) ? resp.days : [];
  for (const day of respDays) {
    if (!day || !Array.isArray(day.activities) || !slotDays.includes(day.day) || have.has(day.day)) continue;
    have.add(day.day);
    accepted.push(day);
  }
  d.days = [...s.days, ...accepted];
  const withheld = new Set<number>(s.withheld);
  for (const day of slotDays) {
    if (have.has(day)) withheld.delete(day);
    else withheld.add(day);
  }
  d.withheld = withheld;
  target.status = "done";
  d.inFlight = null;
  return finalize(d);
}

function onNetworkError(s: BatchState, e: Extract<BatchEvent, { type: "network-error" }>): BatchState {
  if (e.tripKey !== s.tripKey || s.inFlight === null || e.slotId !== s.inFlight) return s;
  const slot = s.slots.find((x) => x.id === s.inFlight);
  if (!slot || slot.status !== "loading") return s;
  return failSlot(s, slot.id, "unavailable", true);
}

function onRetry(s: BatchState, e: Extract<BatchEvent, { type: "retry" }>): BatchState {
  if (!Number.isInteger(e.fromDay) || !Number.isInteger(e.toDay) || s.totalDays < 1) return s;
  const lo = Math.min(e.fromDay, e.toDay);
  const hi = Math.max(e.fromDay, e.toDay);
  const verified = new Set(s.verified);
  const targets = s.withheld.filter((w) => w >= lo && w <= hi && !verified.has(w));
  if (targets.length === 0) return s;

  const d = draftOf(s);
  const targetSet = new Set(targets);
  // Failed slots overlapping the retried days are replaced by the new slots.
  d.slots = d.slots.filter(
    (slot) => !(slot.status === "failed" && rangeOf(slot.fromDay, slot.dayCount).some((x) => targetSet.has(x))),
  );
  let id = d.nextSlotId;
  for (const run of retryRuns(targets)) {
    const created = slotsForRun(run.from, run.to, id, RANGE_RETRY_MAX);
    d.slots.push(...created);
    id += created.length;
  }
  d.nextSlotId = id;
  d.withheld = s.withheld.filter((w) => !targetSet.has(w));
  d.reason = undefined;
  d.phase = "running";
  return finalize(d);
}

/**
 * Automatic retry of withheld days that a finished batch did not verify.
 * Each day is retried at most RANGE_RETRY_MAX times (counted on the newest
 * finished slot covering it). Returns `s` itself when nothing is retryable.
 */
function onAutoRetry(s: BatchState): BatchState {
  if (s.reason === "not-configured" || s.inFlight !== null || s.withheld.length === 0) return s;
  const eligible: number[] = [];
  const parentOf = new Map<number, number>();
  for (const day of s.withheld) {
    let parent: BatchSlot | null = null;
    for (const slot of s.slots) {
      if (slot.status !== "done" || day < slot.fromDay || day >= slot.fromDay + slot.dayCount) continue;
      if (!parent || slot.id > parent.id) parent = slot;
    }
    if (!parent) continue;
    const used = parent.rangeAuto ?? 0;
    if (used >= RANGE_RETRY_MAX) continue;
    eligible.push(day);
    parentOf.set(day, used);
  }
  if (eligible.length === 0) return s;

  const d = draftOf(s);
  const targetSet = new Set(eligible);
  let id = d.nextSlotId;
  for (const run of retryRuns(eligible)) {
    // Split further where the retry counts differ, so the cap stays per range.
    let start = run.from;
    for (let day = run.from; day <= run.to; day++) {
      const endOfPart = day === run.to || parentOf.get(day + 1) !== parentOf.get(day);
      if (!endOfPart) continue;
      const created = slotsForRun(start, day, id, (parentOf.get(day) ?? 0) + 1);
      d.slots.push(...created);
      id += created.length;
      start = day + 1;
    }
  }
  d.nextSlotId = id;
  d.withheld = s.withheld.filter((w) => !targetSet.has(w));
  d.phase = undefined;
  return finalize(d);
}

function onCancel(s: BatchState): BatchState {
  const d = draftOf(s);
  d.inFlight = null;
  for (const slot of d.slots) if (slot.status === "loading") slot.status = "pending";
  if (s.phase === "running" || s.phase === "idle") d.phase = "idle";
  else if (s.phase === "failed") d.phase = "failed";
  return finalize(d);
}

export function batchReducer(s: BatchState, e: BatchEvent): BatchState {
  try {
    if (!s || typeof s !== "object") s = initBatchState();
    if (!e || typeof e !== "object") return s;
    switch (e.type) {
      case "start":
        return onStart(e);
      case "resume":
        return onResume(e);
      case "request":
        return onRequest(s, e);
      case "response":
        return onResponse(s, e);
      case "network-error":
        return onNetworkError(s, e);
      case "retry":
        return onRetry(s, e);
      case "auto-retry":
        return onAutoRetry(s);
      case "cancel":
        return onCancel(s);
      default:
        return s;
    }
  } catch {
    return s;
  }
}
