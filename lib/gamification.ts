/**
 * Gamification engine (pure) - TripGenie's take on the TripSaathi XP/badges/
 * quests idea (FR-06). Everything here is deterministic and idempotent: the
 * same event awarded twice never double-counts, and the derived level/badges/
 * quest-progress are a pure function of the accumulated event set. No React, no
 * storage, no clock - callers own persistence (e.g. the shared trip context).
 */

/** A named, point-bearing milestone the traveller can earn exactly once. */
export type XpEvent =
  | "concierge_started"
  | "route_set"
  | "dates_set"
  | "profile_completed"
  | "itinerary_generated"
  | "day_refined"
  | "flight_selected"
  | "stay_selected"
  | "trip_confirmed"
  | "pdf_downloaded";

export interface XpState {
  /** Total points earned. */
  total: number;
  /** The set of events already awarded, in award order (idempotency key). */
  awarded: XpEvent[];
}

/** Deterministic point value per event. */
export const XP_POINTS: Record<XpEvent, number> = {
  concierge_started: 5,
  route_set: 10,
  dates_set: 10,
  profile_completed: 15,
  itinerary_generated: 20,
  day_refined: 8,
  flight_selected: 12,
  stay_selected: 12,
  trip_confirmed: 25,
  pdf_downloaded: 8,
};

/** A level band derived purely from total XP. */
export interface Level {
  level: number;
  name: string;
  /** Inclusive lower bound of this band. */
  min: number;
  /** Points still needed to reach the next band, or 0 at the top band. */
  toNext: number;
  /** Next band lower bound, or null at the top. */
  nextAt: number | null;
}

const LEVEL_BANDS: Array<{ level: number; name: string; min: number }> = [
  { level: 1, name: "Daydreamer", min: 0 },
  { level: 2, name: "Explorer", min: 25 },
  { level: 3, name: "Navigator", min: 60 },
  { level: 4, name: "Globetrotter", min: 100 },
  { level: 5, name: "Trailblazer", min: 150 },
];

/** A badge unlocked when its required events are all present. */
export interface Badge {
  id: string;
  name: string;
  description: string;
  requires: XpEvent[];
}

export const BADGES: Badge[] = [
  { id: "first-steps", name: "First Steps", description: "Started planning with the concierge.", requires: ["concierge_started"] },
  { id: "route-ready", name: "Route Ready", description: "Locked in your origin, destination and dates.", requires: ["route_set", "dates_set"] },
  { id: "planner", name: "Planner", description: "Generated a full day-by-day itinerary.", requires: ["itinerary_generated"] },
  { id: "curator", name: "Curator", description: "Refined a day to make the plan your own.", requires: ["day_refined"] },
  { id: "booked-in", name: "Booked In", description: "Chose a flight and a stay for the trip.", requires: ["flight_selected", "stay_selected"] },
  { id: "trip-complete", name: "Trip Complete", description: "Confirmed the trip end to end.", requires: ["trip_confirmed"] },
];

/** A multi-step quest; progress is the count of its steps already awarded. */
export interface Quest {
  id: string;
  name: string;
  steps: XpEvent[];
}

export const QUESTS: Quest[] = [
  {
    id: "plan-a-trip",
    name: "Plan your first trip",
    steps: ["concierge_started", "route_set", "dates_set", "itinerary_generated"],
  },
  {
    id: "lock-it-in",
    name: "Lock in the details",
    steps: ["flight_selected", "stay_selected", "trip_confirmed"],
  },
];

export interface QuestProgress {
  id: string;
  name: string;
  done: number;
  total: number;
  complete: boolean;
}

/** The empty starting state. */
export function emptyXp(): XpState {
  return { total: 0, awarded: [] };
}

/**
 * Award an event. Idempotent: a previously-awarded event returns the SAME state
 * object reference unchanged, so callers can safely replay events.
 */
export function award(state: XpState, event: XpEvent): XpState {
  if (state.awarded.includes(event)) return state;
  return { total: state.total + XP_POINTS[event], awarded: [...state.awarded, event] };
}

/** Award many events in order; idempotent across the whole batch. */
export function awardMany(state: XpState, events: XpEvent[]): XpState {
  return events.reduce(award, state);
}

/** Derive the current level band purely from total XP. */
export function levelFor(total: number): Level {
  let band = LEVEL_BANDS[0];
  for (const candidate of LEVEL_BANDS) if (total >= candidate.min) band = candidate;
  const next = LEVEL_BANDS.find((b) => b.min > band.min) ?? null;
  return {
    level: band.level,
    name: band.name,
    min: band.min,
    toNext: next ? next.min - total : 0,
    nextAt: next ? next.min : null,
  };
}

/** The badges unlocked by the current awarded-event set. */
export function earnedBadges(state: XpState): Badge[] {
  const have = new Set(state.awarded);
  return BADGES.filter((badge) => badge.requires.every((req) => have.has(req)));
}

/** Progress across every quest for the current awarded-event set. */
export function questProgress(state: XpState): QuestProgress[] {
  const have = new Set(state.awarded);
  return QUESTS.map((quest) => {
    const done = quest.steps.filter((step) => have.has(step)).length;
    return { id: quest.id, name: quest.name, done, total: quest.steps.length, complete: done === quest.steps.length };
  });
}

/** A single convenience snapshot for a UI panel. */
export interface XpSummary {
  total: number;
  level: Level;
  badges: Badge[];
  quests: QuestProgress[];
}

export function summarize(state: XpState): XpSummary {
  return { total: state.total, level: levelFor(state.total), badges: earnedBadges(state), quests: questProgress(state) };
}