/**
 * Itinerary INR normalisation and totals (Req 7, 8; design conflicts C1, C10).
 *
 * Pure and framework-free. Every function is total and never throws.
 * `normalizeItineraryToInr` is the ONLY place a USD anchor becomes INR;
 * `applyPriceResults` never multiplies.
 *
 * Cost classes, caps and web prices (web-grounded-pricing): the caps,
 * classification and zeroing of stay/route/shopping rows apply when the caller
 * passes `ItineraryCostOpts` (the planner does) or when an activity already
 * carries a `costClass`. Without either, behaviour is the legacy one.
 */

import type { Activity, Itinerary, RouteFareRange, TripDay } from "./types";
import {
  USD_INR_FALLBACK,
  inferKind,
  type PriceResult,
  type PriceSource,
  type PricerRequest,
} from "./activity-pricer";
import {
  CAPPED_BASIS,
  clampToCap,
  estimateFor,
  resolveBudgetLevel,
  resolveCityTier,
  webBoundFor,
  type BudgetLevel,
  type CityTier,
  type CostBasis,
  type CostClass,
} from "./cost-caps";
import { basisFor, classifyActivity, isPriceable } from "./cost-classifier";
import { isValidWebFields, parseRouteFare } from "./web-price-sources";

export type CostUnit = "inr";

export interface RateInfo {
  usdInr: number;
  basis: "live" | "fallback";
}

/** Trip context used for classification and caps. Passing it opts in to caps. */
export interface ItineraryCostOpts {
  origin?: string;
  destination?: string;
  budgetLevel?: BudgetLevel | string;
}

/** Accepts only mode live or cached with a finite rate > 0; otherwise the documented fallback. */
export function resolveUsdInr(
  res: { data?: { rate?: unknown }; mode?: unknown } | null | undefined,
): RateInfo {
  try {
    const mode = res?.mode;
    const rate = res?.data?.rate;
    if ((mode === "live" || mode === "cached") && typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
      return { usdInr: rate, basis: "live" };
    }
  } catch {
    /* fall through */
  }
  return { usdInr: USD_INR_FALLBACK, basis: "fallback" };
}

function safeRate(usdInr: unknown): number {
  return typeof usdInr === "number" && Number.isFinite(usdInr) && usdInr > 0 ? usdInr : USD_INR_FALLBACK;
}

function safeCost(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function daysOf(it: Itinerary | null | undefined): TripDay[] {
  return it && Array.isArray(it.days) ? it.days : [];
}

function activitiesOf(day: TripDay | null | undefined): Activity[] {
  return day && Array.isArray(day.activities) ? day.activities : [];
}

function hash36(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Stable per-activity id: `d{day}-{hash(title|time)}-{ordinal}`. */
export function activityId(day: number, a: Activity, ordinalInDay: number): string {
  const d = typeof day === "number" && Number.isFinite(day) ? Math.trunc(day) : 0;
  const o = typeof ordinalInDay === "number" && Number.isFinite(ordinalInDay) ? Math.trunc(ordinalInDay) : 0;
  return `d${d}-${hash36(`${str(a?.title)}|${str(a?.time)}`)}-${o}`;
}

const COST_NOTES: Partial<Record<CostClass, string>> = {
  "stay-checkin": "Included in stay",
  "route-transport": "Included in route transport",
  shopping: "Optional, your spend",
};

interface Resolved {
  budget: BudgetLevel;
  tier: CityTier;
  origin: string;
  destination: string;
}

function resolveOpts(opts: ItineraryCostOpts | undefined): Resolved {
  const destination = str(opts?.destination);
  return {
    budget: resolveBudgetLevel(opts?.budgetLevel),
    tier: resolveCityTier(destination),
    origin: str(opts?.origin),
    destination,
  };
}

function classOf(a: Activity, r: Resolved): CostClass {
  return classifyActivity(
    { title: str(a?.title), category: a?.category },
    { origin: r.origin, destination: r.destination },
  );
}

/** Builds the pricer request; ordinal is the index within the day, so repeats stay distinct. */
export function toPricerRequest(
  destination: string,
  itinerary: Itinerary,
  opts?: ItineraryCostOpts,
): PricerRequest & { budgetLevel?: BudgetLevel; cityTier?: CityTier; origin?: string } {
  const r = resolveOpts({ ...opts, destination: opts?.destination ?? destination });
  const activities: PricerRequest["activities"] = [];
  daysOf(itinerary).forEach((day, di) => {
    const dayNo = typeof day?.day === "number" ? day.day : di + 1;
    activitiesOf(day).forEach((a, i) => {
      const cls: CostClass | undefined = a?.costClass ?? (opts ? classOf(a, r) : undefined);
      if (cls && !isPriceable(cls)) return;
      const item = {
        id: activityId(dayNo, a, i),
        title: str(a?.title),
        time: str(a?.time),
        kind: inferKind(str(a?.title), a?.category),
      } as PricerRequest["activities"][number] & { costBasis?: CostBasis };
      if (cls) item.costBasis = a?.costBasis ?? basisFor(cls, str(a?.title));
      activities.push(item);
    });
  });
  const req: PricerRequest & { budgetLevel?: BudgetLevel; cityTier?: CityTier; origin?: string } = {
    destination: str(destination),
    activities,
  };
  if (opts) {
    req.budgetLevel = r.budget;
    req.cityTier = r.tier;
    if (r.origin) req.origin = r.origin;
  }
  return req;
}

/** day.total = sum of activity.cost; totalCost = sum of day.total. */
export function recomputeTotals(it: Itinerary): Itinerary {
  const days = daysOf(it).map((d) => ({
    ...d,
    total: activitiesOf(d).reduce((s, a) => s + safeCost(a?.cost), 0),
  }));
  return { ...it, days, totalCost: days.reduce((s, d) => s + d.total, 0) };
}

/** Sum of activity.cost across all days. */
export function activitiesTotalInr(it: Itinerary): number {
  return daysOf(it).reduce((s, d) => s + activitiesOf(d).reduce((t, a) => t + safeCost(a?.cost), 0), 0);
}

/**
 * Party total of activities: person-basis costs times travellers plus
 * group-basis costs times ceil(travellers / 4).
 */
export function partyActivitiesInr(it: Itinerary, travellers: number): number {
  const n = typeof travellers === "number" && Number.isFinite(travellers) ? Math.max(1, Math.trunc(travellers)) : 1;
  const vehicles = Math.ceil(n / 4);
  let total = 0;
  for (const d of daysOf(it)) {
    for (const a of activitiesOf(d)) {
      total += safeCost(a?.cost) * (a?.costBasis === "group" ? vehicles : n);
    }
  }
  return total;
}

/** Removes web evidence fields from an activity. */
function stripWeb(a: Activity): Activity {
  const { sourceUrl: _u, sourceHost: _h, checkedAt: _c, ...rest } = a;
  void _u; void _h; void _c;
  return rest;
}

/**
 * Converts every activity cost to INR exactly once and stamps costUnit "inr".
 *  - already costUnit "inr": returned unchanged (idempotent).
 *  - USD-anchored (engine output: non-empty and every activity has a category): cost = round(cost x usdInr).
 *  - model-generated (otherwise): cost is already INR and is kept.
 * With `opts`, every activity is also classified (category or not), stamped with
 * costClass/costBasis/costNote, non-priceable classes are zeroed and other costs
 * are clamped to the cap (a clamped price is "estimated" with CAPPED_BASIS).
 */
export function normalizeItineraryToInr(it: Itinerary, usdInr: number, opts?: ItineraryCostOpts): Itinerary {
  if (!it || typeof it !== "object") return it;
  if (it.costUnit === "inr") return it;
  const rate = safeRate(usdInr);
  const r = opts ? resolveOpts(opts) : undefined;
  const all = daysOf(it).flatMap(activitiesOf);
  const usdAnchored = all.length > 0 && all.every((a) => a && typeof a.category === "string");
  const days = daysOf(it).map((d) => ({
    ...d,
    activities: activitiesOf(d).map((a) => {
      const cost = safeCost(a?.cost);
      let inr = usdAnchored ? Math.round(cost * rate) : Math.round(cost);
      const base: Activity = { ...a, cost: inr, priceSource: "estimated" as const };
      if (!r) return base;
      const cls = classOf(a, r);
      const out: Activity = { ...base, costClass: cls, costBasis: basisFor(cls, str(a?.title)) };
      if (!isPriceable(cls)) {
        out.cost = 0;
        out.costNote = COST_NOTES[cls];
        return out;
      }
      const clamped = clampToCap(inr, cls, r.budget, r.tier);
      inr = clamped.inr;
      out.cost = Math.round(inr);
      if (clamped.capped) out.priceBasis = CAPPED_BASIS;
      return out;
    }),
  }));
  const next: Itinerary = { ...it, days, currency: "INR", costUnit: "inr" };
  return recomputeTotals(next);
}

/**
 * Replaces cost, priceSource and priceBasis for activities whose id matches a result.
 * Unmatched activities and unmatched results are ignored. Never multiplies. Recomputes totals.
 *  - a "web" result is applied only when its web fields are valid and its cost is
 *    within the Web_Sanity_Bound; otherwise it is treated as "estimated".
 *  - with `opts` (or a stamped costClass) every non-web price is clamped to the cap.
 *  - non-priceable rows (stay, route, shopping) are left untouched.
 */
export function applyPriceResults(
  it: Itinerary,
  prices: readonly PriceResult[],
  opts?: ItineraryCostOpts,
): Itinerary {
  if (!it || typeof it !== "object") return it;
  type AnyResult = PriceResult & {
    source?: string;
    sourceUrl?: unknown;
    sourceHost?: unknown;
    checkedAt?: unknown;
  };
  const byId = new Map<string, AnyResult>();
  if (Array.isArray(prices)) {
    for (const p of prices as readonly AnyResult[]) {
      if (p && typeof p.id === "string" && typeof p.inr === "number" && Number.isFinite(p.inr) && !byId.has(p.id)) {
        byId.set(p.id, p);
      }
    }
  }
  const r = resolveOpts(opts);
  const days = daysOf(it).map((d, di) => {
    const dayNo = typeof d?.day === "number" ? d.day : di + 1;
    return {
      ...d,
      activities: activitiesOf(d).map((a, i) => {
        const res = byId.get(activityId(dayNo, a, i));
        if (!res) return a;
        const stamped = a?.costClass !== undefined;
        const cls: CostClass | undefined = a?.costClass ?? (opts ? classOf(a, r) : undefined);
        if (cls && !isPriceable(cls)) return a;
        const inr = Math.round(res.inr);
        const basisText = typeof res.basis === "string" ? res.basis : undefined;

        if (res.source === "web" && isValidWebFields(res)) {
          const bound = webBoundFor(cls ?? "other", r.budget, r.tier);
          if (inr >= 0 && inr <= bound) {
            return {
              ...a,
              cost: inr,
              priceSource: "web" as const,
              priceBasis: basisText,
              sourceUrl: res.sourceUrl as string,
              sourceHost: res.sourceHost as string,
              checkedAt: res.checkedAt as string,
            };
          }
        }
        const asWeb = res.source === "web";
        const source = res.source === "ai" ? ("ai" as const) : ("estimated" as const);
        const base = stripWeb(a);
        if (cls && (opts || stamped)) {
          const clamped = clampToCap(inr, cls, r.budget, r.tier);
          if (clamped.capped) {
            return { ...base, cost: Math.round(clamped.inr), priceSource: "estimated" as const, priceBasis: CAPPED_BASIS };
          }
          if (asWeb) {
            return { ...base, cost: Math.round(clamped.inr), priceSource: "estimated" as const, priceBasis: basisText };
          }
          // Negative prices are floored to 0 by clampToCap; keep that for ai/estimated too.
          return { ...base, cost: Math.round(clamped.inr), priceSource: source, priceBasis: basisText };
        }
        return { ...base, cost: inr, priceSource: source, priceBasis: basisText };
      }),
    };
  });
  return recomputeTotals({ ...it, days, currency: "INR", costUnit: "inr" });
}

/** Stores a re-validated Route_Fare_Range, or removes an invalid or absent one. */
export function applyRouteFare(it: Itinerary, rf: unknown): Itinerary {
  if (!it || typeof it !== "object") return it;
  const parsed: RouteFareRange | undefined = parseRouteFare(rf);
  if (parsed) return { ...it, routeFare: parsed };
  if (!("routeFare" in it)) return it;
  const { routeFare: _r, ...rest } = it;
  void _r;
  return rest as Itinerary;
}

/**
 * Prices an added or edited activity by the cap-table estimate, labelled estimated
 * (Req 7.9). Drops any previous price basis and web evidence fields.
 */
export function withEstimatedActivity(
  a: Activity,
  destination: string,
  usdInr: number,
  opts?: ItineraryCostOpts,
): Activity {
  void safeRate(usdInr);
  const { priceBasis: _drop, ...rest0 } = a ?? ({} as Activity);
  void _drop;
  const rest = stripWeb(rest0 as Activity);
  const r = resolveOpts({ ...opts, destination: opts?.destination ?? destination });
  const cls = classOf(a ?? ({ title: "" } as Activity), r);
  const out: Activity = {
    ...rest,
    cost: estimateFor(cls, r.budget, r.tier),
    priceSource: "estimated",
    costClass: cls,
    costBasis: basisFor(cls, str(a?.title)),
  };
  if (isPriceable(cls)) delete out.costNote;
  else out.costNote = COST_NOTES[cls];
  return out;
}

/** "Web price" for source "web", "AI estimate" for "ai", "estimated" otherwise. */
export function priceLabel(
  source: PriceSource | "web" | undefined,
): "Web price" | "AI estimate" | "estimated" {
  if (source === "web") return "Web price";
  return source === "ai" ? "AI estimate" : "estimated";
}

/** "INR 12,34,567" with Indian digit grouping. Non-finite input formats as 0. */
export function formatInr(n: number): string {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 0;
  const neg = v < 0;
  const digits = String(Math.abs(v));
  let grouped: string;
  if (digits.length <= 3) {
    grouped = digits;
  } else {
    const head = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
    grouped = `${head},${digits.slice(-3)}`;
  }
  return `INR ${neg && v !== 0 ? "-" : ""}${grouped}`;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Sets day i to startIso + i days when startIso is a valid ISO date; otherwise unchanged (C1). */
export function restampItineraryDates(it: Itinerary, startIso: string): Itinerary {
  if (!it || typeof it !== "object" || typeof startIso !== "string") return it;
  const m = ISO_RE.exec(startIso);
  if (!m) return it;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const base = Date.UTC(y, mo - 1, d);
  const chk = new Date(base);
  if (
    Number.isNaN(base) ||
    chk.getUTCFullYear() !== y ||
    chk.getUTCMonth() !== mo - 1 ||
    chk.getUTCDate() !== d
  ) {
    return it;
  }
  const days = daysOf(it).map((day, i) => {
    const t = new Date(base);
    t.setUTCDate(t.getUTCDate() + i);
    return { ...day, date: t.toISOString().slice(0, 10) };
  });
  return { ...it, days };
}
