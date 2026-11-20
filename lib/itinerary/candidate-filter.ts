/**
 * Pure candidate filter for the places-first itinerary (Requirements 1.7, 1.8,
 * 1.9, 2.6, 9.2). Deterministic and total: never throws, never mutates its
 * input, and keeps the input order.
 *
 * Checks, in this order (a candidate is counted under the first check it fails):
 *  1. businessStatus is not "OPERATIONAL" (a missing status fails)       -> closed
 *  2. a NON_VISIT_TYPES entry in primaryType or types, a missing placeId,
 *     or (when `categories` is given) no type in the selected categories -> excludedType
 *  3. outside the 60 km destination radius (no day-trip radius)           -> outside
 *  4. placeId or nameKey already scheduled (usedKeys, usedPlaceIds) or
 *     repeated earlier in the pool                                        -> duplicate
 */
import type { PlaceCandidate } from "@/lib/providers/google-places";
import { dedupeStops } from "./dedupe";
import { isWithinDestination, type LatLng } from "./geo";
import { NON_VISIT_TYPES } from "./place-categories";
import { nameKey } from "./place-key";

export interface FilterContext {
  destination: string;
  centre: LatLng | null;
  /** nameKey of each usedPlaces entry. */
  usedKeys: ReadonlySet<string>;
  /** placeIds already scheduled (earlier batches). Optional. */
  usedPlaceIds?: ReadonlySet<string>;
  /**
   * Places types of the selected categories (Requirement 2.6). When given and
   * non-empty, only candidates with a matching `primaryType` or `types` entry
   * are kept. When absent or empty there is no category restriction.
   */
  categories?: readonly string[];
}

export interface FilterResult {
  kept: PlaceCandidate[];
  dropped: { closed: number; outside: number; duplicate: number; excludedType: number };
}

const NON_VISIT = new Set<string>(NON_VISIT_TYPES);

function typesOf(c: PlaceCandidate): string[] {
  const out: string[] = [];
  if (typeof c.primaryType === "string" && c.primaryType) out.push(c.primaryType);
  if (Array.isArray(c.types)) {
    for (const t of c.types) if (typeof t === "string" && t) out.push(t);
  }
  return out;
}

export function filterCandidates(pool: readonly PlaceCandidate[], ctx: FilterContext): FilterResult {
  const dropped = { closed: 0, outside: 0, duplicate: 0, excludedType: 0 };
  const stage: PlaceCandidate[] = [];
  if (!Array.isArray(pool)) return { kept: [], dropped };

  const destination = ctx && typeof ctx.destination === "string" ? ctx.destination : "";
  const centre = ctx ? ctx.centre ?? null : null;
  const wanted =
    ctx && Array.isArray(ctx.categories) && ctx.categories.length > 0 ? new Set<string>(ctx.categories) : null;

  for (const c of pool) {
    if (!c || typeof c !== "object") continue;
    if (c.businessStatus !== "OPERATIONAL") {
      dropped.closed++;
      continue;
    }
    const types = typesOf(c);
    if (
      typeof c.placeId !== "string" ||
      !c.placeId ||
      types.some((t) => NON_VISIT.has(t)) ||
      (wanted && !types.some((t) => wanted.has(t)))
    ) {
      dropped.excludedType++;
      continue;
    }
    if (!isWithinDestination({ address: c.address, location: c.location }, destination, centre, false)) {
      dropped.outside++;
      continue;
    }
    stage.push(c);
  }

  // Dedupe by placeId, then by nameKey. An empty nameKey never matches another place.
  const usedIds: ReadonlySet<string> = ctx && ctx.usedPlaceIds ? ctx.usedPlaceIds : new Set<string>();
  const usedNames: ReadonlySet<string> = ctx && ctx.usedKeys ? ctx.usedKeys : new Set<string>();

  const byId = dedupeStops(
    stage.map((c) => ({ key: c.placeId, isStop: true, c })),
    usedIds,
  );
  const byName = dedupeStops(
    byId.kept.map((e) => {
      const key = nameKey(e.c.name);
      return { key, isStop: key !== "", c: e.c };
    }),
    usedNames,
  );
  dropped.duplicate = byId.dropped.length + byName.dropped.length;
  return { kept: byName.kept.map((e) => e.c), dropped };
}
