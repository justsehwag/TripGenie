/**
 * Web price plausibility: judges a candidate web price that the extractor has
 * already parsed. Hard checks reject; the reference cross-check flags.
 * Pure and total: no React, Next, AWS or network imports, never throws.
 */
import type { CostClass } from "../cost-caps";
import { PRICE_MAX_INR } from "../price-limits";
import type { GooglePriceLevel } from "../types";

export type PlausibilityReason =
  | "bad-amount"
  | "over-ceiling"
  | "unrelated-context"
  | "name-mismatch"
  | "foreign-currency"
  | "unit-mismatch"
  | "reference-mismatch";

export interface PlausibilityInput {
  inr: number;
  snippet: { title: string; text: string };
  /** Start of the amount in `${title} ${text}`. */
  amountIndex?: number;
  placeName: string;
  costClass: CostClass;
  primaryType?: string | null;
  costBasis: "person" | "group";
  reference?: {
    googleLevel?: GooglePriceLevel;
    range?: { lowInr: number; highInr: number };
  };
}

export interface PlausibilityResult {
  verdict: "accept" | "unverified" | "reject";
  reasons: PlausibilityReason[];
  needsReference: boolean;
}

const WINDOW = 40;
const FOREIGN_WINDOW = 12;

const WORSHIP_TYPES = new Set([
  "place_of_worship",
  "hindu_temple",
  "church",
  "mosque",
  "synagogue",
  "buddhist_temple",
  "gurudwara",
  "shrine",
]);

/** Tunable per-person ceilings (INR). */
export function ceilingFor(costClass: CostClass, primaryType?: string | null): number {
  let ceiling: number;
  switch (costClass) {
    case "free-sight":
      ceiling = 2000;
      break;
    case "paid-sight":
      ceiling =
        typeof primaryType === "string" && WORSHIP_TYPES.has(primaryType.toLowerCase())
          ? 5000
          : 10000;
      break;
    case "meal":
      ceiling = 20000;
      break;
    case "local-transfer":
      ceiling = 15000;
      break;
    default:
      ceiling = 20000;
  }
  return Math.min(ceiling, PRICE_MAX_INR);
}

/** Tunable Google price level bands (INR per person). */
export function levelBand(
  level: GooglePriceLevel,
  costClass: CostClass,
): { lowInr: number; highInr: number } {
  if (level === 0) return { lowInr: 0, highInr: 0 };
  if (costClass === "meal") {
    switch (level) {
      case 1:
        return { lowInr: 0, highInr: 500 };
      case 2:
        return { lowInr: 200, highInr: 1500 };
      case 3:
        return { lowInr: 1000, highInr: 4000 };
      default:
        return { lowInr: 2500, highInr: 20000 };
    }
  }
  switch (level) {
    case 1:
      return { lowInr: 0, highInr: 500 };
    case 2:
      return { lowInr: 100, highInr: 1500 };
    case 3:
      return { lowInr: 500, highInr: 4000 };
    default:
      return { lowInr: 1000, highInr: 10000 };
  }
}

/** Parses `Rs. 1,500/-`, `INR 1500`, `₹1.5k`, `₹ 2 lakh`, `1,50,000` to whole INR. */
export function normalizeInrAmount(raw: string): number | null {
  if (typeof raw !== "string") return null;
  const m = /^\s*(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|lakhs?|lacs?)?\s*(?:\/-)?\s*$/i.exec(
    raw,
  );
  if (!m) return null;
  const base = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  const unit = (m[2] ?? "").toLowerCase();
  const mult = unit === "k" ? 1000 : unit ? 100000 : 1;
  const value = Math.round(base * mult);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

const GENERIC_WORDS = new Set([
  "the", "and", "for", "of", "temple", "museum", "fort", "restaurant", "cafe",
  "park", "garden", "palace", "market", "beach", "hotel", "mandir", "church",
  "mosque", "lake", "point", "view",
]);

function distinctiveWords(name: string): string[] {
  const words = fold(name).split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  return words.filter((w) => !GENERIC_WORDS.has(w));
}

function nameMatches(placeName: string, haystackRaw: string): boolean {
  const hay = fold(haystackRaw);
  const words = distinctiveWords(placeName);
  if (words.length === 0) {
    const full = fold(placeName).replace(/\s+/g, " ").trim();
    return full.length > 0 && hay.replace(/\s+/g, " ").includes(full);
  }
  const found = words.filter((w) => hay.includes(w)).length;
  return found * 2 >= words.length;
}

/** Markers that make the amount unrelated to an entry price. */
const HARD_MARKER =
  /\b(?:per\s+night|nightly|rooms?|suites?|check-?in|phone|call|tel|whatsapp|since|established|built\s+in|reviews?|rated|stars?|kms?|metres?|meters?|miles?|parking)\b|\/\s*night|\+91/i;
const SOFT_MARKER = /\b(?:guide|camera|locker|package|tour\s+from)\b/i;
const TICKET_MARKER = /\b(?:entry|ticket|tickets|admission)\b/i;
const CURRENCY_NEAR = /₹|\brs\b\.?|\binr\b/i;
const FOREIGN = /\busd\b|\bus\$|\beur\b|\bgbp\b|[$£€]/i;
const GROUP_MARKER =
  /\b(?:two\s+(?:people|persons|adults)|2\s*(?:people|persons|adults|pax)|couples?|famil(?:y|ies)|groups?|vehicles?|per\s+(?:car|cab|taxi|vehicle))\b/i;
const UNIT_MARKER =
  /\b(?:per\s+(?:person|head|adult|ticket)|each|pp|adult)\b|\/\s*(?:person|head|adult)/i;

function candidateTokens(inr: number): string[] {
  const out = new Set<string>([String(inr), inr.toLocaleString("en-IN"), inr.toLocaleString("en-US")]);
  if (inr >= 1000 && inr % 1000 === 0) out.add(`${inr / 1000}k`);
  return [...out];
}

function locateAmount(text: string, inr: number): { start: number; end: number } | null {
  for (const tok of candidateTokens(inr)) {
    const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`(?<![\\d,.])${esc}(?![\\d,]|\\.\\d)`, "i").exec(text);
    if (m) return { start: m.index, end: m.index + m[0].length };
  }
  return null;
}

function amountsIn(text: string): number[] {
  const out: number[] = [];
  const re = /(?:₹|\brs\.?|\binr)\s*(\d[\d,]*(?:\.\d+)?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Math.round(Number(m[1].replace(/,/g, "")));
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

function referenceRange(i: PlausibilityInput): { lowInr: number; highInr: number } | null {
  const r = i.reference?.range;
  if (r && Number.isFinite(r.lowInr) && Number.isFinite(r.highInr) && r.highInr > 0) return r;
  const lv = i.reference?.googleLevel;
  if (typeof lv === "number" && lv >= 1 && lv <= 4) return levelBand(lv, i.costClass);
  return null;
}

export function assessWebPrice(i: PlausibilityInput): PlausibilityResult {
  try {
    const reasons: PlausibilityReason[] = [];
    const inr = i?.inr;
    if (typeof inr !== "number" || !Number.isInteger(inr) || inr < 0 || inr > PRICE_MAX_INR) {
      return { verdict: "reject", reasons: ["bad-amount"], needsReference: false };
    }
    const title = typeof i.snippet?.title === "string" ? i.snippet.title : "";
    const body = typeof i.snippet?.text === "string" ? i.snippet.text : "";
    const full = `${title} ${body}`;
    const ceiling = ceilingFor(i.costClass, i.primaryType);

    if (inr > ceiling) reasons.push("over-ceiling");

    let start = -1;
    let end = -1;
    if (typeof i.amountIndex === "number" && i.amountIndex >= 0 && i.amountIndex <= full.length) {
      start = i.amountIndex;
      const m = /^[^\s]*/.exec(full.slice(start));
      end = start + Math.max(1, m ? m[0].length : 1);
    } else {
      const loc = locateAmount(full, inr);
      if (loc) {
        start = loc.start;
        end = loc.end;
      }
    }

    if (start >= 0) {
      const around = full.slice(Math.max(0, start - WINDOW), Math.min(full.length, end + WINDOW));
      const hard = HARD_MARKER.test(around);
      const soft = SOFT_MARKER.test(around) && !(TICKET_MARKER.test(around) && !hard);
      const before = full.slice(Math.max(0, start - 6), start);
      const yearLike = inr >= 1900 && inr <= 2100 && !CURRENCY_NEAR.test(before);
      if (hard || soft || yearLike) reasons.push("unrelated-context");

      const near = full.slice(Math.max(0, start - FOREIGN_WINDOW), Math.min(full.length, end + FOREIGN_WINDOW));
      if (FOREIGN.test(near) && !CURRENCY_NEAR.test(near)) reasons.push("foreign-currency");

      if (i.costBasis === "person" && GROUP_MARKER.test(around)) reasons.push("unit-mismatch");
    }

    if (!nameMatches(i.placeName ?? "", full)) reasons.push("name-mismatch");

    const distinct = new Set(amountsIn(full));
    const needsReference =
      inr > ceiling / 2 || (distinct.size >= 2 && !UNIT_MARKER.test(full));

    if (reasons.length > 0) return { verdict: "reject", reasons, needsReference };

    const level = i.reference?.googleLevel;
    const range = referenceRange(i);
    let mismatch = false;
    if (range) {
      if (range.highInr > 0 && inr > 3 * range.highInr) mismatch = true;
      if (range.lowInr > 0 && inr < range.lowInr / 3) mismatch = true;
    } else if (typeof level === "number" && level >= 2 && inr === 0) {
      mismatch = true;
    }
    if (range && typeof level === "number" && level >= 2 && inr === 0 && !i.reference?.range) {
      mismatch = true;
    }
    if (mismatch) {
      return { verdict: "unverified", reasons: ["reference-mismatch"], needsReference };
    }
    return { verdict: "accept", reasons: [], needsReference };
  } catch {
    return { verdict: "reject", reasons: ["bad-amount"], needsReference: false };
  }
}
