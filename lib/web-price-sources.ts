/**
 * Re-validation of web price fields on stored or rehydrated itineraries.
 * Pure and total. Client-safe: imports no server-only module.
 *
 * An invalid web activity is downgraded to "estimated" with its cost kept;
 * an invalid routeFare is removed. `sources` is never touched here.
 */
import { sanitizeItinerarySources } from "@/lib/grounding/sources";
import { sanitizeStoredVerification } from "@/lib/itinerary/revalidate";
import type { RouteFareRange } from "@/lib/types";
import { ROUTE_FARE_MAX_INR } from "@/lib/web-pricing/citation";

function parseHttps(v: unknown): URL | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.hostname ? u : null;
  } catch {
    return null;
  }
}

function validTime(v: unknown): v is string {
  return typeof v === "string" && Number.isFinite(Date.parse(v));
}

/** True when sourceUrl is absolute https, sourceHost equals its hostname, checkedAt parses. */
export function isValidWebFields(a: {
  sourceUrl?: unknown;
  sourceHost?: unknown;
  checkedAt?: unknown;
}): boolean {
  try {
    if (!a || typeof a !== "object") return false;
    const u = parseHttps(a.sourceUrl);
    return !!u && a.sourceHost === u.hostname && validTime(a.checkedAt);
  } catch {
    return false;
  }
}

/** Validates an untrusted Route_Fare_Range; returns a normalised copy or undefined. */
export function parseRouteFare(raw: unknown): RouteFareRange | undefined {
  try {
    if (!raw || typeof raw !== "object") return undefined;
    const r = raw as Record<string, unknown>;
    const mode = r.mode;
    if (mode !== "bus" && mode !== "train") return undefined;
    const { minInr, maxInr } = r;
    if (
      typeof minInr !== "number" ||
      typeof maxInr !== "number" ||
      !Number.isInteger(minInr) ||
      !Number.isInteger(maxInr) ||
      minInr <= 0 ||
      minInr > maxInr ||
      maxInr > ROUTE_FARE_MAX_INR
    ) {
      return undefined;
    }
    if (!isValidWebFields(r)) return undefined;
    const u = parseHttps(r.sourceUrl) as URL;
    return {
      mode,
      minInr,
      maxInr,
      sourceUrl: u.href,
      sourceHost: u.hostname,
      checkedAt: r.checkedAt as string,
    };
  } catch {
    return undefined;
  }
}

/** Reference-preserving: returns the same object when nothing changes. */
export function sanitizeItineraryWebPrices<T extends object>(it: T): T {
  try {
    if (!it || typeof it !== "object") return it;
    const obj = it as unknown as Record<string, unknown>;
    let out: Record<string, unknown> = obj;

    if (Array.isArray(obj.days)) {
      let daysChanged = false;
      const days = (obj.days as unknown[]).map((d) => {
        if (!d || typeof d !== "object") return d;
        const day = d as Record<string, unknown>;
        if (!Array.isArray(day.activities)) return d;
        let actChanged = false;
        const acts = (day.activities as unknown[]).map((x) => {
          if (!x || typeof x !== "object") return x;
          const a = x as Record<string, unknown>;
          if (a.priceSource !== "web" || isValidWebFields(a)) return x;
          actChanged = true;
          const {
            sourceUrl: _u,
            sourceHost: _h,
            checkedAt: _c,
            priceBasis: _b,
            ...rest
          } = a;
          void _u; void _h; void _c; void _b;
          return { ...rest, priceSource: "estimated" };
        });
        if (!actChanged) return d;
        daysChanged = true;
        return { ...day, activities: acts };
      });
      if (daysChanged) out = { ...out, days };
    }

    if ("routeFare" in obj) {
      const parsed = parseRouteFare(obj.routeFare);
      const cur = obj.routeFare as RouteFareRange | undefined;
      const same =
        parsed !== undefined &&
        !!cur &&
        parsed.mode === cur.mode &&
        parsed.minInr === cur.minInr &&
        parsed.maxInr === cur.maxInr &&
        parsed.sourceUrl === cur.sourceUrl &&
        parsed.sourceHost === cur.sourceHost &&
        parsed.checkedAt === cur.checkedAt &&
        Object.keys(cur).length === 6;
      if (!same) {
        const { routeFare: _r, ...rest } = out;
        void _r;
        out = parsed ? { ...rest, routeFare: parsed } : rest;
      }
    }
    return out as unknown as T;
  } catch {
    return it;
  }
}

export function sanitizeStoredItinerary<T extends object>(it: T): T {
  return sanitizeStoredVerification(
    sanitizeItineraryWebPrices(sanitizeItinerarySources(it)),
  );
}
