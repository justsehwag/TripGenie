import type { PlaceCandidate } from "../providers/google-places";
import { DESC_CHARS, TITLE_CHARS } from "./constants";
import { fitSequence, type DaySpec, type ScheduledStop } from "./scheduler";
import { nameKey } from "./place-key";
import { sanitizeDisplayText } from "./text";
import type { PolishOut } from "./polish";

/**
 * Pure Polish_Checker and applyPolish. No I/O, no clock, no server-only imports.
 *
 * `PolishOut` is defined in polish.ts; the type is re-exported here.
 */

export type { PolishOut };

export interface PolishContext {
  /** Pre-polish order and assignment. */
  days: Array<{ spec: DaySpec; stops: PlaceCandidate[] }>;
  /** selectedFlight.date */
  flightDate?: string;
  /** Per day, same order as `days`. */
  dates: ReadonlyArray<string | null>;
}

export type PolishRejectReason = "shape" | "ids" | "days" | "fields" | "feasibility" | "text";

/** One accepted day: day number, title, ordered placeIds, one sentence per placeId. */
export interface PolishedDay {
  day: number;
  title: string;
  stops: Array<{ placeId: string; sentence: string }>;
}

export type PolishVerdict =
  | { ok: true; days: PolishedDay[] }
  | { ok: false; reason: PolishRejectReason };

export interface PolishAppliedStop {
  /** The pre-polish record, untouched. */
  candidate: PlaceCandidate;
  sentence: string;
  /** Times recomputed by fitSequence on the accepted order. */
  scheduled: ScheduledStop | null;
}

export interface PolishApplied {
  days: Array<{ day: number; title: string; stops: PolishAppliedStop[] }>;
}

const CURRENCY_SYMBOL = /[₹$€£¥]/;
const CURRENCY_CODE = /\b(?:INR|USD|EUR|GBP)\b/i;
const RS = /\bRs\b\.?/i;
const CLOCK_COLON = /\b\d{1,2}:\d{2}\b/;
const CLOCK_AMPM = /\b\d{1,2}\s?(?:am|pm)\b/i;
const CLAIM_WORDS = /confirmed|bookable|guaranteed|100%\s*accurate/i;
const ARRIVAL_WORDING = /arrival day|departure day/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extraKeys(o: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(o).some((k) => !allowed.includes(k));
}

function hasText(o: Record<string, unknown>, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function violatesText(s: string, limit: number): boolean {
  if (s.length === 0 || s.length > limit) return true;
  return (
    CURRENCY_SYMBOL.test(s) ||
    CURRENCY_CODE.test(s) ||
    RS.test(s) ||
    CLOCK_COLON.test(s) ||
    CLOCK_AMPM.test(s) ||
    CLAIM_WORDS.test(s)
  );
}

/** Google's address text only: drop country, postal-code segments; last remaining when 2+ remain. */
export function areaOfAddress(address: string, destination?: string): string {
  const parts = String(address ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  parts.pop();
  const dest = destination ? nameKey(destination) : "";
  const kept = parts.filter(
    (p) => (p.match(/\d/g) ?? []).length < 4 && !(dest !== "" && nameKey(p) === dest),
  );
  return kept.length >= 2 ? kept[kept.length - 1] : "";
}

/**
 * Copy of the candidate logic of batch-service.uniqueTitle, minus the raw-title
 * branch. batch-service.ts imports server-only modules (bedrock-model, config),
 * so it cannot be imported by this pure module.
 */
export function fallbackTitle(area: string, day: number, taken: Set<string>): string {
  const candidates = [area ? `${area} day` : "", area ? `${area} day ${day}` : "", `Day ${day}`];
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

function reject(reason: PolishRejectReason): PolishVerdict {
  return { ok: false, reason };
}

export function checkPolish(ctx: PolishContext, raw: unknown): PolishVerdict {
  try {
    // 1. shape
    if (!isRecord(raw)) return reject("shape");
    if (extraKeys(raw, ["days"])) return reject("fields");
    if (!Array.isArray(raw.days)) return reject("shape");
    const out: PolishedDay[] = [];
    for (const d of raw.days) {
      if (!isRecord(d)) return reject("shape");
      if (extraKeys(d, ["day", "title", "stops"])) return reject("fields");
      if (!hasText(d, "day") || !hasText(d, "title") || !hasText(d, "stops")) return reject("shape");
      if (typeof d.day !== "number" || !Number.isInteger(d.day)) return reject("shape");
      if (typeof d.title !== "string" || !Array.isArray(d.stops)) return reject("shape");
      const stops: Array<{ placeId: string; sentence: string }> = [];
      for (const s of d.stops) {
        if (!isRecord(s)) return reject("shape");
        if (extraKeys(s, ["placeId", "sentence"])) return reject("fields");
        if (!hasText(s, "placeId") || !hasText(s, "sentence")) return reject("shape");
        if (typeof s.placeId !== "string" || typeof s.sentence !== "string") return reject("shape");
        stops.push({ placeId: s.placeId, sentence: s.sentence });
      }
      out.push({ day: d.day, title: d.title, stops });
    }

    // 2. days
    if (out.length !== ctx.days.length) return reject("days");
    const expectedDays = new Set(ctx.days.map((d) => d.spec.day));
    const seenDays = new Set(out.map((d) => d.day));
    if (seenDays.size !== out.length || expectedDays.size !== seenDays.size) return reject("days");
    for (const n of expectedDays) if (!seenDays.has(n)) return reject("days");

    // 3. ids (multiset)
    const byId = new Map<string, PlaceCandidate>();
    const want = new Map<string, number>();
    for (const d of ctx.days) {
      for (const c of d.stops) {
        byId.set(c.placeId, c);
        want.set(c.placeId, (want.get(c.placeId) ?? 0) + 1);
      }
    }
    const got = new Map<string, number>();
    for (const d of out) for (const s of d.stops) got.set(s.placeId, (got.get(s.placeId) ?? 0) + 1);
    if (got.size !== want.size) return reject("ids");
    for (const [id, n] of want) if (got.get(id) !== n) return reject("ids");

    // 4. feasibility
    for (const d of out) {
      const pre = ctx.days.find((x) => x.spec.day === d.day);
      if (!pre) return reject("days");
      const { min, max } = pre.spec.limits;
      const before = pre.stops.length;
      const lower = before === 0 ? 0 : Math.max(1, Math.min(min, before));
      const upper = Math.max(max, before);
      if (d.stops.length < lower || d.stops.length > upper) return reject("feasibility");
      const ordered = d.stops.map((s) => byId.get(s.placeId) as PlaceCandidate);
      if (ordered.length > 0 && fitSequence(pre.spec, ordered) === null) return reject("feasibility");
    }

    // 5. text
    for (const d of out) {
      const title = d.title.trim();
      if (violatesText(title, TITLE_CHARS)) return reject("text");
      for (const s of d.stops) if (violatesText(s.sentence.trim(), DESC_CHARS)) return reject("text");
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
    const result: PolishedDay[] = out.map((d) => {
      if (!replace.has(d.day)) return { ...d, title: d.title.trim() };
      const first = byId.get(d.stops[0]?.placeId ?? "");
      const title = fallbackTitle(first ? areaOfAddress(first.address) : "", d.day, kept);
      return { ...d, title };
    });
    return { ok: true, days: result };
  } catch {
    return reject("shape");
  }
}

/** Data fields come only from the pre-polish records by placeId. */
export function applyPolish(ctx: PolishContext, v: Extract<PolishVerdict, { ok: true }>): PolishApplied {
  const byId = new Map<string, PlaceCandidate>();
  for (const d of ctx.days) for (const c of d.stops) byId.set(c.placeId, c);
  return {
    days: v.days.map((d) => {
      const spec = ctx.days.find((x) => x.spec.day === d.day)?.spec;
      const cands = d.stops.map((s) => byId.get(s.placeId) as PlaceCandidate);
      const timed = spec ? fitSequence(spec, cands) : null;
      return {
        day: d.day,
        title: d.title,
        stops: d.stops.map((s, i) => ({
          candidate: cands[i],
          sentence: s.sentence.trim(),
          scheduled: timed && timed[i] ? timed[i] : null,
        })),
      };
    }),
  };
}
