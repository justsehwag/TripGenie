import type { Activity, Itinerary, TripContext, TripDay } from "./types";

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

function dayActivities(dest: string, day: number, last: boolean, vibe: string): Activity[] {
  return [
    { time: "08:30", title: day === 1 ? `Arrival in ${dest}` : "Breakfast and briefing", description: `A ${vibe} start to Day ${day}.`, cost: 1200 },
    { time: "10:30", title: `${dest} signature experience`, description: `${vibe} focus.`, cost: 2600 },
    { time: "13:00", title: `Local lunch in ${dest}`, description: "Dining matched to your preferences.", cost: 1800 },
    { time: "15:30", title: last ? "Farewell walk and keepsake stop" : `Afternoon in ${dest}`, description: last ? "A flexible final activity." : `${vibe} exploration.`, cost: 2200 },
    { time: "19:00", title: last ? "Departure transfer" : "Evening neighbourhood experience", description: `An unhurried close to Day ${day}.`, cost: 1900 },
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
      title: day === 1 ? `Arrive in ${input.destination}` : last ? `${input.destination} farewell` : `${vibe} in ${input.destination}`,
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
