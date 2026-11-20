/**
 * Re-validation of stored verification fields (pure, client-safe, total).
 *
 * A verified activity needs a non-empty placeId and a safe mapsUrl; otherwise
 * only `verified`, `placeId` and `mapsUrl` are removed. An invalid photoRef,
 * location or travelToNextMin is removed alone. Reference-preserving: the same
 * object is returned when nothing changes. Idempotent. Never throws.
 */
import { cleanNewActivityFields } from "@/lib/itinerary/activity-fields";
import { isSafeMapsUrl, isValidPhotoRef } from "@/lib/itinerary/maps-link";

function validLocation(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const { lat, lng } = v as { lat?: unknown; lng?: unknown };
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

function validTravel(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 600;
}

function cleanActivity(x: unknown): unknown {
  if (!x || typeof x !== "object") return x;
  const a = x as Record<string, unknown>;
  const drop: string[] = [];

  if (a.verified === true) {
    const idOk = typeof a.placeId === "string" && a.placeId.length > 0;
    if (!idOk || !isSafeMapsUrl(a.mapsUrl)) {
      drop.push("verified", "placeId", "mapsUrl");
    }
  }
  if ("photoRef" in a && !isValidPhotoRef(a.photoRef)) drop.push("photoRef");
  if ("location" in a && !validLocation(a.location)) drop.push("location");
  if ("travelToNextMin" in a && !validTravel(a.travelToNextMin)) {
    drop.push("travelToNextMin");
  }

  const present = drop.filter((k) => k in a);
  let base: Record<string, unknown> = a;
  if (present.length > 0) {
    base = {};
    for (const k of Object.keys(a)) if (!present.includes(k)) base[k] = a[k];
  }
  const fields = cleanNewActivityFields(base);
  if (fields) return fields;
  return base === a ? x : base;
}

export function sanitizeStoredVerification<T extends object>(it: T): T {
  try {
    if (!it || typeof it !== "object") return it;
    const obj = it as unknown as Record<string, unknown>;
    if (!Array.isArray(obj.days)) return it;
    let daysChanged = false;
    const days = (obj.days as unknown[]).map((d) => {
      if (!d || typeof d !== "object") return d;
      const day = d as Record<string, unknown>;
      if (!Array.isArray(day.activities)) return d;
      let changed = false;
      const acts = (day.activities as unknown[]).map((x) => {
        const y = cleanActivity(x);
        if (y !== x) changed = true;
        return y;
      });
      if (!changed) return d;
      daysChanged = true;
      return { ...day, activities: acts };
    });
    return daysChanged ? ({ ...obj, days } as unknown as T) : it;
  } catch {
    return it;
  }
}
