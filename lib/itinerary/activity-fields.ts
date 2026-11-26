/**
 * Validation of the optional places-first Activity fields: openingHours,
 * hoursLabel, photos and webDetails. Shared by the wire reader and the stored
 * itinerary sanitiser. Pure, total, client-safe.
 *
 * An invalid field is dropped alone; the Stop is kept. Photos beyond the first
 * 3 valid names are discarded. Reference-preserving: `cleanNewActivityFields`
 * returns null when nothing changes. Idempotent.
 */
import { isValidPhotoRef } from "@/lib/itinerary/maps-link";
import { sanitizeWebDetails } from "@/lib/itinerary/web-details";
import { PRICE_MAX_INR } from "@/lib/price-limits";
import { isValidWebFields } from "@/lib/web-price-sources";

export const MAX_STOP_PHOTOS = 3;
const MAX_HOURS_CHARS = 300;
const MAX_BASIS_CHARS = 120;
const MAX_REASONS = 8;
const MAX_REASON_CHARS = 40;

function isInrInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= PRICE_MAX_INR;
}

function isIsoTime(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 40 && Number.isFinite(Date.parse(v));
}

/**
 * Validates an untrusted priceFallback; returns a normalised copy, or undefined
 * when nothing valid remains. Invalid parts are dropped alone. Idempotent.
 */
function sanitizePriceFallback(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  const g = r.google;
  if (g && typeof g === "object" && !Array.isArray(g)) {
    const go = g as Record<string, unknown>;
    if (isIsoTime(go.checkedAt)) {
      const clean: Record<string, unknown> = {};
      const lvl = go.level;
      if (typeof lvl === "number" && Number.isInteger(lvl) && lvl >= 0 && lvl <= 4) clean.level = lvl;
      const rg = go.range;
      if (rg && typeof rg === "object") {
        const { lowInr, highInr } = rg as Record<string, unknown>;
        if (isInrInt(lowInr) && isInrInt(highInr) && lowInr <= highInr) clean.range = { lowInr, highInr };
      }
      if (clean.level !== undefined || clean.range !== undefined) {
        clean.checkedAt = go.checkedAt;
        out.google = clean;
      }
    }
  }

  const ai = r.ai;
  if (ai && typeof ai === "object" && !Array.isArray(ai)) {
    const { lowInr, highInr, basis, checkedAt } = ai as Record<string, unknown>;
    if (
      isInrInt(lowInr) &&
      isInrInt(highInr) &&
      lowInr <= highInr &&
      typeof basis === "string" &&
      basis.length <= MAX_BASIS_CHARS &&
      isIsoTime(checkedAt)
    ) {
      out.ai = { lowInr, highInr, basis, checkedAt };
    }
  }

  const uw = r.unverifiedWeb;
  if (uw && typeof uw === "object" && !Array.isArray(uw)) {
    const { inr, sourceUrl, sourceHost, checkedAt, reasons } = uw as Record<string, unknown>;
    if (isInrInt(inr) && isValidWebFields({ sourceUrl, sourceHost, checkedAt })) {
      const rs = Array.isArray(reasons)
        ? reasons
            .filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= MAX_REASON_CHARS)
            .slice(0, MAX_REASONS)
        : [];
      out.unverifiedWeb = { inr, sourceUrl, sourceHost, checkedAt, reasons: rs };
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/**
 * Returns null when the activity's new fields are all valid (or absent), else a
 * shallow copy with invalid fields removed and photos / webDetails normalised.
 */
export function cleanNewActivityFields(a: Record<string, unknown>): Record<string, unknown> | null {
  try {
    const drop: string[] = [];
    const set: Record<string, unknown> = {};

    if ("openingHours" in a) {
      const v = a.openingHours;
      if (typeof v !== "string" || v.trim().length === 0 || v.length > MAX_HOURS_CHARS) {
        drop.push("openingHours");
      }
    }
    if ("hoursLabel" in a) {
      const v = a.hoursLabel;
      if (v !== "Typical hours" && v !== "Hours not listed") drop.push("hoursLabel");
    }
    if ("photos" in a) {
      const v = a.photos;
      if (!Array.isArray(v)) {
        drop.push("photos");
      } else {
        const kept: string[] = [];
        for (const p of v) {
          if (kept.length >= MAX_STOP_PHOTOS) break;
          if (isValidPhotoRef(p)) kept.push(p);
        }
        if (kept.length === 0) drop.push("photos");
        else if (kept.length !== v.length) set.photos = kept;
      }
    }
    if ("webDetails" in a) {
      const clean = sanitizeWebDetails(a.webDetails);
      if (clean === undefined) drop.push("webDetails");
      else if (!deepEqual(clean, a.webDetails)) set.webDetails = clean;
    }

    if ("priceFallback" in a) {
      const clean = sanitizePriceFallback(a.priceFallback);
      if (clean === undefined) drop.push("priceFallback");
      else if (!deepEqual(clean, a.priceFallback)) set.priceFallback = clean;
    }

    if ("visitMin" in a) {
      const v = a.visitMin;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 1440) drop.push("visitMin");
    }

    if (drop.length === 0 && Object.keys(set).length === 0) return null;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(a)) if (!drop.includes(k)) out[k] = a[k];
    for (const k of Object.keys(set)) out[k] = set[k];
    return out;
  } catch {
    return null;
  }
}
