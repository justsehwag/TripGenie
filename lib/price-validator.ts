/**
 * Price validation for the Bedrock activity-pricing route (Req 6.6-6.12).
 *
 * Pure, framework-free and total: nothing in this module throws.
 *
 * The design places `PricerActivity` / `PriceResult` in `lib/activity-pricer.ts`.
 * That file is created by a separate task, so this module declares structurally
 * identical shapes locally (generic over the activity type) to avoid a hard
 * dependency. They are assignable to and from the activity-pricer types.
 */

import { PRICE_MAX_INR } from "./price-limits";
import { checkWebCitation, type WebCheckContext } from "./web-pricing/citation";

export { PRICE_MAX_INR };
export const BASIS_MAX = 120;
export const DEFAULT_BASIS = "AI estimate for a typical adult visitor.";
export const ESTIMATED_BASIS = "Typical cost for this kind of activity, converted to INR.";

interface ActivityLike {
  id: string;
}

export interface ValidatedPrice {
  id: string;
  inr: number;
  basis: string;
  source: "ai" | "estimated" | "web";
  /** Only when the model returned a valid value. */
  unit?: "person" | "group";
  /** Only for source "web"; all server-built. */
  sourceUrl?: string;
  sourceHost?: string;
  checkedAt?: string;
}

export interface WebValidation<T> {
  /** Context for the activity, or undefined when no evidence was shown for it. */
  contextFor(a: T): WebCheckContext | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * First balanced top-level JSON object in `text` that parses to a plain object, else null.
 * String/escape aware, iterative (never recurses), never throws.
 */
export function extractFirstJsonObject(text: string): Record<string, unknown> | null {
  try {
    if (typeof text !== "string") return null;
    const n = text.length;
    for (let i = 0; i < n; i++) {
      if (text[i] !== "{") continue;
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let j = i; j < n; j++) {
        const ch = text[j];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            try {
              const parsed: unknown = JSON.parse(text.slice(i, j + 1));
              if (isPlainObject(parsed)) return parsed;
            } catch {
              // not valid JSON; try the next "{"
            }
            break;
          }
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function safeEstimate<T extends ActivityLike>(a: T, estimateInr: (a: T) => number): number {
  try {
    const v = estimateInr(a);
    if (typeof v !== "number" || !Number.isFinite(v)) return 0;
    return Math.min(PRICE_MAX_INR, Math.max(0, Math.round(v)));
  } catch {
    return 0;
  }
}

function normalizeBasis(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_BASIS;
  let s = value.replace(/\s+/g, " ").trim();
  if (s.length > BASIS_MAX) s = s.slice(0, BASIS_MAX);
  // Drop a dangling high surrogate left by truncation (or present in the input).
  if (s.length > 0) {
    const last = s.charCodeAt(s.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
  }
  s = s.trim();
  return s === "" ? DEFAULT_BASIS : s;
}

function estimated<T extends ActivityLike>(
  a: T,
  estimateInr: (a: T) => number,
): ValidatedPrice {
  return { id: a.id, inr: safeEstimate(a, estimateInr), basis: ESTIMATED_BASIS, source: "estimated" };
}

/**
 * Total. Never throws for any raw value of any type.
 * Returns exactly one result per activity, same order and ids.
 */
export function validatePrices<T extends ActivityLike>(
  raw: unknown,
  activities: readonly T[],
  estimateInr: (a: T) => number,
  web?: WebValidation<T>,
): ValidatedPrice[] {
  let list: readonly T[] = [];
  try {
    list = Array.isArray(activities) ? activities : [];
  } catch {
    list = [];
  }
  try {
    const obj = isPlainObject(raw) ? raw : typeof raw === "string" ? extractFirstJsonObject(raw) : null;
    if (!obj) return list.map((a) => estimated(a, estimateInr));

    const entries: unknown[] = Array.isArray(obj.prices) ? obj.prices : [];
    const requested = new Set<string>(list.map((a) => a.id));
    const count = new Map<string, number>();
    const byId = new Map<string, Record<string, unknown>>();
    for (const e of entries) {
      if (!isPlainObject(e)) continue;
      const id = e.id;
      if (typeof id !== "string" || !requested.has(id)) continue;
      count.set(id, (count.get(id) ?? 0) + 1);
      byId.set(id, e);
    }

    return list.map((a): ValidatedPrice => {
      try {
        if (count.get(a.id) !== 1) return estimated(a, estimateInr);
        const entry = byId.get(a.id);
        const inr = entry?.inr;
        if (typeof inr !== "number" || !Number.isFinite(inr) || inr < 0) {
          return estimated(a, estimateInr);
        }
        const unit = entry?.unit === "person" || entry?.unit === "group" ? entry.unit : undefined;
        if (entry?.source === "web") {
          const ctx = web?.contextFor(a);
          if (!ctx) return estimated(a, estimateInr);
          const verdict = checkWebCitation(entry, ctx);
          if (!verdict.ok) return estimated(a, estimateInr);
          const p = verdict.price;
          return {
            id: a.id,
            inr: Math.min(PRICE_MAX_INR, p.inr),
            basis: p.basis,
            source: "web",
            ...(unit ? { unit } : {}),
            sourceUrl: p.sourceUrl,
            sourceHost: p.sourceHost,
            checkedAt: p.checkedAt,
          };
        }
        return {
          id: a.id,
          inr: Math.min(PRICE_MAX_INR, Math.round(inr)),
          basis: normalizeBasis(entry?.basis),
          source: "ai",
          ...(unit ? { unit } : {}),
        };
      } catch {
        return estimated(a, estimateInr);
      }
    });
  } catch {
    return list.map((a) => estimated(a, estimateInr));
  }
}
