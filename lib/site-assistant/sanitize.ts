/**
 * Context_Sanitizer: turns registered page context into the Wire_Context sent
 * to the server. Pure, total (never throws) and idempotent. Safe for client
 * and server modules.
 *
 * Rules (requirement 5): at most 6144 UTF-8 bytes, at most 20 items per list,
 * sensitive property names removed, email-like strings removed, strings
 * truncated to 200 characters with control characters collapsed to one space,
 * and at most 3 levels of nesting (the root value is level 1).
 *
 * Idempotence: every step only removes or shortens content, and the byte
 * budget is enforced by re-running the same transform with progressively
 * tighter limits. Output of any level already satisfies the loosest level, so
 * a second pass changes nothing.
 */
import type { PageId, WireContext } from "./types";

export const MAX_WIRE_BYTES = 6144;
export const MAX_LIST_ITEMS = 20;
export const MAX_STRING_CHARS = 200;
export const MAX_DEPTH = 3;
/** Summary is page prose, not a data value; it gets a slightly larger cap. */
export const MAX_SUMMARY_CHARS = 500;

const MAX_OBJECT_KEYS = 50;
const MAX_KEY_CHARS = 100;

const SENSITIVE_KEY = /token|secret|password|authorization|cookie|email|key/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const CONTROL_RUN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const CONTROL_ANY = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

interface Limits {
  items: number;
  keys: number;
  chars: number;
  summaryChars: number;
}

/** Loosest first. The last level always fits the byte budget. */
const LEVELS: Limits[] = [
  { items: MAX_LIST_ITEMS, keys: MAX_OBJECT_KEYS, chars: MAX_STRING_CHARS, summaryChars: MAX_SUMMARY_CHARS },
  { items: 10, keys: 30, chars: 100, summaryChars: 300 },
  { items: 5, keys: 20, chars: 60, summaryChars: 200 },
  { items: 3, keys: 10, chars: 40, summaryChars: 120 },
  { items: 1, keys: 5, chars: 20, summaryChars: 60 },
  { items: 0, keys: 0, chars: 0, summaryChars: 0 },
];

const DROP: unique symbol = Symbol("drop");

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  let out = s.slice(0, cap);
  const last = out.charCodeAt(out.length - 1);
  // Do not leave half of a surrogate pair behind.
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/** Returns the cleaned string, or DROP when it looks like an email address. */
function cleanString(s: string, cap: number): string | typeof DROP {
  const normalized = s.replace(CONTROL_RUN, " ");
  if (EMAIL.test(normalized)) return DROP;
  return truncate(normalized, cap);
}

function cleanValue(value: unknown, depth: number, lim: Limits): unknown {
  try {
    if (value === null) return null;
    switch (typeof value) {
      case "string":
        return cleanString(value, lim.chars);
      case "number":
        if (!Number.isFinite(value)) return DROP;
        return value === 0 ? 0 : value; // normalizes -0
      case "boolean":
        return value;
      case "object":
        break;
      default:
        return DROP; // undefined, function, symbol, bigint
    }

    if (value instanceof Date) {
      const t = value.getTime();
      return Number.isFinite(t) ? value.toISOString() : DROP;
    }
    if (depth > MAX_DEPTH) return DROP;

    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (let i = 0; i < value.length && out.length < lim.items; i++) {
        const item = cleanValue(value[i], depth + 1, lim);
        if (item !== DROP) out.push(item);
      }
      return out;
    }

    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const key of Object.keys(src)) {
      if (count >= lim.keys) break;
      if (key === "__proto__") continue;
      if (key.length > MAX_KEY_CHARS || CONTROL_ANY.test(key)) continue;
      if (SENSITIVE_KEY.test(key)) continue;
      let child: unknown;
      try {
        child = cleanValue(src[key], depth + 1, lim);
      } catch {
        continue;
      }
      if (child === DROP) continue;
      out[key] = child;
      count++;
    }
    return out;
  } catch {
    return DROP;
  }
}

function build(page: PageId, summary: unknown, data: unknown, lim: Limits): WireContext {
  let cleanSummary = "";
  if (typeof summary === "string") {
    const s = cleanString(summary, lim.summaryChars);
    cleanSummary = s === DROP ? "" : s;
  }
  const cleanData = cleanValue(data, 1, lim);
  return { page, summary: cleanSummary, data: cleanData === DROP ? null : cleanData };
}

function byteLength(w: WireContext): number {
  try {
    const json = JSON.stringify(w);
    return new TextEncoder().encode(json ?? "").length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function sanitizeContext(page: PageId, summary: string, data: unknown): WireContext {
  for (const lim of LEVELS) {
    let wire: WireContext;
    try {
      wire = build(page, summary, data, lim);
    } catch {
      continue;
    }
    if (byteLength(wire) <= MAX_WIRE_BYTES) return wire;
  }
  return { page, summary: "", data: null };
}
