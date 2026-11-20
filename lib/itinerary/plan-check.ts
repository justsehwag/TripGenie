import type { PlaceCandidate } from "../providers/google-places";
import { DAY_WINDOW_END_MIN, DESC_CHARS, TITLE_CHARS } from "./constants";
import { fitSequence, type DaySpec } from "./scheduler";
import { nameKey } from "./place-key";
import { areaOfAddress, fallbackTitle, type PolishApplied, type PolishedDay } from "./polish-check";
// Type-only: erased at compile time, so planner.ts's server-only imports never load here.
import type { PlannerOut } from "./planner";

/**
 * Pure Plan_Checker and applyPlan. No I/O, no clock, no server-only runtime imports.
 * Never throws. Visit times come only from `fitSequence`; the planner's
 * `startTime` is a preference that is validated and then recomputed.
 * `checkPlan` validates an unknown value against the `PlannerOut` shape.
 */

export type { PlannerOut };

export type PlanRejectReason =
  | "shape"
  | "fields"
  | "days"
  | "ids"
  | "pace"
  | "start"
  | "feasibility"
  | "text";

export interface PlanContext {
  /** Requested days. */
  days: Array<{ spec: DaySpec; deterministicCount: number }>;
  /** The sent set. */
  sent: readonly PlaceCandidate[];
  flightDate?: string;
  /** Per day, same order as `days`. */
  dates: ReadonlyArray<string | null>;
}

/** `placeIds` only ever hold ids from the sent set. */
export interface PlanViolation {
  reason: PlanRejectReason;
  days: number[];
  placeIds: string[];
}

export type PlanVerdict =
  | { ok: true; days: PolishedDay[]; startMin: Map<number, number> }
  | ({ ok: false } & PlanViolation);

// Text rules. The first group is copied from polish-check.ts (those regexes are private there).
const CURRENCY_SYMBOL = /[₹$€£¥]/;
const CURRENCY_CODE = /\b(?:INR|USD|EUR|GBP)\b/i;
const RS = /\bRs\b\.?/i;
const CLOCK_COLON = /\b\d{1,2}:\d{2}\b/;
const CLOCK_AMPM = /\b\d{1,2}\s?(?:am|pm)\b/i;
const CLAIM_WORDS = /confirmed|bookable|guaranteed|100%\s*accurate/i;
const ARRIVAL_WORDING = /arrival day|departure day/i;
// Added by the planner design.
const URL_TEXT = /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|in|info|travel)\b/i;
const PRICE_WORDS = /\b(?:price|priced|cost|costs|fee|fees|cheap|inexpensive)\b|\bfree (?:entry|admission|of charge)\b/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u2028\u2029]/;
const INTERIOR_STOP = /[.!?](?=\s+\S)/;
const START_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extraKeys(o: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(o).some((k) => !allowed.includes(k));
}

function has(o: Record<string, unknown>, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** True when the text is empty, too long, or holds a forbidden price, time, claim or URL token. */
export function textViolation(s: string, limit: number): boolean {
  try {
    if (typeof s !== "string") return true;
    const t = s.trim();
    if (t.length === 0 || t.length > limit) return true;
    return (
      CONTROL_CHARS.test(t) ||
      CURRENCY_SYMBOL.test(t) ||
      CURRENCY_CODE.test(t) ||
      RS.test(t) ||
      CLOCK_COLON.test(t) ||
      CLOCK_AMPM.test(t) ||
      CLAIM_WORDS.test(t) ||
      URL_TEXT.test(t) ||
      PRICE_WORDS.test(t)
    );
  } catch {
    return true;
  }
}

function notOneSentence(s: string): boolean {
  return INTERIOR_STOP.test(s.trim());
}

function containsKey(textKey: string, key: string): boolean {
  return key !== "" && ` ${textKey} `.includes(` ${key} `);
}

function fail(reason: PlanRejectReason, days: number[] = [], placeIds: string[] = []): PlanVerdict {
  return {
    ok: false,
    reason,
    days: [...new Set(days)].sort((a, b) => a - b),
    placeIds: [...new Set(placeIds)],
  };
}

interface ParsedDay {
  day: number;
  startTime: string;
  title: string;
  stops: Array<{ placeId: string; sentence: string }>;
}

function minutesOf(hhmm: string): number | null {
  const m = START_TIME.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function check(ctx: PlanContext, raw: unknown): PlanVerdict {
  // 1. shape / fields
  if (!isRecord(raw)) return fail("shape");
  if (extraKeys(raw, ["days"])) return fail("fields");
  if (!Array.isArray(raw.days)) return fail("shape");
  const out: ParsedDay[] = [];
  for (const d of raw.days) {
    if (!isRecord(d)) return fail("shape");
    if (extraKeys(d, ["day", "startTime", "title", "stops"])) return fail("fields");
    for (const k of ["day", "startTime", "title", "stops"]) if (!has(d, k)) return fail("shape");
    if (typeof d.day !== "number" || !Number.isInteger(d.day)) return fail("shape");
    if (typeof d.startTime !== "string" || typeof d.title !== "string" || !Array.isArray(d.stops)) {
      return fail("shape");
    }
    const stops: Array<{ placeId: string; sentence: string }> = [];
    for (const s of d.stops) {
      if (!isRecord(s)) return fail("shape");
      if (extraKeys(s, ["placeId", "sentence"])) return fail("fields");
      if (!has(s, "placeId") || !has(s, "sentence")) return fail("shape");
      if (typeof s.placeId !== "string" || typeof s.sentence !== "string") return fail("shape");
      stops.push({ placeId: s.placeId, sentence: s.sentence });
    }
    out.push({ day: d.day, startTime: d.startTime, title: d.title, stops });
  }

  // 2. days
  const expected = new Set(ctx.days.map((d) => d.spec.day));
  const seenDays = new Set(out.map((d) => d.day));
  if (out.length !== ctx.days.length || seenDays.size !== out.length || expected.size !== seenDays.size) {
    return fail("days");
  }
  for (const n of expected) if (!seenDays.has(n)) return fail("days");

  // 3. ids
  const sent = new Map<string, PlaceCandidate>();
  for (const c of ctx.sent) sent.set(c.placeId, c);
  const seenIds = new Set<string>();
  const badDays: number[] = [];
  const badIds: string[] = [];
  for (const d of out) {
    for (const s of d.stops) {
      const known = sent.has(s.placeId);
      if (!known || seenIds.has(s.placeId)) {
        badDays.push(d.day);
        if (known) badIds.push(s.placeId);
      }
      seenIds.add(s.placeId);
    }
  }
  if (badDays.length > 0) return fail("ids", badDays, badIds);

  const specOf = new Map(ctx.days.map((d) => [d.spec.day, d] as const));

  // 4. pace
  {
    const days: number[] = [];
    const ids: string[] = [];
    for (const d of out) {
      const pre = specOf.get(d.day) as { spec: DaySpec; deterministicCount: number };
      const before = Math.max(0, pre.deterministicCount);
      const lower = before === 0 ? 0 : Math.max(1, Math.min(pre.spec.limits.min, before));
      const upper = pre.spec.limits.max;
      if (d.stops.length < lower || d.stops.length > upper) {
        days.push(d.day);
        ids.push(...d.stops.map((s) => s.placeId));
      }
    }
    if (days.length > 0) return fail("pace", days, ids);
  }

  // 5. start
  const startMin = new Map<number, number>();
  {
    const days: number[] = [];
    for (const d of out) {
      const pre = specOf.get(d.day) as { spec: DaySpec };
      const m = minutesOf(d.startTime);
      if (m === null || m < pre.spec.earliestMin || m >= DAY_WINDOW_END_MIN) days.push(d.day);
      else startMin.set(d.day, m);
    }
    if (days.length > 0) return fail("start", days);
  }

  // 6. feasibility
  {
    const days: number[] = [];
    const ids: string[] = [];
    for (const d of out) {
      if (d.stops.length === 0) continue;
      const pre = specOf.get(d.day) as { spec: DaySpec };
      const ordered = d.stops.map((s) => sent.get(s.placeId) as PlaceCandidate);
      const spec = { ...pre.spec, earliestMin: Math.max(pre.spec.earliestMin, startMin.get(d.day) as number) };
      if (fitSequence(spec, ordered) === null) {
        days.push(d.day);
        ids.push(...d.stops.map((s) => s.placeId));
      }
    }
    if (days.length > 0) return fail("feasibility", days, ids);
  }

  // 7. text
  {
    const days: number[] = [];
    const ids: string[] = [];
    const allKeys = ctx.sent.map((c) => ({ id: c.placeId, key: nameKey(c.name) }));
    for (const d of out) {
      const dayIds = new Set(d.stops.map((s) => s.placeId));
      const dayKeys = [...dayIds].map((id) => nameKey((sent.get(id) as PlaceCandidate).name));
      let dayBad = false;
      const title = d.title.trim();
      const titleKey = nameKey(title);
      const titleBad =
        textViolation(title, TITLE_CHARS) ||
        allKeys.some(
          (o) =>
            !dayIds.has(o.id) &&
            containsKey(titleKey, o.key) &&
            !dayKeys.some((k) => k !== "" && containsKey(k, o.key)),
        );
      if (titleBad) dayBad = true;
      for (const s of d.stops) {
        const sentence = s.sentence.trim();
        const own = nameKey((sent.get(s.placeId) as PlaceCandidate).name);
        const sKey = nameKey(sentence);
        const bad =
          textViolation(sentence, DESC_CHARS) ||
          notOneSentence(sentence) ||
          allKeys.some((o) => o.id !== s.placeId && containsKey(sKey, o.key) && !containsKey(own, o.key));
        if (bad) {
          dayBad = true;
          ids.push(s.placeId);
        }
      }
      if (dayBad) days.push(d.day);
    }
    if (days.length > 0) return fail("text", days, ids);
  }

  // Title replacement: duplicates and misplaced arrival or departure wording.
  const dateOf = new Map<number, string | null>();
  ctx.days.forEach((d, i) => dateOf.set(d.spec.day, ctx.dates[i] ?? d.spec.date ?? null));
  const kept = new Set<string>();
  const replace = new Set<number>();
  for (const d of out) {
    const title = d.title.trim();
    const date = dateOf.get(d.day) ?? null;
    const wordingOk = !ARRIVAL_WORDING.test(title) || (!!ctx.flightDate && date === ctx.flightDate);
    const k = nameKey(title);
    if (!wordingOk || !k || kept.has(k)) replace.add(d.day);
    else kept.add(k);
  }
  const days: PolishedDay[] = out.map((d) => {
    const stops = d.stops.map((s) => ({ placeId: s.placeId, sentence: s.sentence.trim() }));
    if (!replace.has(d.day)) return { day: d.day, title: d.title.trim(), stops };
    const first = sent.get(d.stops[0]?.placeId ?? "");
    return { day: d.day, title: fallbackTitle(first ? areaOfAddress(first.address) : "", d.day, kept), stops };
  });
  return { ok: true, days, startMin };
}

/** Pure and total: any input gives a verdict. */
export function checkPlan(ctx: PlanContext, raw: unknown): PlanVerdict {
  try {
    return check(ctx, raw);
  } catch {
    return fail("shape");
  }
}

/** Data fields come only from the sent candidates by placeId; times only from fitSequence. */
export function applyPlan(ctx: PlanContext, v: Extract<PlanVerdict, { ok: true }>): PolishApplied {
  const sent = new Map<string, PlaceCandidate>();
  for (const c of ctx.sent) sent.set(c.placeId, c);
  return {
    days: v.days.map((d) => {
      const spec = ctx.days.find((x) => x.spec.day === d.day)?.spec;
      const cands = d.stops.map((s) => sent.get(s.placeId) as PlaceCandidate);
      let timed: ReturnType<typeof fitSequence> = null;
      try {
        if (spec) {
          const start = v.startMin.get(d.day);
          timed = fitSequence(
            { ...spec, earliestMin: Math.max(spec.earliestMin, typeof start === "number" ? start : 0) },
            cands,
          );
        }
      } catch {
        timed = null;
      }
      return {
        day: d.day,
        title: d.title,
        stops: d.stops.map((s, i) => ({
          candidate: cands[i],
          sentence: s.sentence,
          scheduled: timed && timed[i] ? timed[i] : null,
        })),
      };
    }),
  };
}
