// SERVER-ONLY. Do not import from a "use client" module or from a pure module:
// this file imports the Google Places adapter (lib/providers/*), which reads the
// API key from the environment. It is the only itinerary module allowed to do so.
//
// Strict Verifier: a proposed name becomes a Stop only when a Google Places Text
// Search result has a placeId, a matching display name and a location inside the
// destination. Never throws. With no Places key nothing is verified and no
// request is made. Only "<place>, <destination>" is ever sent to Google. Place
// names and queries are never logged here.

import { googlePlacesApiKey } from "../config";
import { placeMatches, placeMatchesTolerant } from "../grounding/place-match";
import { VERIFY_CONCURRENCY } from "../grounding/verify-places";
import {
  enrichPlace,
  searchPlaceForVerification,
  type LatLng,
  type PostFetchLike,
  type VerificationCandidate,
  type VerificationLookup,
} from "../providers/google-places";
import { enrichmentCache } from "../providers/enrichment-cache";
import type { ProposedDay, ProposedStop } from "./batch-parse";
import {
  HERO_LOOKUP_RESERVE,
  HERO_TRIES_PER_DAY,
  LOOKUP_TIMEOUT_MS,
  MAX_REPLACEMENTS_PER_BATCH,
  MAX_VERIFY_LOOKUPS_PER_BATCH,
  PASS1_BUDGET_MS,
  VERIFY_RESULTS_PER_LOOKUP,
} from "./constants";
import { dedupeStops } from "./dedupe";
import { isWithinDestination } from "./geo";
import { buildMapsUrl, isValidPhotoRef } from "./maps-link";
import { acceptDayTrips, dayLimits, type Pace } from "./pace";
import {
  isGenericTitle,
  isNonStopTitle,
  isVenueSpecificMeal,
  nameKey,
  type StopKind,
} from "./place-key";
import { evaluateDay, type DayEvaluation, type VerifiedStop } from "./structure";
import { sanitizeDisplayText } from "./text";
import {
  destinationCentre,
  verificationCache,
  type VerificationCache,
} from "./verification-cache";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VerifyDeps {
  fetchImpl?: PostFetchLike;
  now?: () => number;
  cache?: VerificationCache;
  enrich?: typeof enrichPlace;
  concurrency?: number; // default VERIFY_CONCURRENCY
}

export interface VerifyContext {
  destination: string;
  totalDays: number;
  fromDay: number;
  pace: Pace;
  usedKeys: ReadonlySet<string>; // nameKey of Used_Places
  dayTripsAllowed: number;
  deadlineMs: number; // absolute clock time the phase must end by
}

export interface BatchVerification {
  days: Array<{ day: number; title: string; dayTrip: boolean; evaluation: DayEvaluation }>;
  rejected: Array<{ day: number; slot: number; time: string; kind: StopKind; names: string[] }>;
  stats: { proposed: number; lookups: number; removed: number };
  timedOut: boolean;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const PLACE_NAME_CHARS = 100;
const VERIFY_LOOKUP_CAP = MAX_VERIFY_LOOKUPS_PER_BATCH - HERO_LOOKUP_RESERVE;

/** Per-batch memory kept off the public shape: queries that failed or succeeded. */
interface BatchState {
  failed: Set<string>;
  ok: Map<string, VerificationCandidate[]>;
}
const STATES = new WeakMap<object, BatchState>();

interface Entry {
  day: number;
  slot: number;
  stop: ProposedStop;
}

interface Failure {
  day: number;
  slot: number;
  time: string;
  kind: StopKind;
  name: string;
}

interface Resolution {
  accepted: VerifiedStop[];
  acceptedDay: number[]; // parallel to accepted
  failures: Failure[];
  lookups: number;
  timedOut: boolean;
  state: BatchState;
  tallies: RawTallies;
}

/** Counts per drop reason. postDup = duplicates found after a Places answer. */
interface RawTallies {
  prefilter: number;
  duplicate: number;
  lookupFailed: number;
  noMatch: number;
  outside: number;
  postDup: number;
}

function zeroTallies(): RawTallies {
  return { prefilter: 0, duplicate: 0, lookupFailed: 0, noMatch: 0, outside: 0, postDup: 0 };
}

function addTallies(a: RawTallies, b: RawTallies): RawTallies {
  return {
    prefilter: a.prefilter + b.prefilter,
    duplicate: a.duplicate + b.duplicate,
    lookupFailed: a.lookupFailed + b.lookupFailed,
    noMatch: a.noMatch + b.noMatch,
    outside: a.outside + b.outside,
    postDup: a.postDup + b.postDup,
  };
}

function clock(deps?: VerifyDeps): () => number {
  return deps && typeof deps.now === "function" ? deps.now : Date.now;
}

function queryKey(query: string): string {
  return query.trim().toLowerCase();
}

function hasPlacesKey(): boolean {
  try {
    return googlePlacesApiKey().length > 0;
  } catch {
    return false;
  }
}

function withheldDay(
  day: number,
  title: string,
  dayTrip: boolean,
): BatchVerification["days"][number] {
  return {
    day,
    title,
    dayTrip,
    evaluation: { status: "withheld", stops: [], removed: [], reason: "too-few" },
  };
}

function stripTravel(s: VerifiedStop & { travelToNextMin?: number }): VerifiedStop {
  const { travelToNextMin: _ignored, ...rest } = s;
  void _ignored;
  return rest;
}

function failureOf(e: Entry): Failure {
  return {
    day: e.day,
    slot: e.slot,
    time: e.stop.time,
    kind: e.stop.kind,
    name: e.stop.place,
  };
}

/**
 * Steps 1 to 4 and the post-lookup dedupe for a list of proposed stops.
 * `dayTripOf` says whether a day may use the day-trip radius. `usedKeys` are
 * name keys to drop, `usedIds` are placeIds already accepted in the batch.
 */
async function resolveEntries(
  entries: readonly Entry[],
  ctx: VerifyContext,
  deps: VerifyDeps | undefined,
  state: BatchState,
  lookupsSoFar: number,
  passDeadline: number,
  dayTripOf: (day: number) => boolean,
  usedKeys: ReadonlySet<string>,
  usedIds: ReadonlySet<string>,
): Promise<Resolution> {
  const now = clock(deps);
  const cache = deps?.cache ?? verificationCache;
  const failures: Failure[] = [];
  const tallies = zeroTallies();

  // 1. pre-filter: no lookup is spent on these
  const survivors: Entry[] = [];
  for (const e of entries) {
    const place = e.stop.place;
    const rejected =
      isGenericTitle(place) ||
      isNonStopTitle(place, { destination: ctx.destination }) ||
      (e.stop.kind === "meal" && !isVenueSpecificMeal(place));
    if (rejected) {
      failures.push(failureOf(e));
      tallies.prefilter += 1;
    } else survivors.push(e);
  }

  // dedupe by nameKey against used keys and earlier stops of the batch
  const keyed = survivors.map((e) => ({ e, key: nameKey(e.stop.place), isStop: true }));
  const split = dedupeStops(keyed, usedKeys);
  for (const d of split.dropped) {
    failures.push(failureOf(d.e));
    tallies.duplicate += 1;
  }
  const kept = split.kept.map((k) => k.e);

  // 2. queries: distinct "<place>, <destination>" strings in day order
  const resolved = new Map<string, VerificationCandidate[] | "failed">();
  const toLookup: Array<{ query: string; qk: string }> = [];
  const queryOf = (e: Entry): string => `${e.stop.place}, ${ctx.destination}`;
  for (const e of kept) {
    const query = queryOf(e);
    const qk = queryKey(query);
    if (resolved.has(qk) || toLookup.some((t) => t.qk === qk)) continue;
    const memo = state.ok.get(qk);
    if (memo) {
      resolved.set(qk, memo);
      continue;
    }
    if (state.failed.has(qk)) {
      resolved.set(qk, "failed"); // never retried inside a batch
      continue;
    }
    const cached = cache.get(query, now());
    if (cached) {
      state.ok.set(qk, cached);
      resolved.set(qk, cached);
      continue;
    }
    toLookup.push({ query, qk });
  }

  // 3. lookups: capped, worker pool, aborted at the pass deadline
  const budget = Math.max(0, VERIFY_LOOKUP_CAP - lookupsSoFar);
  const runnable = toLookup.slice(0, budget);
  for (const over of toLookup.slice(budget)) {
    state.failed.add(over.qk); // beyond the cap is a failed verification
    resolved.set(over.qk, "failed");
  }

  let lookups = 0;
  let abandoned = false;
  if (runnable.length > 0) {
    const controller = new AbortController();
    const abortedP = new Promise<"abort">((resolve) => {
      controller.signal.addEventListener("abort", () => resolve("abort"), { once: true });
    });
    const remaining = passDeadline - now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (remaining <= 0) controller.abort();
    else timer = setTimeout(() => controller.abort(), remaining);

    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < runnable.length) {
        const item = runnable[next++];
        if (controller.signal.aborted) {
          abandoned = true;
          state.failed.add(item.qk);
          resolved.set(item.qk, "failed");
          continue;
        }
        lookups += 1;
        let outcome: VerificationLookup | "abort";
        try {
          const timeoutMs = Math.max(1, Math.min(LOOKUP_TIMEOUT_MS, passDeadline - now()));
          outcome = await Promise.race([
            searchPlaceForVerification(item.query, deps?.fetchImpl, {
              timeoutMs,
              signal: controller.signal,
              maxResults: VERIFY_RESULTS_PER_LOOKUP,
            }),
            abortedP,
          ]);
        } catch {
          outcome = { kind: "failed" };
        }
        if (outcome === "abort") {
          abandoned = true;
          state.failed.add(item.qk);
          resolved.set(item.qk, "failed");
        } else if (outcome.kind === "ok") {
          const list = outcome.candidates.slice(0, VERIFY_RESULTS_PER_LOOKUP);
          state.ok.set(item.qk, list);
          resolved.set(item.qk, list);
          try {
            cache.set(item.query, list, now()); // successes only
          } catch {
            // cache writes never block verification
          }
        } else {
          state.failed.add(item.qk); // no retry, no caching of failures
          resolved.set(item.qk, "failed");
        }
      }
    };
    try {
      const size = Math.max(
        1,
        Math.min(
          runnable.length,
          Math.floor(
            deps && typeof deps.concurrency === "number" && deps.concurrency >= 1
              ? deps.concurrency
              : VERIFY_CONCURRENCY,
          ),
        ),
      );
      const pool: Promise<void>[] = [];
      for (let i = 0; i < size; i++) pool.push(worker());
      await Promise.all(pool);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // 4. accept the first of at most 3 candidates that passes every check
  let centreMemo: LatLng | null | undefined;
  const getCentre = async (): Promise<LatLng | null> => {
    if (centreMemo !== undefined) return centreMemo;
    if (now() >= ctx.deadlineMs) return null; // not memoised: no time left
    try {
      centreMemo = await destinationCentre(ctx.destination, now(), deps?.fetchImpl);
    } catch {
      centreMemo = null;
    }
    return centreMemo;
  };

  const accepted: VerifiedStop[] = [];
  const acceptedDay: number[] = [];
  const seenIds = new Set<string>(usedIds);
  for (const e of kept) {
    const query = queryOf(e);
    const found = resolved.get(queryKey(query));
    const candidates = Array.isArray(found) ? found.slice(0, VERIFY_RESULTS_PER_LOOKUP) : [];
    const dayTrip = dayTripOf(e.day);
    let verified: VerifiedStop | null = null;
    let sawNameMatch = false;

    for (const c of candidates) {
      if (!c || typeof c.placeId !== "string" || c.placeId.length === 0) continue;
      if (!c.location) continue;
      if (
        !placeMatches(e.stop.place, [c.displayName]) &&
        !placeMatchesTolerant(e.stop.place, c.displayName, ctx.destination)
      ) {
        continue;
      }
      const placeName = sanitizeDisplayText(c.displayName, PLACE_NAME_CHARS);
      if (placeName.length === 0) continue;
      sawNameMatch = true;
      const probe = { address: c.formattedAddress, location: c.location };
      let inside = isWithinDestination(probe, ctx.destination, null, dayTrip);
      if (!inside) inside = isWithinDestination(probe, ctx.destination, await getCentre(), dayTrip);
      if (!inside) continue;
      verified = {
        key: c.placeId,
        placeId: c.placeId,
        placeName,
        mapsUrl: buildMapsUrl(c.placeId, placeName),
        location: { lat: c.location.lat, lng: c.location.lng },
        time: e.stop.time,
        place: e.stop.place,
        area: e.stop.area,
        kind: e.stop.kind,
        description: e.stop.description,
        cost: e.stop.cost,
        slot: e.slot,
      };
      break;
    }

    if (!verified) {
      failures.push(failureOf(e));
      if (found === "failed") tallies.lookupFailed += 1;
      else if (sawNameMatch) tallies.outside += 1;
      else tallies.noMatch += 1;
      continue;
    }
    // post-lookup dedupe by placeId, and by the Google name against Used_Places
    // (an alias of a place verified in an earlier batch resolves to that name)
    if (seenIds.has(verified.placeId) || usedKeys.has(nameKey(verified.placeName))) {
      failures.push(failureOf(e));
      tallies.duplicate += 1;
      tallies.postDup += 1;
      continue;
    }
    seenIds.add(verified.placeId);
    try {
      enrichmentCache.setPlaceId(query, verified.placeId);
    } catch {
      // cache writes never block verification
    }
    accepted.push(verified);
    acceptedDay.push(e.day);
  }

  return {
    accepted,
    acceptedDay,
    failures,
    lookups,
    timedOut: abandoned,
    state,
    tallies,
  };
}

/** Why stops were dropped, as counts only (no names, queries or errors). */
export interface FailureTallies {
  prefilter: number;
  duplicate: number;
  lookupFailed: number;
  noMatch: number;
  outside: number;
  tooFew: number;
}
const KINDS = new WeakMap<object, RawTallies>();

/** Per-reason drop counts for a verification. tooFew = days withheld by evaluateDay. */
export function failureTallies(v: BatchVerification): FailureTallies {
  const k = KINDS.get(v) ?? zeroTallies();
  const tooFew = v.days.filter((d) => d.evaluation.status === "withheld").length;
  return {
    prefilter: k.prefilter,
    duplicate: k.duplicate,
    lookupFailed: k.lookupFailed,
    noMatch: k.noMatch,
    outside: k.outside,
    tooFew,
  };
}

/**
 * True when at least one stop was lost to a failed Places lookup (429, 403,
 * 5xx, throw, abort, cap) and no stop was rejected after Places answered
 * (no name match, outside the destination, or a duplicate place).
 */
export function droppedByLookupFailure(v: BatchVerification): boolean {
  const k = KINDS.get(v);
  return !!k && k.lookupFailed > 0 && k.noMatch + k.outside + k.postDup === 0;
}

function evaluateFor(
  stops: readonly VerifiedStop[],
  ctx: VerifyContext,
  day: number,
  dayTrip: boolean,
): DayEvaluation {
  const ordered = stops.slice().sort((a, b) => a.slot - b.slot);
  return evaluateDay(ordered, dayLimits(ctx.pace, day, ctx.totalDays), { dayTrip });
}

/** Slots to repair: days below target, up to MAX_REPLACEMENTS_PER_BATCH in total. */
function collectRejected(
  days: BatchVerification["days"],
  proposedLen: ReadonlyMap<number, number>,
  failures: readonly Failure[],
  ctx: VerifyContext,
): BatchVerification["rejected"] {
  const out: BatchVerification["rejected"] = [];
  for (const d of days) {
    if (out.length >= MAX_REPLACEMENTS_PER_BATCH) break;
    const target = dayLimits(ctx.pace, d.day, ctx.totalDays).target;
    const need = target - d.evaluation.stops.length;
    if (need <= 0) continue;

    const freed = new Map<number, { slot: number; time: string; kind: StopKind }>();
    const names: string[] = [];
    for (const f of failures) {
      if (f.day !== d.day) continue;
      freed.set(f.slot, { slot: f.slot, time: f.time, kind: f.kind });
      names.push(f.name);
    }
    for (const r of d.evaluation.removed) {
      freed.set(r.slot, { slot: r.slot, time: r.time, kind: r.kind });
      names.push(r.placeName);
    }
    const slots = Array.from(freed.values()).sort((a, b) => a.slot - b.slot);
    let pad = proposedLen.get(d.day) ?? 0;
    for (const s of slots) if (s.slot >= pad) pad = s.slot + 1;
    while (slots.length < need) slots.push({ slot: pad++, time: "", kind: "sight" });

    for (const s of slots.slice(0, need)) {
      if (out.length >= MAX_REPLACEMENTS_PER_BATCH) break;
      out.push({ day: d.day, slot: s.slot, time: s.time, kind: s.kind, names: names.slice() });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// verifyProposed
// ---------------------------------------------------------------------------

export async function verifyProposed(
  days: readonly ProposedDay[],
  ctx: VerifyContext,
  deps?: VerifyDeps,
): Promise<BatchVerification> {
  const list = Array.isArray(days) ? days : [];
  const proposed = list.reduce(
    (n, d) => n + (d && Array.isArray(d.stops) ? d.stops.length : 0),
    0,
  );
  const allWithheld = (): BatchVerification => ({
    days: list.map((d, i) =>
      withheldDay(ctx.fromDay + i, d && typeof d.title === "string" ? d.title : "", false),
    ),
    rejected: [],
    stats: { proposed, lookups: 0, removed: proposed },
    timedOut: false,
  });

  try {
    if (!hasPlacesKey()) return allWithheld(); // verifies nothing, sends nothing

    const now = clock(deps);
    const flags = acceptDayTrips(
      list.map((d) => !!(d && d.dayTrip === true)),
      ctx.dayTripsAllowed,
    );
    const dayTripByDay = new Map<number, boolean>();
    const proposedLen = new Map<number, number>();
    const entries: Entry[] = [];
    list.forEach((d, i) => {
      const day = ctx.fromDay + i;
      dayTripByDay.set(day, flags[i] === true);
      const stops: ProposedStop[] = d && Array.isArray(d.stops) ? d.stops : [];
      proposedLen.set(day, stops.length);
      stops.forEach((stop, slot) => entries.push({ day, slot, stop }));
    });

    const state: BatchState = { failed: new Set(), ok: new Map() };
    const passDeadline = Math.min(ctx.deadlineMs, now() + PASS1_BUDGET_MS);
    const res = await resolveEntries(
      entries,
      ctx,
      deps,
      state,
      0,
      passDeadline,
      (day) => dayTripByDay.get(day) === true,
      new Set(ctx.usedKeys),
      new Set<string>(),
    );

    const outDays: BatchVerification["days"] = list.map((d, i) => {
      const day = ctx.fromDay + i;
      const dayTrip = dayTripByDay.get(day) === true;
      const stops = res.accepted.filter((_, k) => res.acceptedDay[k] === day);
      return {
        day,
        title: d && typeof d.title === "string" ? d.title : "",
        dayTrip,
        evaluation: evaluateFor(stops, ctx, day, dayTrip),
      };
    });

    const verifiedCount = outDays.reduce((n, d) => n + d.evaluation.stops.length, 0);
    const result: BatchVerification = {
      days: outDays,
      rejected: collectRejected(outDays, proposedLen, res.failures, ctx),
      stats: { proposed, lookups: res.lookups, removed: Math.max(0, proposed - verifiedCount) },
      timedOut: res.timedOut,
    };
    STATES.set(result, state);
    KINDS.set(result, res.tallies);
    return result;
  } catch {
    return allWithheld();
  }
}

// ---------------------------------------------------------------------------
// verifyReplacements
// ---------------------------------------------------------------------------

export async function verifyReplacements(
  prior: BatchVerification,
  replacements: Array<{ day: number; slot: number; stop: ProposedStop }>,
  ctx: VerifyContext,
  deps?: VerifyDeps,
): Promise<BatchVerification> {
  try {
    if (!hasPlacesKey()) return prior;
    const known = new Map<number, BatchVerification["days"][number]>();
    for (const d of prior.days) known.set(d.day, d);

    const entries: Entry[] = [];
    for (const r of Array.isArray(replacements) ? replacements : []) {
      if (!r || !r.stop || !known.has(r.day)) continue;
      if (entries.length >= MAX_REPLACEMENTS_PER_BATCH) break;
      entries.push({ day: r.day, slot: r.slot, stop: r.stop });
    }
    if (entries.length === 0) return prior;

    // used keys extended by everything already accepted in the batch
    const usedKeys = new Set<string>(ctx.usedKeys);
    const usedIds = new Set<string>();
    for (const d of prior.days) {
      // removed stops count too, so a replacement never reuses their placeId
      for (const s of [...d.evaluation.stops, ...d.evaluation.removed]) {
        usedKeys.add(nameKey(s.place));
        usedKeys.add(nameKey(s.placeName));
        usedIds.add(s.placeId);
      }
    }

    const earlier = STATES.get(prior);
    const state: BatchState = {
      failed: new Set(earlier ? earlier.failed : []),
      ok: new Map(earlier ? earlier.ok : []),
    };
    const res = await resolveEntries(
      entries,
      ctx,
      deps,
      state,
      prior.stats.lookups,
      ctx.deadlineMs,
      (day) => known.get(day)?.dayTrip === true,
      usedKeys,
      usedIds,
    );

    const outDays = prior.days.map((d) => {
      const fresh = res.accepted.filter((_, k) => res.acceptedDay[k] === d.day);
      if (fresh.length === 0) return d;
      const union = d.evaluation.stops.map(stripTravel).concat(fresh);
      return { ...d, evaluation: evaluateFor(union, ctx, d.day, d.dayTrip) };
    });

    const proposed = prior.stats.proposed + entries.length;
    const verifiedCount = outDays.reduce((n, d) => n + d.evaluation.stops.length, 0);
    const result: BatchVerification = {
      days: outDays,
      rejected: [], // the repair round runs once, so nothing is left to repair
      stats: {
        proposed,
        lookups: prior.stats.lookups + res.lookups,
        removed: Math.max(0, proposed - verifiedCount),
      },
      timedOut: prior.timedOut || res.timedOut,
    };
    STATES.set(result, state);
    KINDS.set(result, addTallies(KINDS.get(prior) ?? zeroTallies(), res.tallies));
    return result;
  } catch {
    return prior;
  }
}

// ---------------------------------------------------------------------------
// attachHeroes
// ---------------------------------------------------------------------------

/** Like attachHeroes, but also says which stop (placeId) supplied each day's photo. */
export async function attachHeroStops(
  days: BatchVerification["days"],
  ctx: VerifyContext,
  deps?: VerifyDeps,
): Promise<Map<number, { photoRef: string; placeId: string }>> {
  const out = new Map<number, { photoRef: string; placeId: string }>();
  try {
    if (!hasPlacesKey()) return out;
    const now = clock(deps);
    const enrich = deps?.enrich ?? enrichPlace;
    const memo = new Map<string, Awaited<ReturnType<typeof enrichPlace>>>();
    let used = 0; // lookups spent from the hero reserve

    const timeLeft = (): number => ctx.deadlineMs - now();
    const cleanups: Array<() => void> = [];
    const deadlineP = new Promise<"deadline">((resolve) => {
      const t = setTimeout(() => resolve("deadline"), Math.max(0, timeLeft()));
      cleanups.push(() => clearTimeout(t));
    });

    const doDay = async (d: BatchVerification["days"][number]): Promise<void> => {
      if (d.evaluation.status !== "verified") return;
      let tries = 0;
      for (const stop of d.evaluation.stops) {
        if (tries >= HERO_TRIES_PER_DAY) return;
        if (used >= HERO_LOOKUP_RESERVE || timeLeft() <= 0) return;
        tries += 1;
        used += 1; // reserve a lookup before the call
        let mode = "fallback";
        let photo: unknown;
        try {
          const result = await Promise.race([
            enrich({ placeId: stop.placeId }, deps?.fetchImpl, memo),
            deadlineP,
          ]);
          if (result === "deadline") return;
          mode = result.mode;
          photo = result.data?.photos?.[0]?.name;
        } catch {
          // a failed hero lookup just leaves the day without a photo
        }
        if (mode === "cached") used -= 1; // a cache-served result costs no lookup
        if (isValidPhotoRef(photo)) {
          out.set(d.day, { photoRef: photo, placeId: stop.placeId });
          return;
        }
      }
    };

    try {
      await Promise.all((Array.isArray(days) ? days : []).map((d) => doDay(d)));
    } finally {
      for (const c of cleanups) c();
    }
  } catch {
    // never throws; whatever was found stays
  }
  return out;
}

export async function attachHeroes(
  days: BatchVerification["days"],
  ctx: VerifyContext,
  deps?: VerifyDeps,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const detailed = await attachHeroStops(days, ctx, deps);
  detailed.forEach((v, day) => out.set(day, v.photoRef));
  return out;
}
