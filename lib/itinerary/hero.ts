/**
 * Day hero selection (pure, client-safe, total: never throws).
 *
 * For each day in order, picks the first activity with a valid Places
 * `photoRef` that no earlier day has used. A day with none has no entry, so the
 * UI shows its illustration and never another day's photo.
 */

import type { TripDay } from "../types";
import { isValidPhotoRef } from "./maps-link";

export function pickDayHeroes(
  days: readonly TripDay[],
): Map<number, { photoRef: string; name: string }> {
  const heroes = new Map<number, { photoRef: string; name: string }>();
  if (!Array.isArray(days)) return heroes;

  const used = new Set<string>();
  for (const day of days) {
    if (!day || typeof day !== "object") continue;
    const dayNumber = day.day;
    if (typeof dayNumber !== "number" || !Number.isFinite(dayNumber)) continue;
    if (heroes.has(dayNumber)) continue;
    const activities = day.activities;
    if (!Array.isArray(activities)) continue;

    for (const activity of activities) {
      if (!activity || typeof activity !== "object") continue;
      const ref: unknown = activity.photoRef;
      if (!isValidPhotoRef(ref) || used.has(ref)) continue;
      const placeName: unknown = activity.placeName;
      const title: unknown = activity.title;
      const name =
        typeof placeName === "string" && placeName.trim()
          ? placeName.trim()
          : typeof title === "string"
            ? title.trim()
            : "";
      used.add(ref);
      heroes.set(dayNumber, { photoRef: ref, name });
      break;
    }
  }
  return heroes;
}
