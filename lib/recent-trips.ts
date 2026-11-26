/**
 * Recent saved trips for the Account profile (pure helper).
 * Spec: welcome-idle-saved-trips, Requirements 4.2-4.6, 4.12.
 */

import type { StoredTrip } from "@/lib/trip-retention";

export const RECENT_TRIPS_LIMIT = 5;

export interface RecentTripRow {
  tripId: string;
  name: string;
  destination: string | null;
  whenLabel: string;
  href: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:$|T)/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function timeOf(iso: unknown): number {
  if (typeof iso !== "string") return Number.NEGATIVE_INFINITY;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/** Fixed en-GB style short date ("5 Jun 2025"), independent of locale. */
function shortDate(iso: string): string | null {
  if (!ISO_DATE.test(iso)) return null;
  const y = iso.slice(0, 4);
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function whenLabelOf(trip: StoredTrip): string {
  const payload = isRecord(trip.payload) ? trip.payload : {};
  const itinerary = isRecord(payload.itinerary) ? payload.itinerary : null;
  const days = itinerary && Array.isArray(itinerary.days) ? itinerary.days : [];

  const dates: string[] = [];
  for (const day of days) {
    if (isRecord(day) && typeof day.date === "string") {
      const label = shortDate(day.date);
      if (label) dates.push(label);
    }
  }
  if (dates.length > 0) {
    const first = dates[0];
    const last = dates[dates.length - 1];
    return first === last ? first : `${first} \u2013 ${last}`;
  }

  const n =
    typeof payload.days === "number" && Number.isFinite(payload.days) && payload.days > 0
      ? Math.floor(payload.days)
      : days.length;
  if (n > 0) return n === 1 ? "1 day" : `${n} days`;

  const updated = typeof trip.updatedAt === "string" ? shortDate(trip.updatedAt) : null;
  return `Updated ${updated ?? "recently"}`;
}

/** Newest `limit` trips by `updatedAt` descending (invalid dates last). */
export function selectRecentTrips(
  trips: readonly StoredTrip[],
  limit: number = RECENT_TRIPS_LIMIT,
): RecentTripRow[] {
  const list = Array.isArray(trips) ? trips.filter((t) => isRecord(t) && typeof t.tripId === "string") : [];
  return list
    .map((t, i) => ({ t, i, time: timeOf(t.updatedAt) }))
    .sort((a, b) => (b.time === a.time ? a.i - b.i : b.time > a.time ? 1 : -1))
    .slice(0, Math.max(0, limit))
    .map(({ t }) => {
      const payload = isRecord(t.payload) ? t.payload : {};
      const dest = typeof payload.destination === "string" ? payload.destination.trim() : "";
      const name = typeof t.name === "string" && t.name.trim() ? t.name.trim() : "Untitled trip";
      return {
        tripId: t.tripId,
        name,
        destination: dest || null,
        whenLabel: whenLabelOf(t),
        href: `/plan?trip=${encodeURIComponent(t.tripId)}`,
      };
    });
}
