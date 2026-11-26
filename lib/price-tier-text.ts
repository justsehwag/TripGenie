/**
 * Pure label text for the price tiers shown next to a Stop and on range-only days.
 * No React, Next or network imports, so it is testable without rendering.
 *
 * Honesty rules: only a verified web price is called a "Web price" (the unverified
 * variant says so explicitly); estimates are never called web prices; no label
 * claims a price is confirmed, bookable or guaranteed.
 */
import type { Activity } from "./types";
import { formatInr } from "./itinerary-inr";

export type PriceTierKey =
  | "web"
  | "unverified-web"
  | "estimate"
  | "google-range"
  | "google-level"
  | "ai"
  | "none";

export interface PriceTierText {
  tier: PriceTierKey;
  text: string;
  className: string;
}

export const NOT_PRICED_TEXT = "Not priced";
export const NO_PRICE_TEXT = "No price found online";

const CLASS_BY_TIER: Record<PriceTierKey, string> = {
  web: "price-tier price-tier--web",
  "unverified-web": "price-tier price-tier--unverified",
  estimate: "price-tier price-tier--estimate",
  "google-range": "price-tier price-tier--google-range",
  "google-level": "price-tier price-tier--google-level",
  ai: "price-tier price-tier--ai",
  none: "price-tier price-tier--none",
};

function isInt(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function rangeText(lowInr: number, highInr: number): string {
  const lo = Math.max(0, Math.round(lowInr));
  const hi = Math.max(lo, Math.round(highInr));
  if (lo === hi) return formatInr(lo);
  // formatInr prints "INR 1,200"; keep the prefix once: "INR 1,200 - 2,500".
  return `${formatInr(lo)} - ${formatInr(hi).replace(/^INR\s*/, "")}`;
}

/** Which tier a Stop falls in. Total: never throws. */
export function priceTierOf(a: Activity | null | undefined): PriceTierKey {
  if (!a || typeof a !== "object") return "none";
  if (a.priceSource === "web") return "web";
  const fb = a.priceFallback;
  const range = fb?.google?.range;
  if (range && isInt(range.lowInr) && isInt(range.highInr)) return "google-range";
  const level = fb?.google?.level;
  if (level !== undefined && isInt(level) && level >= 0 && level <= 4) return "google-level";
  if (fb?.ai && isInt(fb.ai.lowInr) && isInt(fb.ai.highInr)) return "ai";
  if (
    (a.priceSource === "ai" || a.priceSource === "estimated") &&
    isInt(a.cost) &&
    a.cost > 0
  ) {
    return "estimate";
  }
  if (fb?.unverifiedWeb && isInt(fb.unverifiedWeb.inr)) return "unverified-web";
  return "none";
}

/** Tier, label text and CSS class for one Stop. Total: never throws. */
export function priceTierText(a: Activity | null | undefined): PriceTierText {
  const tier = priceTierOf(a);
  const className = CLASS_BY_TIER[tier];
  const fb = a?.priceFallback;
  switch (tier) {
    case "web": {
      const host = typeof a?.sourceHost === "string" && a.sourceHost ? ` · ${a.sourceHost}` : "";
      return { tier, className, text: `Web price ${formatInr(a?.cost as number)}${host}` };
    }
    case "unverified-web": {
      const u = fb!.unverifiedWeb!;
      return { tier, className, text: `Web price (unverified) ${formatInr(u.inr)}` };
    }
    case "google-range": {
      const r = fb!.google!.range!;
      return { tier, className, text: `Google price range ${rangeText(r.lowInr, r.highInr)}` };
    }
    case "google-level": {
      const level = fb!.google!.level as number;
      const text = level === 0 ? "Price level Free (Google)" : `Price level ${"₹".repeat(level)} (Google)`;
      return { tier, className, text };
    }
    case "ai": {
      const r = fb!.ai!;
      return { tier, className, text: `AI estimate ${rangeText(r.lowInr, r.highInr)}` };
    }
    case "estimate":
      return { tier, className, text: `Estimated price ${formatInr(a?.cost as number)}` };
    default:
      return { tier: "none", className, text: NO_PRICE_TEXT };
  }
}

/** Text for a day that has only range-based prices (no single-value price). */
export function dayRangeText(lowInr: number, highInr: number): string {
  return `Estimated range ${rangeText(isInt(lowInr) ? lowInr : 0, isInt(highInr) ? highInr : 0)}`;
}

/** Minimal day-cost shape (matches DayCost in trip-cost-aggregate). */
export interface DayCostLike {
  day: number;
  costInr: number | null;
  rangeLowInr: number;
  rangeHighInr: number;
  display: "priced" | "range-only" | "not-priced";
}

/**
 * Day row value: "Not priced", an amount "for N travellers", or the range-only text.
 * Matches the aggregate day by day number. Total: never throws.
 */
export function dayCostText(
  days: readonly DayCostLike[] | null | undefined,
  dayNumber: number,
  travellers: number,
): string {
  const dc = Array.isArray(days) ? days.find((x) => x && x.day === dayNumber) : undefined;
  if (!dc || dc.display === "not-priced") return NOT_PRICED_TEXT;
  if (dc.display === "range-only") return dayRangeText(dc.rangeLowInr, dc.rangeHighInr);
  const n = Number.isFinite(travellers) && travellers >= 1 ? Math.trunc(travellers) : 1;
  return `${formatInr(dc.costInr ?? 0)} for ${n} ${n === 1 ? "traveller" : "travellers"}`;
}
