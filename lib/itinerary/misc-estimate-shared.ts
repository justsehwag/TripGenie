/**
 * Misc (web prices) shared helpers. Pure and client-safe: no server imports,
 * nothing here throws, and no amount is ever created by this module. Amounts
 * only pass through when they carry valid web source fields.
 */
import { hasCertaintyClaim } from "@/lib/itinerary/labels";
import { PRICE_MAX_INR } from "@/lib/price-limits";
import { isValidWebFields } from "@/lib/web-price-sources";

export type MiscCategory = "transport" | "parking" | "water-snacks" | "tips" | "entry";

/** A miscellaneous item named by the model. Never carries an amount. */
export interface MiscName {
  label: string;
  category: MiscCategory;
  hint: string;
  stopIndex?: number;
}

/** A priced misc item. The amount comes from a cited web snippet only. */
export interface MiscItem {
  label: string;
  amountInr: number;
  basis?: string;
  sourceUrl: string;
  sourceHost: string;
  checkedAt: string;
}

export type MiscResult =
  | { status: "ok"; items: MiscItem[]; sumInr: number; missing: string[] }
  | { status: "none"; missing: string[] }
  | { status: "unavailable" };

export const MISC_MAX_ITEMS = 6;
export const MISC_LABEL_MAX = 60;
export const MISC_HINT_MAX = 120;
const MISC_BASIS_MAX = 40;
const MISC_MAX_STOP_INDEX = 11;

export const MISC_WEB_TITLE = "Misc (web prices)";
export const MISC_NOT_IN_TOTAL = "Not in Day total";
export const MISC_NONE_TEXT = "No web prices found";
export const MISC_UNAVAILABLE_TEXT = "Misc prices not checked (price lookup unavailable)";
export const MISC_MISSING_PREFIX = "No web price found for: ";

/** Search subjects used when the model fails. Names and hints only, never prices. */
export const FALLBACK_NAMES: readonly MiscName[] = Object.freeze([
  Object.freeze({
    label: "Local transport",
    category: "transport" as const,
    hint: "local taxi auto rickshaw fare",
  }),
  Object.freeze({
    label: "Parking",
    category: "parking" as const,
    hint: "parking charges",
  }),
  Object.freeze({
    label: "Water and snacks",
    category: "water-snacks" as const,
    hint: "water bottle snacks",
  }),
]);

const CATEGORIES: readonly MiscCategory[] = [
  "transport",
  "parking",
  "water-snacks",
  "tips",
  "entry",
];

const UNAVAILABLE: MiscResult = { status: "unavailable" };

function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through to first-object extraction */
  }
  const start = t.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(t.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function toValue(raw: unknown): unknown {
  return typeof raw === "string" ? extractJson(raw) : raw;
}

function listOf(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const l = (value as { items?: unknown }).items;
    if (Array.isArray(l)) return l;
  }
  return null;
}

function normLabel(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** A clean label: non-empty, within the limit, no certainty claim. */
function cleanLabel(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const label = v.replace(/\s+/g, " ").trim();
  if (!label || label.length > MISC_LABEL_MAX || hasCertaintyClaim(label)) return null;
  return label;
}

function toName(raw: unknown): MiscName | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const label = cleanLabel(r.label);
  if (!label) return null;
  const category = typeof r.category === "string" ? r.category.trim().toLowerCase() : "";
  if (!(CATEGORIES as readonly string[]).includes(category)) return null;
  let hint = "";
  if (r.hint !== undefined && r.hint !== null) {
    if (typeof r.hint !== "string") return null;
    hint = r.hint.replace(/\s+/g, " ").trim();
    if (hint.length > MISC_HINT_MAX || hasCertaintyClaim(hint)) return null;
  }
  const name: MiscName = { label, category: category as MiscCategory, hint };
  const si = r.stopIndex;
  if (
    typeof si === "number" &&
    Number.isInteger(si) &&
    si >= 0 &&
    si <= MISC_MAX_STOP_INDEX
  ) {
    name.stopIndex = si;
  }
  return name;
}

/**
 * Validate a model reply (text with optional code fences, or a parsed value)
 * into item names. Whitelists label, category, hint and stopIndex, so any
 * amount, price or cost field is dropped. Never throws.
 */
export function parseMiscNames(raw: unknown): MiscName[] {
  try {
    const list = listOf(toValue(raw));
    if (!list) return [];
    const out: MiscName[] = [];
    const seen = new Set<string>();
    for (const entry of list) {
      if (out.length >= MISC_MAX_ITEMS) break;
      const name = toName(entry);
      if (!name) continue;
      const key = normLabel(name.label);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
    return out;
  } catch {
    return [];
  }
}

/** Plain sum of the shown amounts. */
export function miscSum(items: readonly MiscItem[]): number {
  let s = 0;
  for (const i of items) s += i.amountInr;
  return s;
}

function toMiscItem(raw: unknown): MiscItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const label = cleanLabel(r.label);
  if (!label) return null;
  const n = r.amountInr;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > PRICE_MAX_INR) return null;
  if (!isValidWebFields(r)) return null;
  const sourceUrl = r.sourceUrl as string;
  if (!/^https:\/\//i.test(sourceUrl.trim())) return null;
  const item: MiscItem = {
    label,
    amountInr: n,
    sourceUrl,
    sourceHost: r.sourceHost as string,
    checkedAt: r.checkedAt as string,
  };
  if (typeof r.basis === "string") {
    const basis = r.basis.replace(/\s+/g, " ").trim();
    if (basis) {
      if (basis.length > MISC_BASIS_MAX || hasCertaintyClaim(basis)) return null;
      item.basis = basis;
    }
  }
  return item;
}

function cleanMissing(v: unknown, exclude: Set<string>): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>(exclude);
  for (const x of v) {
    const label = cleanLabel(x);
    if (!label) continue;
    const key = normLabel(label);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= MISC_MAX_ITEMS) break;
  }
  return out;
}

/**
 * Validate a server reply on the client. The sum is recomputed, never trusted.
 * An `ok` reply with no valid item becomes `none`. Never throws.
 */
export function parseMiscResult(raw: unknown): MiscResult {
  try {
    const value = toValue(raw);
    if (!value || typeof value !== "object") return UNAVAILABLE;
    const v = value as Record<string, unknown>;
    if (v.status === "none") {
      return { status: "none", missing: cleanMissing(v.missing, new Set()) };
    }
    if (v.status !== "ok") return UNAVAILABLE;
    const items: MiscItem[] = [];
    const seen = new Set<string>();
    if (Array.isArray(v.items)) {
      for (const entry of v.items) {
        if (items.length >= MISC_MAX_ITEMS) break;
        const item = toMiscItem(entry);
        if (!item) continue;
        const key = normLabel(item.label);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(item);
      }
    }
    const missing = cleanMissing(v.missing, seen);
    if (items.length === 0) return { status: "none", missing };
    return { status: "ok", items, sumInr: miscSum(items), missing };
  } catch {
    return UNAVAILABLE;
  }
}

function keyPart(s: unknown): string {
  return String(s ?? "")
    .replace(/\|/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Stable cache key: destination, travellers, then each stop in order. */
export function miscCacheKey(
  destination: string,
  travellers: number,
  stops: { placeId?: string; title: string }[],
): string {
  const parts = [
    keyPart(destination).toLowerCase(),
    keyPart(travellers),
    ...stops.map((s) =>
      keyPart(s.placeId ? s.placeId : String(s.title ?? "").toLowerCase()),
    ),
  ];
  return parts.join("|");
}

/** Make untrusted text safe to place inside a prompt. */
export function sanitizeForPrompt(s: unknown, max: number): string {
  const text = typeof s === "string" ? s : s == null ? "" : String(s);
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f`{}<>"]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Math.max(0, max))
    .trim();
}
