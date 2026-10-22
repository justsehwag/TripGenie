import type { Activity, Itinerary, TripContext, TripDay } from "./types";
import { seedSights } from "./sights";

/**
 * Itinerary generation & revision (pure) — design section "11. Itinerary".
 * Ported from TripSaathi buildDynamicItinerary/refineItinerary.
 * Exactly 5 timed activities per day; D day entries; non-negative revised totals.
 * Requirements: 6.6, 8.4, 9.1-9.3.
 */

export interface ItineraryInput {
  destination: string;
  startDate: string;
  days: number;
  vibes?: string[];
}

const clampDays = (n: number): number => Math.min(14, Math.max(1, Math.trunc(n)));

const isoAt = (start: string, offset: number): string => {
  const base = Date.parse(`${start}T00:00:00Z`);
  const d = new Date(Number.isNaN(base) ? Date.now() : base);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

/**
 * Build five timed activities for a day that reference REAL, destination-
 * specific places. We pull the curated six sights for the destination (from
 * lib/sights.ts) and anchor the morning + afternoon sightseeing on actual named
 * landmarks, rotating by day so each day visits different places. Meals and the
 * arrival/departure bookends still frame the day, but the sightseeing is always
 * a concrete place (e.g. "Burj Khalifa", not "signature experience"), so the
 * itinerary reads specifically and each activity can fetch a real photo.
 */
function dayActivities(dest: string, day: number, last: boolean, vibe: string): Activity[] {
  const sights = seedSights(dest);
  const n = sights.length || 1;
  // Two distinct sights per day, rotating so consecutive days differ.
  const morning = sights[((day - 1) * 2) % n];
  const afternoon = sights[((day - 1) * 2 + 1) % n];
  const morningName = morning ? morning.name : `${dest} old town`;
  const morningArea = morning ? morning.area : dest;
  const afternoonName = afternoon ? afternoon.name : `${dest} waterfront`;
  const afternoonArea = afternoon ? afternoon.area : dest;

  return [
    {
      time: "08:30",
      title: day === 1 ? `Arrive in ${dest} and settle in` : `Breakfast near ${morningArea}`,
      description: day === 1 ? "Airport transfer, check-in and an easy first stroll." : `A ${vibe} start before the day's sights.`,
      cost: 1200,
    },
    {
      time: "10:30",
      title: `Visit ${morningName}`,
      description: `${morningName} in ${morningArea} - ${vibe} highlight of the morning.`,
      cost: 2600,
    },
    {
      time: "13:00",
      title: `Lunch in ${morningArea}`,
      description: `A local table near ${morningName}, matched to your preferences.`,
      cost: 1800,
    },
    {
      time: "15:30",
      title: last ? `Final stop: ${afternoonName}` : `Explore ${afternoonName}`,
      description: `${afternoonName} in ${afternoonArea}${last ? " - a relaxed farewell visit." : `, a ${vibe} afternoon.`}`,
      cost: 2200,
    },
    {
      time: "19:00",
      title: last ? `Departure transfer from ${dest}` : `Evening around ${afternoonArea}`,
      description: last ? "Buffer included for a calm departure." : `Dinner and a wander to close Day ${day}.`,
      cost: 1900,
    },
  ];
}

/** Generate a full itinerary with exactly D days and 5 activities each (Req 6.6, 9.1). */
export function buildItinerary(input: ItineraryInput): Itinerary {
  const count = clampDays(input.days);
  const vibes = input.vibes && input.vibes.length ? input.vibes : ["Local culture"];
  const days: TripDay[] = Array.from({ length: count }, (_, i) => {
    const day = i + 1;
    const last = day === count;
    const vibe = vibes[i % vibes.length];
    const activities = dayActivities(input.destination, day, last, vibe);
    const total = activities.reduce((s, a) => s + a.cost, 0);
    return {
      day,
      date: isoAt(input.startDate, i),
      title: day === 1 ? `Arrive in ${input.destination}` : last ? `${input.destination} farewell` : `${activities[1]?.title.replace(/^Visit /, "") ?? vibe}`,
      theme: vibe,
      activities,
      total,
    };
  });
  return {
    title: `${input.destination} trip`,
    totalCost: days.reduce((s, d) => s + d.total, 0),
    days,
  };
}

/** Revise only the targeted day and trip totals; clamp revised day total to >= 0 (Req 9.2/9.3). */
export function refineItinerary(itinerary: Itinerary, dayNumber: number, budgetDelta: number): Itinerary {
  const days = itinerary.days.map((d) => {
    if (d.day !== dayNumber) return d;
    return { ...d, total: Math.max(0, d.total + Math.round(budgetDelta)) };
  });
  return {
    ...itinerary,
    days,
    totalCost: days.reduce((s, d) => s + d.total, 0),
    revised: true,
  };
}

/** Persist a selected flight's identifying fields into TripContext (Req 8.4). */
export function selectFlight(context: TripContext, flight: { flightNo: string; date: string; depart: string; arrive: string }): TripContext {
  return { ...context, selectedFlight: { ...flight } };
}
