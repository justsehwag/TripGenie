import { DAY_TRIP_RADIUS_KM, DESTINATION_RADIUS_KM, ROAD_SPEED_KMH } from "./constants";
import { nameKey } from "./place-key";

/**
 * Pure geography helpers for the itinerary pipeline. Client-safe: no server
 * imports. Every function is total and never throws.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_KM = 6371;

function isLatLng(p: unknown): p is LatLng {
  if (!p || typeof p !== "object") return false;
  const { lat, lng } = p as { lat?: unknown; lng?: unknown };
  return (
    typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng)
  );
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in km. NaN when either point is not finite. */
export function haversineKm(a: LatLng, b: LatLng): number {
  if (!isLatLng(a) || !isLatLng(b)) return NaN;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  const clamped = Math.min(1, Math.max(0, h));
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(clamped));
}

/** Estimated road minutes for a straight-line distance: an integer >= 0. */
export function travelMinutes(km: number): number {
  if (typeof km !== "number" || !Number.isFinite(km) || km <= 0) return 0;
  const m = Math.round((km * 60) / ROAD_SPEED_KMH);
  return Number.isFinite(m) && m > 0 ? m : 0;
}

/** Estimated road minutes between two points; 0 when either is not finite. */
export function legMinutes(a: LatLng, b: LatLng): number {
  return travelMinutes(haversineKm(a, b));
}

export function isWithinDestination(
  c: { address: string; location: LatLng | null },
  destination: string,
  centre: LatLng | null,
  dayTrip: boolean,
): boolean {
  try {
    const destKey = nameKey(typeof destination === "string" ? destination : "");
    const address = c && typeof c.address === "string" ? c.address : "";
    if (destKey && nameKey(address).includes(destKey)) return true;
    if (!c || !isLatLng(c.location) || !isLatLng(centre)) return false;
    const km = haversineKm(centre, c.location);
    const limit = dayTrip ? DAY_TRIP_RADIUS_KM : DESTINATION_RADIUS_KM;
    return Number.isFinite(km) && km <= limit;
  } catch {
    return false;
  }
}

function totalKm(stops: readonly { location: LatLng }[]): number {
  let sum = 0;
  for (let i = 1; i < stops.length; i++) {
    sum += haversineKm(stops[i - 1].location, stops[i].location);
  }
  return sum;
}

/**
 * Nearest-neighbour order starting at the first stop. Returned only when its
 * total distance is strictly shorter than the original; otherwise a copy of
 * the original order. Stops without finite locations keep the original order.
 */
export function reorderIfShorter<T extends { location: LatLng }>(stops: readonly T[]): T[] {
  if (!Array.isArray(stops)) return [];
  const original = stops.slice();
  if (original.length < 3) return original;
  if (!original.every((s) => s && isLatLng(s.location))) return original;

  const remaining = original.slice(1);
  const order: T[] = [original[0]];
  let current = original[0];
  while (remaining.length > 0) {
    let best = 0;
    let bestKm = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const km = haversineKm(current.location, remaining[i].location);
      if (km < bestKm) {
        bestKm = km;
        best = i;
      }
    }
    current = remaining.splice(best, 1)[0];
    order.push(current);
  }
  return totalKm(order) < totalKm(original) ? order : original;
}

/** "about 25 min by road, estimate". Non-finite or negative input gives 0. */
export function travelLabel(minutes: number): string {
  const m =
    typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
  return `about ${m} min by road, estimate`;
}

/** Like `legMinutes`, rounded up to whole minutes (0 when either point is not finite). */
export function legMinutesUp(a: LatLng, b: LatLng): number {
  const km = haversineKm(a, b);
  if (!Number.isFinite(km) || km <= 0) return 0;
  const m = Math.ceil((km * 60) / ROAD_SPEED_KMH);
  return Number.isFinite(m) && m > 0 ? m : 0;
}
