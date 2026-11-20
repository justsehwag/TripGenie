// SERVER-ONLY. Do not import from a "use client" module: this file pulls in the
// verifier, the Google Places adapter and the environment config.
//
// One `itinerary-batch` run: key check, grounding (first batch), generation,
// parse, strict verification, one repair round, hero photos, mapping to
// TripDay[] and the Completeness partition. Never throws. Logs exactly one
// counts-only line: no place names, queries, keys or error objects.

import { generateBatch, type BedrockModelDeps } from "@/lib/bedrock-model";
import { googlePlacesApiKey } from "@/lib/config";
import { toSourceLinks } from "@/lib/grounding/sources";
import { EMPTY_BUNDLE, type GroundingBundle } from "@/lib/grounding/types";
import type { PostFetchLike } from "@/lib/providers/google-places";
import type { Activity, SourceLink, TripContext, TripDay } from "@/lib/types";
import { unavailable, type BatchReason, type BatchRequest, type BatchResponse } from "./batch-wire";
import { parseBatchText, parseRepairText } from "./batch-parse";
import {
  BATCH_REQUEST_BUDGET_MS,
  GEN_TIMEOUT_MS,
  MIN_STEP_MS,
  REPAIR_MIN_MS,
  REPAIR_TIMEOUT_MS,
  RESPONSE_MARGIN_MS,
  VERIFY_BUDGET_MS,
} from "./constants";
import { groundOnce } from "./grounding-memo";
import { maxDayTrips, resolvePace } from "./pace";
import { nameKey } from "./place-key";
import { buildBatchPrompt, buildRepairPrompt, type RepairSlot } from "./prompt";
import { sanitizeDisplayText } from "./text";
import type { VerificationCache } from "./verification-cache";
import {
  attachHeroStops,
  droppedByLookupFailure,
  failureTallies,
  verifyProposed,
  verifyReplacements,
  type BatchVerification,
  type VerifyContext,
  type VerifyDeps,
} from "./verifier";

import { BATCH_DIAG_TAG, BATCH_LOG_TAG, formatBatchDiag, type DiagCause, type DiagInput } from "./batch-diag";

// Re-exported so existing imports and tests keep working unchanged.
export { BATCH_DIAG_TAG, BATCH_LOG_TAG, formatBatchDiag };
export type { DiagCause, DiagInput };

export interface BatchDeps {
  invokeModel: BedrockModelDeps["invokeModel"];
  fetchImpl?: PostFetchLike;
  now?: () => number;
  /** Default: the Google Places key is configured. */
  hasKey?: () => boolean;
  ground?: (c: TripContext) => Promise<GroundingBundle>;
  verificationCache?: VerificationCache;
  /** Default console.info. */
  logger?: (line: string) => void;
  /** Receives the counts-only diagnostic line when no day verifies. Default console.info. */
  diagLogger?: (line: string) => void;
  /** Default BATCH_REQUEST_BUDGET_MS. */
  budgetMs?: number;
}

type Outcome = "ok" | "partial" | "unavailable" | "not-configured" | "timeout";

interface Run {
  resp: BatchResponse;
  outcome: Outcome;
}

const PLACE_CHARS = 100;
const AREA_CHARS = 60;
const DESC_CHARS = 160;
const TITLE_CHARS = 80;

function isoDatePlus(start: string | undefined, offsetDays: number): string {
  if (typeof start !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return "";
  const t = Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1, Number(start.slice(8, 10)));
  const d = new Date(t + offsetDays * 86_400_000);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function defaultHasKey(): boolean {
  try {
    return googlePlacesApiKey().length > 0;
  } catch {
    return false;
  }
}

function costInt(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}

function distinctAreas(areas: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of areas) {
    const k = nameKey(a);
    if (!a || !k || seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

const DAY_PREFIX = /^\s*day\s*\d+\s*[:\-–—]\s*/i;

/** Removes a leading "Day N:" / "Day N -" / "Day N –" / "Day N —" label. */
export function stripDayPrefix(raw: string): string {
  let s = raw;
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(DAY_PREFIX, "");
  }
  return s;
}

/** Pairwise-distinct, area-based day title within the batch. */
export function uniqueTitle(
  raw: string,
  areas: readonly string[],
  day: number,
  taken: Set<string>,
): string {
  const base = sanitizeDisplayText(stripDayPrefix(raw), TITLE_CHARS);
  const area = areas[0] ?? "";
  const candidates = [base, area ? `${area} day` : "", area ? `${area} day ${day}` : "", `Day ${day}`];
  for (const c of candidates) {
    const text = sanitizeDisplayText(c, TITLE_CHARS);
    const k = nameKey(text);
    if (text && k && !taken.has(k)) {
      taken.add(k);
      return text;
    }
  }
  const fallback = `Day ${day} plan`;
  taken.add(nameKey(fallback));
  return fallback;
}

function toTripDays(
  verification: BatchVerification,
  heroes: Map<number, { photoRef: string; placeId: string }>,
  startDate: string | undefined,
): TripDay[] {
  const days: TripDay[] = [];
  const taken = new Set<string>();
  for (const d of verification.days) {
    const ev = d.evaluation;
    if (ev.status !== "verified" || ev.stops.length === 0) continue;
    const hero = heroes.get(d.day);
    const areas = ev.stops.map((s) => sanitizeDisplayText(s.area, AREA_CHARS));
    const activities: Activity[] = ev.stops.map((s) => {
      const name = sanitizeDisplayText(s.placeName, PLACE_CHARS);
      const act: Activity = {
        time: sanitizeDisplayText(s.time, 20) || "09:00",
        title: name,
        description: sanitizeDisplayText(s.description, DESC_CHARS) || name,
        cost: costInt(s.cost),
        area: sanitizeDisplayText(s.area, AREA_CHARS),
        placeId: s.placeId,
        placeName: name,
        verified: true,
        mapsUrl: s.mapsUrl,
        location: { lat: s.location.lat, lng: s.location.lng },
      };
      if (hero && hero.placeId === s.placeId) act.photoRef = hero.photoRef;
      if (typeof s.travelToNextMin === "number" && Number.isFinite(s.travelToNextMin)) {
        act.travelToNextMin = Math.max(0, Math.round(s.travelToNextMin));
      }
      return act;
    });
    const day: TripDay = {
      day: d.day,
      date: isoDatePlus(startDate, d.day - 1),
      title: uniqueTitle(d.title, areas, d.day, taken),
      theme: distinctAreas(areas).slice(0, 3).join(" · "),
      activities,
      total: activities.reduce((n, a) => n + a.cost, 0),
    };
    if (d.dayTrip) day.dayTrip = true;
    days.push(day);
  }
  return days;
}

function repairSlots(v: BatchVerification): RepairSlot[] {
  return v.rejected.map((r) => ({
    day: r.day,
    slot: r.slot,
    time: r.time,
    kind: r.kind,
    rejected: r.names,
  }));
}

async function execute(
  req: BatchRequest,
  totalDays: number,
  deps: BatchDeps,
  now: () => number,
  startedAt: number,
): Promise<Run> {
  const hasKey = deps.hasKey ?? defaultHasKey;
  if (!hasKey()) return { resp: unavailable(req, "not-configured"), outcome: "not-configured" };

  const deadline = startedAt + (deps.budgetMs ?? BATCH_REQUEST_BUDGET_MS);
  const fail = (reason: BatchReason, outcome: Outcome, proposed = 0): Run => {
    const resp = unavailable(req, reason, now() - startedAt);
    resp.stats.proposed = proposed;
    resp.stats.removed = proposed;
    return { resp, outcome };
  };

  const context = req.context;
  const first = req.fromDay === 1;
  // Grounding may never eat the time the generation and verification steps
  // need: past that point the batch goes on with an empty bundle (or fails
  // below when too little time is left).
  const groundCapMs = Math.max(0, deadline - now() - VERIFY_BUDGET_MS - RESPONSE_MARGIN_MS - MIN_STEP_MS);
  let groundTimer: ReturnType<typeof setTimeout> | undefined;
  const bundle = await Promise.race<GroundingBundle>([
    groundOnce(context, first, { ground: deps.ground, now: deps.now }),
    new Promise<GroundingBundle>((resolve) => {
      groundTimer = setTimeout(() => resolve(EMPTY_BUNDLE("unavailable")), groundCapMs);
    }),
  ]);
  if (groundTimer !== undefined) clearTimeout(groundTimer);
  const grounded = bundle.status === "ok" || bundle.status === "partial";

  const genTimeout = Math.min(GEN_TIMEOUT_MS, deadline - now() - VERIFY_BUDGET_MS - RESPONSE_MARGIN_MS);
  if (genTimeout < MIN_STEP_MS) return fail("unavailable", "timeout");

  const dayTripsAllowed = Math.max(0, maxDayTrips(totalDays) - (req.dayTripsUsed ?? 0));
  const prompt = {
    ...buildBatchPrompt({
      context,
      fromDay: req.fromDay,
      dayCount: req.dayCount,
      totalDays,
      usedPlaces: req.usedPlaces,
      dayTripsAllowed,
      grounding: grounded ? bundle : undefined,
    }),
    timeoutMs: genTimeout,
  };
  const gen = await generateBatch({ invokeModel: deps.invokeModel }, prompt);
  const parsed = parseBatchText(gen.text, req.dayCount);
  const emitDiag = (cause: DiagCause, v?: BatchVerification): void => {
    try {
      const t = v
        ? failureTallies(v)
        : { prefilter: 0, duplicate: 0, lookupFailed: 0, noMatch: 0, outside: 0, tooFew: 0 };
      const line = formatBatchDiag({
        cause,
        parseLen: typeof gen.text === "string" ? gen.text.length : 0,
        truncated: parsed.truncated === true,
        ...t,
      });
      (deps.diagLogger ?? ((l: string) => console.info(l)))(line);
    } catch {
      // diagnostics never affect the response
    }
  };
  if (parsed.days.length === 0) {
    emitDiag("parse");
    return fail(gen.text.trim().length > 0 ? "unverified" : "unavailable", "unavailable");
  }

  const phaseDeadline = Math.min(now() + VERIFY_BUDGET_MS, deadline - RESPONSE_MARGIN_MS);
  const vctx: VerifyContext = {
    destination: String(context.destination ?? ""),
    totalDays,
    fromDay: req.fromDay,
    pace: resolvePace(context.pace),
    usedKeys: new Set(req.usedPlaces.map((p) => nameKey(p))),
    dayTripsAllowed,
    deadlineMs: phaseDeadline,
  };
  const vdeps: VerifyDeps = { fetchImpl: deps.fetchImpl, now: deps.now, cache: deps.verificationCache };

  let verification = await verifyProposed(parsed.days, vctx, vdeps);

  // One repair round, only when something was rejected and enough time remains.
  const slots = repairSlots(verification);
  if (slots.length > 0 && phaseDeadline - now() >= REPAIR_MIN_MS) {
    const keptNames: string[] = [];
    for (const d of verification.days) {
      for (const s of d.evaluation.stops) keptNames.push(s.place, s.placeName);
    }
    const avoid = slots.flatMap((s) => s.rejected);
    const repairPrompt = {
      ...buildRepairPrompt({
        context,
        slots,
        usedPlaces: [...req.usedPlaces, ...keptNames],
        avoid,
      }),
      timeoutMs: Math.min(REPAIR_TIMEOUT_MS, phaseDeadline - now()),
    };
    const rep = await generateBatch({ invokeModel: deps.invokeModel }, repairPrompt);
    const replacements = parseRepairText(rep.text);
    if (replacements.length > 0) {
      verification = await verifyReplacements(verification, replacements, vctx, vdeps);
    }
  }

  const heroes = await attachHeroStops(verification.days, vctx, vdeps);
  const days = toTripDays(verification, heroes, req.startDate);

  const verifiedDays = days.map((d) => d.day);
  const withheldDays: number[] = [];
  for (let i = 0; i < req.dayCount; i++) {
    const day = req.fromDay + i;
    if (!verifiedDays.includes(day)) withheldDays.push(day);
  }
  const verifiedStops = days.reduce((n, d) => n + d.activities.length, 0);
  const proposed = verification.stats.proposed;
  const stats = {
    proposed,
    verified: verifiedStops,
    removed: Math.max(0, proposed - verifiedStops),
    ms: Math.max(0, Math.round(now() - startedAt)),
  };

  if (days.length === 0) {
    // Places never answered (every drop was a failed lookup): say so honestly.
    const lookupLoss = verification.timedOut || droppedByLookupFailure(verification);
    const timedOut = lookupLoss || !gen.ok;
    emitDiag(lookupLoss ? "lookup" : "verify", verification);
    const resp = unavailable(req, timedOut ? "unavailable" : "unverified", stats.ms);
    resp.stats = stats;
    resp.truncated = parsed.truncated;
    return { resp, outcome: verification.timedOut ? "timeout" : "unavailable" };
  }

  const resp: BatchResponse = {
    source: "model",
    fromDay: req.fromDay,
    dayCount: req.dayCount,
    days,
    verifiedDays,
    withheldDays,
    truncated: parsed.truncated,
    stats,
  };
  if (first && grounded) {
    const links: SourceLink[] = toSourceLinks(bundle);
    if (links.length > 0) resp.sources = links;
  }
  return { resp, outcome: withheldDays.length === 0 ? "ok" : "partial" };
}

export async function runItineraryBatch(
  req: BatchRequest,
  totalDays: number,
  deps: BatchDeps,
): Promise<BatchResponse> {
  const now = typeof deps?.now === "function" ? deps.now : Date.now;
  let startedAt = 0;
  let run: Run;
  try {
    startedAt = now();
    run = await execute(req, totalDays, deps, now, startedAt);
  } catch {
    let ms = 0;
    try {
      ms = now() - startedAt;
    } catch {
      ms = 0;
    }
    run = { resp: unavailable(req, "unavailable", ms), outcome: "unavailable" };
  }
  try {
    const last = run.resp.fromDay + run.resp.dayCount - 1;
    const s = run.resp.stats;
    const line = `${BATCH_LOG_TAG} days=${run.resp.fromDay}-${last} proposed=${s.proposed} verified=${s.verified} removed=${s.removed} ms=${s.ms} outcome=${run.outcome}`;
    (deps?.logger ?? ((l: string) => console.info(l)))(line);
  } catch {
    // logging never affects the response
  }
  return run.resp;
}
