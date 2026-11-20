// SERVER-ONLY. Do not import from a "use client" module: this file pulls in the
// Google Places adapter, the SearXNG enrichment and the environment config.
//
// One places-first `itinerary-batch` run:
//   key check -> centre -> query plan -> Places search (text + nearby) -> filter
//   -> schedule -> widening (at most 2 steps) -> all Places requests finished ->
//   planner (one call, at most one repair) -> enrichment of the final stops -> map.
// Stops come only from Places candidates. Nothing here invents a value.
// Never throws. Writes exactly one counts-only `[itinerary-batch]` line (in
// `finally`) and at most one `[itinerary-batch-diag]` line, only when no day was
// built. No names, queries, URLs, keys, model text or error objects in any line.

import { googlePlacesApiKey } from "@/lib/config";
import type { BedrockModelDeps } from "@/lib/bedrock-model";
import type { LatLng, PlaceCandidate, PostFetchLike } from "@/lib/providers/google-places";
import type { TripContext, TripDay } from "@/lib/types";
import { unavailable, type BatchRequest, type BatchResponse } from "./batch-wire";
import { BATCH_DIAG_TAG, BATCH_LOG_TAG, formatBatchDiag, type DiagInput } from "./batch-diag";
import {
  candidateCache as sharedCandidateCache,
  createPlacesBudget,
  searchNearby,
  searchText,
  type CandidateCache,
  type PlacesBudget,
} from "./candidate-search";
import { filterCandidates } from "./candidate-filter";
import {
  BATCH_DAYS,
  BATCH_REQUEST_BUDGET_MS,
  DAY_WINDOW_START_MIN,
  FINALIZE_RESERVE_MS,
  MAX_PLACES_REQUESTS_PER_BATCH,
  MAX_WIDENING_STEPS,
  MIN_STEP_MS,
  PLACES_PHASE_END_MS,
  RESPONSE_MARGIN_MS,
} from "./constants";
import { enrichStops, type EnrichmentDeps, type EnrichmentResult, type EnrichInput } from "./enrichment";
import { addDays, weekdayOf } from "./hours";
import { planCandidateQueries, widenPlan, type CandidatePlan } from "./interests";
import { batchStats, mapDays, plainDays, polishedDays } from "./map-days";
import { dayLimits, resolvePace } from "./pace";
import { interestRow } from "./place-categories";
import { nameKey } from "./place-key";
import { buildPlannerInput, selectPlannerCandidates } from "./planner";
import type { PlanContext } from "./plan-check";
import { runPlanner, type PlannerState } from "./plan-run";
import { mealKind, parseArrivalMin, scheduleBatch, type DaySpec, type ScheduleResult } from "./scheduler";
import { destinationCentre } from "./verification-cache";

export interface PlacesFirstDeps {
  /** Planner only. Absent: planner is "fallback". */
  invokeModel?: BedrockModelDeps["invokeModel"];
  /** Places (centre and candidate search). */
  fetchImpl?: PostFetchLike;
  now?: () => number;
  /** Default: the Google Places key is configured. */
  hasKey?: () => boolean;
  /** Default console.info. */
  logger?: (line: string) => void;
  /** Counts-only diagnostic line when no day is built. Default console.info. */
  diagLogger?: (line: string) => void;
  /** Default: the process-wide candidate cache. */
  candidateCache?: CandidateCache;
  /** SearXNG enrichment: research, fetchImpl, config, cache, limiter. `now` and `budgetMs` are set here. */
  enrichment?: Omit<EnrichmentDeps, "now" | "budgetMs">;
  /** Default BATCH_REQUEST_BUDGET_MS. */
  budgetMs?: number;
}

type Outcome = "ok" | "partial" | "unavailable" | "not-configured" | "timeout";

interface Tally {
  budget: PlacesBudget | null;
  enrichQueries: number;
  planner: PlannerState;
  repaired: 0 | 1;
  diag: DiagInput | null;
}

interface Run {
  resp: BatchResponse;
  outcome: Outcome;
}

function defaultHasKey(): boolean {
  try {
    return googlePlacesApiKey().length > 0;
  } catch {
    return false;
  }
}

/** Categories for the filter. Free-text interests (not in the table) drop the restriction. */
function categoriesFor(interests: readonly unknown[] | undefined): string[] | undefined {
  const cleaned = (Array.isArray(interests) ? interests : [])
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");
  if (cleaned.length === 0) return undefined;
  const types: string[] = [];
  for (const t of cleaned) {
    const row = interestRow(t);
    if (!row) return undefined;
    for (const x of row.types) if (!types.includes(x)) types.push(x);
  }
  return types;
}

function mergePool(pool: PlaceCandidate[], extra: readonly PlaceCandidate[] | null, seen: Set<string>): void {
  if (!extra) return;
  for (const c of extra) {
    if (!c || typeof c.placeId !== "string" || seen.has(c.placeId)) continue;
    seen.add(c.placeId);
    pool.push(c);
  }
}

function buildSpecs(req: BatchRequest, totalDays: number): DaySpec[] {
  const ctx: TripContext = req.context;
  const flight = ctx.selectedFlight;
  const specs: DaySpec[] = [];
  for (let i = 0; i < req.dayCount; i++) {
    const day = req.fromDay + i;
    const date = req.startDate ? addDays(req.startDate, day - 1) : null;
    let earliestMin = DAY_WINDOW_START_MIN;
    if (day === 1 && flight && (!req.startDate || req.startDate === flight.date)) {
      const arrival = parseArrivalMin(flight.arrive);
      if (arrival !== null) earliestMin = Math.max(DAY_WINDOW_START_MIN, arrival);
    }
    specs.push({
      day,
      date,
      weekday: date ? weekdayOf(date) : null,
      limits: dayLimits(ctx.pace, day, totalDays),
      earliestMin,
    });
  }
  return specs;
}

function belowMinimum(s: ScheduleResult): boolean {
  return s.shortDays.length > 0 || s.emptyDays.length > 0;
}

async function execute(
  req: BatchRequest,
  totalDays: number,
  deps: PlacesFirstDeps,
  now: () => number,
  start: number,
  tally: Tally,
): Promise<Run> {
  const hasKey = deps.hasKey ?? defaultHasKey;
  if (!hasKey()) return { resp: unavailable(req, "not-configured"), outcome: "not-configured" };

  const fullDeadline = start + (deps.budgetMs ?? BATCH_REQUEST_BUDGET_MS);
  const internalDeadline = fullDeadline - RESPONSE_MARGIN_MS;
  const context = req.context;
  const destination = String(context.destination ?? "").trim();
  const interests = context.interests;

  const budget = createPlacesBudget({
    maxRequests: MAX_PLACES_REQUESTS_PER_BATCH,
    deadlineMs: start + PLACES_PHASE_END_MS,
    now,
  });
  tally.budget = budget;
  const sd = { fetchImpl: deps.fetchImpl, cache: deps.candidateCache ?? sharedCandidateCache, now, budget };

  let attempts = 0;
  let failures = 0;
  const flights: Promise<unknown>[] = [];
  const track = (p: Promise<PlaceCandidate[] | null>): Promise<PlaceCandidate[] | null> => {
    attempts += 1;
    const wrapped = p.then((r) => {
      if (r === null) failures += 1;
      return r;
    });
    flights.push(wrapped);
    return wrapped;
  };

  const counts = { closed: 0, outside: 0, duplicate: 0, excludedType: 0 };
  const noDays = (cause: "lookup" | "verify", reason: "unavailable" | "unverified", outcome: Outcome, short = 0): Run => {
    tally.diag = {
      cause,
      parseLen: 0,
      truncated: false,
      prefilter: counts.closed + counts.excludedType,
      duplicate: counts.duplicate,
      lookupFailed: failures,
      noMatch: 0,
      outside: counts.outside,
      tooFew: short,
    };
    return { resp: unavailable(req, reason, now() - start), outcome };
  };

  if (destination === "") return noDays("verify", "unverified", "unavailable");

  // 2. Centre (not counted against the Places budget).
  const centre: LatLng | null = await destinationCentre(destination, now(), deps.fetchImpl);

  // 3-4. Query plan, text searches in parallel, Nearby top-up.
  const batchIndex = Math.max(0, Math.floor((req.fromDay - 1) / BATCH_DAYS));
  const plan: CandidatePlan = planCandidateQueries({ destination, interests, batchIndex });
  const pool: PlaceCandidate[] = [];
  const seen = new Set<string>();
  const searches: Promise<PlaceCandidate[] | null>[] = plan.textQueries.map((q) => track(searchText(q, sd)));
  if (centre) searches.push(track(searchNearby(centre, plan.nearbyRadiusM, plan.nearbyTypes, sd)));
  for (const found of await Promise.all(searches)) mergePool(pool, found, seen);

  // 5-7. Filter, schedule, widen.
  const usedKeys = new Set(req.usedPlaces.map((p) => nameKey(p)));
  const categories = categoriesFor(interests);
  const specs = buildSpecs(req, totalDays);
  const pace = resolvePace(context.pace);
  let kept: PlaceCandidate[] = [];
  let schedule: ScheduleResult = { days: [], shortDays: [], emptyDays: [] };
  const run = (): void => {
    const f = filterCandidates(pool, { destination, centre, usedKeys, categories });
    kept = f.kept;
    counts.closed = f.dropped.closed;
    counts.outside = f.dropped.outside;
    counts.duplicate = f.dropped.duplicate;
    counts.excludedType = f.dropped.excludedType;
    schedule = scheduleBatch({ days: specs, pool: kept, interests, pace });
  };
  run();

  // Step 1: Nearby at twice the radius (needs the centre). Step 2: one combined Text Search.
  const widen = widenPlan(plan, interests, destination);
  const steps: Array<() => Promise<PlaceCandidate[] | null>> = [];
  if (centre) steps.push(() => searchNearby(centre, widen.nearby.radiusM, widen.nearby.types, sd));
  steps.push(() => searchText(widen.text, sd));
  for (const step of steps.slice(0, MAX_WIDENING_STEPS)) {
    if (!belowMinimum(schedule) || budget.rateLimited || now() >= start + PLACES_PHASE_END_MS) break;
    mergePool(pool, await track(step()), seen);
    run();
  }

  // 8. Every Places request has finished before any Bedrock call.
  await Promise.allSettled(flights);

  const proposed = pool.length;
  const stopDays = schedule.days.filter((d) => d.stops.length > 0);
  if (stopDays.length === 0) {
    const short = schedule.emptyDays.length + schedule.shortDays.length;
    const allFailed = attempts === 0 || failures === attempts;
    const late = now() >= internalDeadline;
    if (budget.rateLimited || allFailed || late) {
      return noDays("lookup", "unavailable", late ? "timeout" : "unavailable", short);
    }
    return noDays("verify", "unverified", "unavailable", short);
  }

  // 9. Planner (one call, at most one repair). The deterministic plan is the fallback.
  const sent = selectPlannerCandidates(kept, specs.length);
  const planCtx: PlanContext = {
    days: specs.map((spec) => ({
      spec,
      deterministicCount: schedule.days.find((d) => d.day === spec.day)?.stops.length ?? 0,
    })),
    sent,
    flightDate: context.selectedFlight?.date,
    dates: specs.map((spec) => spec.date),
  };
  const planned = await runPlanner(planCtx, buildPlannerInput(specs, sent, destination), {
    invokeModel: deps.invokeModel,
    now,
    deadline: fullDeadline,
  });
  tally.planner = planned.state;
  tally.repaired = planned.repaired;

  // 10. The accepted plan, or the deterministic plan.
  const mapInput = planned.applied ? polishedDays(planned.applied) : plainDays(schedule, kept);

  // 11. Enrichment of the final stops only, inside the remaining budget.
  const enrichInputs: EnrichInput[] = [];
  for (const d of mapInput) {
    for (const s of d.stops) {
      const c = s.candidate;
      enrichInputs.push({
        placeId: c.placeId,
        name: c.name,
        primaryType: c.primaryType,
        kind: mealKind(c) ? "meal" : "sight",
      });
    }
  }
  const remaining = (): number => fullDeadline - now() - FINALIZE_RESERVE_MS - RESPONSE_MARGIN_MS;
  let enrichment: EnrichmentResult | null = null;
  try {
    const budgetMs = remaining();
    if (budgetMs >= MIN_STEP_MS && enrichInputs.length > 0) {
      enrichment = await enrichStops(
        enrichInputs,
        { destination, budgetLevel: context.budgetLevel },
        { ...(deps.enrichment ?? {}), now, budgetMs },
      );
    }
  } catch {
    enrichment = null;
  }
  tally.enrichQueries = enrichment ? enrichment.queries : 0;

  // 12. Map and stats.
  const mapped = mapDays({
    days: mapInput,
    enrichment: enrichment?.stops,
    sources: enrichment?.sources,
    enrichmentUnavailable: enrichment?.unavailable === true,
    startDate: req.startDate,
    destination,
    flightDate: context.selectedFlight?.date,
  });
  const days: TripDay[] = mapped.days.slice().sort((a, b) => a.day - b.day);
  const ms = Math.max(0, Math.round(now() - start));
  if (days.length === 0) return noDays("verify", "unverified", "unavailable", schedule.emptyDays.length);

  const verifiedDays = days.map((d) => d.day);
  const withheldDays: number[] = [];
  for (let i = 0; i < req.dayCount; i++) {
    if (!verifiedDays.includes(req.fromDay + i)) withheldDays.push(req.fromDay + i);
  }
  const resp: BatchResponse = {
    source: "model",
    fromDay: req.fromDay,
    dayCount: req.dayCount,
    days,
    verifiedDays,
    withheldDays,
    truncated: false,
    stats: batchStats(proposed, days, ms),
  };
  if (mapped.sources.length > 0) resp.sources = mapped.sources;
  return { resp, outcome: withheldDays.length === 0 ? "ok" : "partial" };
}

export async function runPlacesFirstBatch(
  req: BatchRequest,
  totalDays: number,
  deps: PlacesFirstDeps,
): Promise<BatchResponse> {
  const now = typeof deps?.now === "function" ? deps.now : Date.now;
  const tally: Tally = { budget: null, enrichQueries: 0, planner: "fallback", repaired: 0, diag: null };
  let start = 0;
  let run: Run = { resp: unavailable(req, "unavailable"), outcome: "unavailable" };
  try {
    start = now();
    run = await execute(req, totalDays, deps ?? {}, now, start, tally);
  } catch {
    let ms = 0;
    try {
      ms = now() - start;
    } catch {
      ms = 0;
    }
    run = { resp: unavailable(req, "unavailable", ms), outcome: "unavailable" };
  } finally {
    try {
      const r = run.resp;
      const s = r.stats;
      const last = r.fromDay + r.dayCount - 1;
      const places = tally.budget ? tally.budget.sent : 0;
      const cached = tally.budget ? tally.budget.cacheHits : 0;
      const line =
        `${BATCH_LOG_TAG} days=${r.fromDay}-${last} proposed=${s.proposed} verified=${s.verified}` +
        ` removed=${s.removed} ms=${s.ms} places=${places} cached=${cached} enrich=${tally.enrichQueries}` +
        ` planner=${tally.planner} repaired=${tally.repaired} outcome=${run.outcome}`;
      (deps?.logger ?? ((l: string) => console.info(l)))(line);
    } catch {
      // logging never affects the response
    }
    try {
      if (run.resp.days.length === 0 && tally.diag) {
        const line = formatBatchDiag(tally.diag);
        if (line.startsWith(BATCH_DIAG_TAG)) (deps?.diagLogger ?? ((l: string) => console.info(l)))(line);
      }
    } catch {
      // diagnostics never affect the response
    }
  }
  return run.resp;
}
