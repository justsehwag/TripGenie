/**
 * Citation validation for web prices. The model may say "web"; the server
 * decides by re-reading the snippets it supplied. Pure and total.
 */
import { normalizeUrlForCompare } from "@/lib/grounding/bundle";
import {
  VEHICLE_SEATS,
  webBoundFor,
  type BudgetLevel,
  type CityTier,
  type CostBasis,
  type CostClass,
} from "@/lib/cost-caps";
import { extractPrices, type PriceCandidate } from "@/lib/price-extractor";
import type { RouteFareRange } from "@/lib/types";
import { evidenceText, type EvidenceSet, type EvidenceSnippet } from "@/lib/web-pricing/evidence";
import type { ResearchKind } from "@/lib/web-pricing/query-planner";

export interface WebCheckContext {
  evidence: EvidenceSet | undefined;
  kind: ResearchKind;
  costClass: CostClass;
  costBasis: CostBasis;
  budget: BudgetLevel;
  tier: CityTier;
}
export type WebRejectReason =
  | "bad-amount"
  | "no-source"
  | "no-evidence"
  | "url-not-supplied"
  | "amount-not-found"
  | "free-not-stated"
  | "over-bound"
  | "unit-mismatch"
  | "party-price"
  | "foreign-preferred";
export interface WebAccepted {
  inr: number;
  sourceUrl: string;
  sourceHost: string;
  checkedAt: string;
  basis: string;
}
export type WebVerdict = { ok: true; price: WebAccepted } | { ok: false; reason: WebRejectReason };

/** Informational per-person ceiling for bus/train fares. */
export const ROUTE_FARE_MAX_INR = 8_000;
const MAX_BASIS_CHARS = 120;
const PARTY_RE = /\bfor\s+(?:two|2|couple|family|group|\d+\s+(?:people|persons|pax))\b/i;

// Local INR formatting with Indian grouping (avoids importing itinerary-inr).
function inrText(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  const s = String(v);
  if (s.length <= 3) return `INR ${s}`;
  const head = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `INR ${head},${s.slice(-3)}`;
}

function findSnippet(set: EvidenceSet, url: unknown): EvidenceSnippet | undefined {
  if (typeof url !== "string" || !url) return undefined;
  const want = normalizeUrlForCompare(url);
  if (!want) return undefined;
  return set.snippets.find((s) => normalizeUrlForCompare(s.url) === want);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function buildWebBasis(inr: number, kind: ResearchKind, host: string): string {
  const h = String(host ?? "");
  const word =
    kind === "entry-fee" ? "entry" : kind === "meal" ? "meal" : kind === "cab-fare" ? "cab" : kind === "misc" ? "estimate" : "fare";
  const tail = `, per ${h}`;
  const head = inr === 0 ? "Free" : `${inrText(inr)} ${word}`;
  const full = `${head}${tail}`;
  if (full.length <= MAX_BASIS_CHARS) return full;
  // Keep the head; shorten the host last.
  const room = MAX_BASIS_CHARS - head.length - ", per ".length;
  return room > 0 ? `${head}, per ${h.slice(0, room)}` : full.slice(0, MAX_BASIS_CHARS);
}

function isPositivePlain(c: PriceCandidate): boolean {
  return c.max > 0 && (c.audience === "indian" || c.audience === "unspecified");
}

export function checkWebCitation(entry: unknown, ctx: WebCheckContext): WebVerdict {
  try {
    if (!entry || typeof entry !== "object") return { ok: false, reason: "bad-amount" };
    const e = entry as Record<string, unknown>;
    if (e.source !== "web" || typeof e.sourceUrl !== "string") {
      return { ok: false, reason: "no-source" };
    }
    if (typeof e.inr !== "number" || !Number.isFinite(e.inr) || e.inr < 0) {
      return { ok: false, reason: "bad-amount" };
    }
    const inr = Math.round(e.inr);
    const set = ctx.evidence;
    if (!set || !Array.isArray(set.snippets) || set.snippets.length === 0) {
      return { ok: false, reason: "no-evidence" };
    }
    const snip = findSnippet(set, e.sourceUrl);
    if (!snip) return { ok: false, reason: "url-not-supplied" };

    const bound = webBoundFor(ctx.costClass, ctx.budget, ctx.tier);
    if (inr > bound) return { ok: false, reason: "over-bound" };

    const ex = extractPrices(evidenceText(snip));
    const text = evidenceText(snip);
    let matched: PriceCandidate | undefined;

    if (inr === 0) {
      if (!ex.freeEntry || ex.candidates.some(isPositivePlain)) {
        return { ok: false, reason: "free-not-stated" };
      }
    } else {
      let sawParty = false;
      let sawUnit = false;
      for (const c of ex.candidates) {
        if (PARTY_RE.test(text.slice(c.end, c.end + 40))) {
          sawParty = true;
          continue;
        }
        if (ctx.costBasis === "person") {
          if (c.unit === "vehicle") {
            sawUnit = true;
            continue;
          }
          if (c.min <= inr && inr <= c.max) {
            matched = c;
            break;
          }
        } else if (c.unit === "person") {
          if (c.min * VEHICLE_SEATS <= inr && inr <= c.max * VEHICLE_SEATS) {
            matched = c;
            break;
          }
        } else if (c.min <= inr && inr <= c.max) {
          matched = c;
          break;
        }
      }
      if (!matched) {
        return {
          ok: false,
          reason: sawParty ? "party-price" : sawUnit ? "unit-mismatch" : "amount-not-found",
        };
      }
      if (matched.audience === "foreign" && ex.candidates.some(isPositivePlain)) {
        return { ok: false, reason: "foreign-preferred" };
      }
    }

    const sourceUrl = snip.url;
    const sourceHost = hostOf(sourceUrl);
    if (!sourceHost) return { ok: false, reason: "no-source" };
    return {
      ok: true,
      price: {
        inr,
        sourceUrl,
        sourceHost,
        checkedAt: new Date(set.checkedAtMs).toISOString(),
        basis: buildWebBasis(inr, ctx.kind, sourceHost),
      },
    };
  } catch {
    return { ok: false, reason: "bad-amount" };
  }
}

function isInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n);
}

export function checkRouteFare(
  raw: unknown,
  sets: { bus?: EvidenceSet; train?: EvidenceSet },
): RouteFareRange | undefined {
  try {
    if (!raw || typeof raw !== "object") return undefined;
    const r = raw as Record<string, unknown>;
    if (r.mode !== "bus" && r.mode !== "train") return undefined;
    const mode: "bus" | "train" = r.mode;
    const { minInr, maxInr } = r;
    if (!isInt(minInr) || !isInt(maxInr)) return undefined;
    if (!(minInr > 0 && minInr <= maxInr && maxInr <= ROUTE_FARE_MAX_INR)) return undefined;
    const set = sets[mode];
    if (!set || !Array.isArray(set.snippets)) return undefined;
    const snip = findSnippet(set, r.sourceUrl);
    if (!snip) return undefined;

    const cands = extractPrices(evidenceText(snip)).candidates.filter((c) => c.unit !== "vehicle");
    const has = (n: number) => cands.some((c) => c.min === n || c.max === n);
    const oneRange = cands.some((c) => c.min === minInr && c.max === maxInr);
    if (!oneRange && !(has(minInr) && has(maxInr))) return undefined;

    const sourceHost = hostOf(snip.url);
    if (!sourceHost) return undefined;
    return {
      mode,
      minInr,
      maxInr,
      sourceUrl: snip.url,
      sourceHost,
      checkedAt: new Date(set.checkedAtMs).toISOString(),
    };
  } catch {
    return undefined;
  }
}
