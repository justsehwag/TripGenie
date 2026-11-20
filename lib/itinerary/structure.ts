import { MAX_DAY_TRAVEL_MIN, MAX_DAY_TRIP_LEG_MIN, MAX_LEG_TRAVEL_MIN } from "./constants";
import { legMinutes, reorderIfShorter, type LatLng } from "./geo";
import type { DayLimits } from "./pace";
import type { StopKind } from "./place-key";

/**
 * Pure day-structure evaluation. Client-safe: no server imports. Total and
 * never throws. A leg whose locations are not finite counts as 0 minutes
 * (legMinutes already returns 0), so unlocatable stops never cause a removal.
 */

export interface VerifiedStop {
  key: string; // Place_Key, the placeId
  placeId: string;
  placeName: string;
  mapsUrl: string;
  location: LatLng;
  time: string;
  place: string;
  area: string;
  kind: StopKind;
  description: string;
  cost: number;
  slot: number; // index in the proposed day
}

export interface DayEvaluation {
  status: "verified" | "withheld";
  stops: Array<VerifiedStop & { travelToNextMin?: number }>;
  removed: VerifiedStop[];
  reason?: "too-few" | "travel";
}

/** Day travel limit in minutes; a day trip gets one longer leg. */
export function dayTravelLimit(dayTrip: boolean): number {
  return dayTrip
    ? MAX_DAY_TRAVEL_MIN + (MAX_DAY_TRIP_LEG_MIN - MAX_LEG_TRAVEL_MIN)
    : MAX_DAY_TRAVEL_MIN;
}

function legsOf(stops: readonly VerifiedStop[]): number[] {
  const legs: number[] = [];
  for (let i = 1; i < stops.length; i++) {
    legs.push(legMinutes(stops[i - 1].location, stops[i].location));
  }
  return legs;
}

function acceptable(stops: readonly VerifiedStop[], dayTrip: boolean): boolean {
  const legs = legsOf(stops);
  let sum = 0;
  let long = 0;
  for (const leg of legs) {
    sum += leg;
    if (leg > MAX_LEG_TRAVEL_MIN) {
      if (!dayTrip || leg > MAX_DAY_TRIP_LEG_MIN) return false;
      long += 1;
    }
  }
  return long <= 1 && sum <= dayTravelLimit(dayTrip);
}

export function evaluateDay(
  stops: readonly VerifiedStop[],
  limits: DayLimits,
  opts: { dayTrip: boolean },
): DayEvaluation {
  try {
    const dayTrip = !!(opts && opts.dayTrip);
    const input = Array.isArray(stops) ? stops : [];
    const max = Math.max(0, Math.floor(limits.max));
    const min = Math.max(1, Math.floor(limits.min));

    // 1. keep the first `max` stops; trailing extras are dropped without repair
    let current: VerifiedStop[] = input.slice(0, max);
    const removed: VerifiedStop[] = [];

    // 2-5. at most current.length iterations: each pass removes one stop or ends
    for (;;) {
      if (acceptable(current, dayTrip)) break;
      const reordered = reorderIfShorter(current);
      if (acceptable(reordered, dayTrip)) {
        current = reordered;
        break;
      }
      current = reordered;
      if (current.length <= 1) break; // cannot happen (no legs), defensive
      // remove the stop whose removal leaves the least total travel (the outlier,
      // not its neighbour); ties: the later stop
      let worst = 0;
      let bestTotal = Infinity;
      for (let i = 0; i < current.length; i++) {
        const total = legsOf(current.filter((_, j) => j !== i)).reduce((a, b) => a + b, 0);
        if (total <= bestTotal) {
          bestTotal = total;
          worst = i;
        }
      }
      removed.push(current[worst]);
      current = current.filter((_, i) => i !== worst);
      if (current.length < min) {
        return { status: "withheld", stops: current, removed, reason: "travel" };
      }
    }

    if (current.length < min) {
      return {
        status: "withheld",
        stops: current,
        removed,
        reason: removed.length > 0 ? "travel" : "too-few",
      };
    }

    // 6. fill travelToNextMin on a verified day
    const legs = legsOf(current);
    const out = current.map((s, i) =>
      i < current.length - 1 ? { ...s, travelToNextMin: legs[i] } : { ...s },
    );
    return { status: "verified", stops: out, removed };
  } catch {
    return { status: "withheld", stops: [], removed: [], reason: "too-few" };
  }
}
