/**
 * Pure, client-safe de-duplication of itinerary stops.
 * Before lookup the key is `nameKey(place)`; after lookup it is the `placeId`.
 */

export interface KeyedStop {
  key: string;
  isStop: boolean;
}

/**
 * Keeps the first occurrence of each key in input order and drops any key
 * present in `used`. Entries with `isStop: false` (stay and transport rows)
 * are always kept and never register a key. Never throws: a non-array input
 * yields an empty result and an unusable `used` is treated as empty.
 * Idempotent: dedupeStops(dedupeStops(x, u).kept, u).kept equals
 * dedupeStops(x, u).kept.
 */
export function dedupeStops<T extends KeyedStop>(
  stops: readonly T[],
  used: ReadonlySet<string>,
): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  if (!Array.isArray(stops)) return { kept, dropped };

  let isUsed: (key: string) => boolean = () => false;
  if (used && typeof (used as ReadonlySet<string>).has === "function") {
    isUsed = (key) => {
      try {
        return used.has(key);
      } catch {
        return false;
      }
    };
  }

  const seen = new Set<string>();
  for (const stop of stops) {
    if (!stop || typeof stop !== "object") continue;
    if (stop.isStop === false) {
      kept.push(stop);
      continue;
    }
    const key = stop.key;
    if (isUsed(key) || seen.has(key)) {
      dropped.push(stop);
      continue;
    }
    seen.add(key);
    kept.push(stop);
  }
  return { kept, dropped };
}
