/**
 * Pure day-edit helpers shared by Edit Day (components/planner.tsx) and the
 * Trip Assistant (lib/assistant/proposal.ts). Each helper returns a new
 * itinerary with `revised: true` and `recomputeTotals` applied. Out-of-range
 * input returns the same object. Inputs are never mutated.
 */

import type { Activity, Itinerary } from "../types";
import { recomputeTotals } from "../itinerary-inr";

function hasDay(it: Itinerary, day: number): boolean {
  return it.days.some((d) => d.day === day);
}

function isIndex(n: unknown, max: number): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= max;
}

function finish(it: Itinerary, days: Itinerary["days"]): Itinerary {
  return recomputeTotals({ ...it, days, revised: true });
}

/** Remove the activity at `index` of day number `day`. */
export function removeActivityAt(it: Itinerary, day: number, index: number): Itinerary {
  const target = it.days.find((d) => d.day === day);
  if (!target || !isIndex(index, target.activities.length - 1)) return it;
  const days = it.days.map((d) =>
    d.day !== day ? d : { ...d, activities: d.activities.filter((_, i) => i !== index) },
  );
  return finish(it, days);
}

/** Append an activity to the end of day number `day`. */
export function appendActivity(it: Itinerary, day: number, a: Activity): Itinerary {
  if (!hasDay(it, day)) return it;
  const days = it.days.map((d) => (d.day !== day ? d : { ...d, activities: [...d.activities, a] }));
  return finish(it, days);
}

/** Insert an activity so it ends up at `index` (0..length) of day number `day`. */
export function insertActivityAt(it: Itinerary, day: number, index: number, a: Activity): Itinerary {
  const target = it.days.find((d) => d.day === day);
  if (!target || !isIndex(index, target.activities.length)) return it;
  const days = it.days.map((d) =>
    d.day !== day
      ? d
      : { ...d, activities: [...d.activities.slice(0, index), a, ...d.activities.slice(index)] },
  );
  return finish(it, days);
}

/**
 * Move one activity. `to.index` is the final position in the destination day
 * (after the activity has been taken out of its source day). Omitted `to.index`
 * appends to the destination day.
 */
export function moveActivity(
  it: Itinerary,
  from: { day: number; index: number },
  to: { day: number; index?: number },
): Itinerary {
  const src = it.days.find((d) => d.day === from.day);
  const dst = it.days.find((d) => d.day === to.day);
  if (!src || !dst || !isIndex(from.index, src.activities.length - 1)) return it;
  const moved = src.activities[from.index];
  const dstLen = dst.activities.length - (src === dst ? 1 : 0);
  const at = to.index === undefined ? dstLen : to.index;
  if (!isIndex(at, dstLen)) return it;
  const days = it.days.map((d) => {
    let list = d.activities;
    if (d.day === from.day) list = list.filter((_, i) => i !== from.index);
    if (d.day === to.day) list = [...list.slice(0, at), moved, ...list.slice(at)];
    return d.day === from.day || d.day === to.day ? { ...d, activities: list } : d;
  });
  return finish(it, days);
}

/** Set the `time` text of the activity at `index` of day number `day`. */
export function setActivityTime(it: Itinerary, day: number, index: number, time: string): Itinerary {
  const target = it.days.find((d) => d.day === day);
  if (!target || !isIndex(index, target.activities.length - 1)) return it;
  const days = it.days.map((d) =>
    d.day !== day ? d : { ...d, activities: d.activities.map((x, i) => (i === index ? { ...x, time } : x)) },
  );
  return finish(it, days);
}
