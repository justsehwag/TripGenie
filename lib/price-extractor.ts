/**
 * Pure INR price extractor for web snippets.
 *
 * Finds INR amounts and ranges in text, tags each with a unit and an
 * audience, and reports a free-entry marker. Total: never throws. No React,
 * Next, AWS or network imports (only a constant from price-validator).
 */

import { PRICE_MAX_INR } from "./price-limits";

export type PriceUnit = "person" | "vehicle" | "unknown";
export type PriceAudience = "indian" | "foreign" | "unspecified";

export interface PriceCandidate {
  min: number; // finite non-negative integer
  max: number; // min <= max; min === max for a single amount
  range: boolean;
  unit: PriceUnit;
  audience: PriceAudience;
  index: number; // start of the match in the input
  end: number; // index after the match
}

export interface ExtractResult {
  candidates: PriceCandidate[];
  freeEntry: boolean;
}

export const MAX_CANDIDATES = 12;

const CUR = String.raw`(?:₹|(?<![a-z])rs\.?|(?<![a-z])inr(?![a-z]))`;
const NUM = String.raw`\d+(?:,\d+)*(?:\.\d+)?`;
const SEP = String.raw`\s*(?:-|–|—|to(?![a-z]))\s*`;
const SUF = String.raw`\s*(?:(?:inr|rupees?|rs\.?)(?![a-z])|\/-)`;

const MATCHER_SOURCE = [
  // prefix range
  String.raw`${CUR}\s*(?<pra>${NUM})${SEP}(?:${CUR}\s*)?(?<prb>${NUM})(?:\/-)?`,
  // suffix range
  String.raw`(?<sra>${NUM})${SEP}(?<srb>${NUM})${SUF}`,
  // between ... and ...
  String.raw`between\s+(?:${CUR}\s*)?(?<bta>${NUM})\s+and\s+(?:${CUR}\s*)?(?<btb>${NUM})(?:${SUF})?`,
  // prefix single
  String.raw`${CUR}\s*(?<ps>${NUM})(?:\/-)?`,
  // suffix single
  String.raw`(?<ss>${NUM})${SUF}`,
].join("|");

const FOREIGN_BEFORE = /(?:usd|us\$|eur|[$£€])\s*$/i;
const FREE_MARKERS = [
  "free entry",
  "entry is free",
  "free of cost",
  "free admission",
  "no entry fee",
  "no entrance fee",
];
const PERSON_RE = /per\s+(?:person|head|adult|pax)|\/person|\beach\b|\bpp\b/i;
const VEHICLE_RE = /per\s+(?:vehicle|car|cab|taxi|trip)/i;
const INDIAN_RE = /\bindians?\b/i;
const FOREIGN_RE = /\bforeign(?:er|ers)?\b/i;
const EMPTY: ExtractResult = { candidates: [], freeEntry: false };

function parseAmount(s: string): number {
  const n = Math.round(parseFloat(s.replace(/,/g, "")));
  return Number.isFinite(n) ? n : -1;
}

interface RawMatch {
  min: number;
  max: number;
  range: boolean;
  index: number;
  end: number;
}

function cutAtDelimiter(s: string): string {
  const i = s.search(/[;,.\n]/);
  return i === -1 ? s : s.slice(0, i);
}

function audienceIn(s: string): PriceAudience | null {
  const a = s.search(INDIAN_RE);
  const f = s.search(FOREIGN_RE);
  if (a === -1 && f === -1) return null;
  if (a === -1) return "foreign";
  if (f === -1) return "indian";
  return a < f ? "indian" : "foreign";
}

export function extractPrices(text: string): ExtractResult {
  try {
    if (typeof text !== "string" || text.length === 0) return { ...EMPTY, candidates: [] };
    const re = new RegExp(MATCHER_SOURCE, "gi");
    const raws: RawMatch[] = [];
    for (const m of text.matchAll(re)) {
      const g = m.groups ?? {};
      const index = m.index ?? 0;
      const end = index + m[0].length;
      let lo: string | undefined;
      let hi: string | undefined;
      let range = false;
      let suffixStart = false;
      if (g.pra !== undefined) { lo = g.pra; hi = g.prb; range = true; }
      else if (g.sra !== undefined) { lo = g.sra; hi = g.srb; range = true; suffixStart = true; }
      else if (g.bta !== undefined) { lo = g.bta; hi = g.btb; range = true; }
      else if (g.ps !== undefined) { lo = g.ps; hi = g.ps; }
      else if (g.ss !== undefined) { lo = g.ss; hi = g.ss; suffixStart = true; }
      if (lo === undefined || hi === undefined) continue;
      if (suffixStart && FOREIGN_BEFORE.test(text.slice(Math.max(0, index - 6), index))) continue;
      const min = parseAmount(lo);
      const max = parseAmount(hi);
      if (min < 0 || max < 0 || min > PRICE_MAX_INR || max > PRICE_MAX_INR || min > max) continue;
      raws.push({ min, max, range, index, end });
    }

    const out: PriceCandidate[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < raws.length; i++) {
      const r = raws[i];
      const nextStart = i + 1 < raws.length ? raws[i + 1].index : text.length;
      const prevEnd = i > 0 ? raws[i - 1].end : 0;
      const win = text.slice(r.end, Math.min(nextStart, r.end + 40));
      const unitWin = cutAtDelimiter(win);
      const unit: PriceUnit = PERSON_RE.test(unitWin)
        ? "person"
        : VEHICLE_RE.test(unitWin)
          ? "vehicle"
          : "unknown";

      const audWin = unitWin.split(/ and | while | whereas /i)[0];
      let audience = audienceIn(audWin);
      if (audience === null) {
        let before = text.slice(Math.max(prevEnd, r.index - 30), r.index);
        const cut = Math.max(
          before.search(/[;,.\n][^;,.\n]*$/),
          before.toLowerCase().lastIndexOf(" and ") === -1 ? -1 : before.toLowerCase().lastIndexOf(" and ") + 4,
        );
        if (cut !== -1) before = before.slice(cut + 1);
        audience = audienceIn(before);
      }

      const key = `${r.min}|${r.max}|${unit}|${audience ?? "unspecified"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        min: r.min,
        max: r.max,
        range: r.range,
        unit,
        audience: audience ?? "unspecified",
        index: r.index,
        end: r.end,
      });
      if (out.length >= MAX_CANDIDATES) break;
    }

    const lower = text.toLowerCase();
    const freeEntry = FREE_MARKERS.some((mk) => lower.includes(mk));
    return { candidates: out, freeEntry };
  } catch {
    return { candidates: [], freeEntry: false };
  }
}
