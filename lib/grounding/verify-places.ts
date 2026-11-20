/**
 * Places verification for grounded itineraries (Req 6.7, 8.1 to 8.6).
 *
 * For each activity that names a place, the place is looked up in Google
 * Places ("{place}, {destination}"). Outcomes:
 *   - resolved                      -> activity kept unchanged
 *   - unresolved, found in snippets -> kept with `mapVerified: false`
 *   - unresolved, absent            -> removed; day.total and totalCost recomputed
 *
 * Safety guards (design risks 3 and 4, not in the requirements):
 *   - Lookup cap: at most MAX_LOOKUPS (40) distinct Places queries per call.
 *     Activities beyond the cap are kept unchanged and are not "verifiable".
 *   - Removal guard: if more than half of the verifiable activities would be
 *     removed, the original itinerary is returned (`applied: false`).
 *
 * Any missing key, tracked fetch failure (throw, !ok, json() failure) or the
 * overall 10 s deadline returns the ORIGINAL itinerary with `applied: false`.
 * Never throws, never mutates its input, never re-requests, never adds
 * replacements. Server-only: no react, next or @aws-sdk imports.
 */

import { googlePlacesApiKey } from "@/lib/config";
import { enrichmentCache, type EnrichmentCache } from "@/lib/providers/enrichment-cache";
import { resolvePlaceId } from "@/lib/providers/google-places";
import { extractPlaceName, placeMatches } from "@/lib/grounding/place-match";
import type { GroundingBundle } from "@/lib/grounding/types";
import type { Activity, Itinerary, TripDay } from "@/lib/types";

export const VERIFY_DEADLINE_MS = 10_000;
export const VERIFY_CONCURRENCY = 6;
export const MAX_LOOKUPS = 40;

type PostFetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface VerifyDeps {
  fetchImpl?: PostFetchLike;
  hasKey?: () => boolean;
  deadlineMs?: number;
  concurrency?: number;
  placeIdCache?: Pick<EnrichmentCache, "getPlaceId" | "setPlaceId">;
  /** Destination used in the query; may also be passed as the second argument. */
  destination?: string;
}

export interface VerifyResult {
  itinerary: Itinerary;
  /** False when verification was skipped, failed, timed out or was guarded. */
  applied: boolean;
  removed: number;
  notMapVerified: number;
}

type Slot = { d: number; a: number; place: string; query: string };

function unchanged(itinerary: Itinerary): VerifyResult {
  return { itinerary, applied: false, removed: 0, notMapVerified: 0 };
}

function sumCosts(acts: readonly Activity[]): number {
  let s = 0;
  for (const a of acts) s += Number.isFinite(a.cost) ? a.cost : 0;
  return s;
}

/**
 * Call forms: (itinerary, bundle, deps?) or the design form
 * (itinerary, destination, bundle, deps?).
 */
export async function verifyItineraryPlaces(
  itinerary: Itinerary,
  bundleOrDestination: GroundingBundle | string,
  bundleOrDeps?: GroundingBundle | VerifyDeps,
  maybeDeps?: VerifyDeps,
): Promise<VerifyResult> {
  try {
    let bundle: GroundingBundle;
    let deps: VerifyDeps;
    let destination: string;
    if (typeof bundleOrDestination === "string") {
      destination = bundleOrDestination;
      bundle = (bundleOrDeps ?? { status: "empty", snippets: [], droppedCount: 0 }) as GroundingBundle;
      deps = maybeDeps ?? {};
    } else {
      bundle = bundleOrDestination;
      deps = (bundleOrDeps as VerifyDeps | undefined) ?? {};
      destination = deps.destination ?? "";
    }
    return await run(itinerary, destination.trim(), bundle, deps);
  } catch {
    return unchanged(itinerary);
  }
}

async function run(
  itinerary: Itinerary,
  destination: string,
  bundle: GroundingBundle,
  deps: VerifyDeps,
): Promise<VerifyResult> {
  const hasKey = deps.hasKey ?? (() => googlePlacesApiKey().length > 0);
  if (!hasKey()) return unchanged(itinerary);

  const cache = deps.placeIdCache ?? enrichmentCache;
  const baseFetch: PostFetchLike | undefined =
    deps.fetchImpl ??
    (typeof (globalThis as { fetch?: unknown }).fetch === "function"
      ? ((globalThis as { fetch: unknown }).fetch as PostFetchLike)
      : undefined);
  if (!baseFetch) return unchanged(itinerary);

  // Collect verifiable activities; cap distinct queries.
  const slots: Slot[] = [];
  const queries: string[] = [];
  const querySet = new Set<string>();
  for (let d = 0; d < itinerary.days.length; d++) {
    const acts = itinerary.days[d].activities ?? [];
    for (let a = 0; a < acts.length; a++) {
      const place = extractPlaceName(acts[a].title);
      if (!place) continue;
      const query = destination ? `${place}, ${destination}` : place;
      if (!querySet.has(query)) {
        if (querySet.size >= MAX_LOOKUPS) continue; // beyond cap: kept unchanged
        querySet.add(query);
        queries.push(query);
      }
      slots.push({ d, a, place, query });
    }
  }
  if (slots.length === 0) return unchanged(itinerary);

  let failed = false;
  let stopped = false;
  const trackingFetch: PostFetchLike = async (url, init) => {
    try {
      const res = await baseFetch(url, init);
      if (!res.ok) {
        failed = true;
        return res;
      }
      return {
        ok: res.ok,
        status: res.status,
        json: async () => {
          try {
            return await res.json();
          } catch (err) {
            failed = true;
            throw err;
          }
        },
      };
    } catch (err) {
      failed = true;
      throw err;
    }
  };

  const resolved = new Map<string, boolean>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!stopped && !failed) {
      const i = next++;
      if (i >= queries.length) return;
      const q = queries[i];
      let id: string | null = null;
      try {
        id = cache.getPlaceId(q);
      } catch {
        id = null;
      }
      if (!id) {
        id = await resolvePlaceId(q, trackingFetch);
        if (id) {
          try {
            cache.setPlaceId(q, id);
          } catch {
            /* ignore cache write failure */
          }
        }
      }
      if (stopped) return;
      resolved.set(q, !!id);
    }
  };

  const conc = Math.max(1, Math.min(deps.concurrency ?? VERIFY_CONCURRENCY, queries.length));
  const workers = Promise.all(Array.from({ length: conc }, () => worker())).then(() => true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), deps.deadlineMs ?? VERIFY_DEADLINE_MS);
  });
  let finished: boolean;
  try {
    finished = await Promise.race([workers, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    stopped = true;
  }
  if (!finished || failed || resolved.size < queries.length) return unchanged(itinerary);

  // Decide per activity.
  const texts: string[] = [];
  for (const s of bundle?.snippets ?? []) texts.push(s.title, s.snippet);
  const remove = new Set<string>();
  const flag = new Set<string>();
  for (const s of slots) {
    if (resolved.get(s.query)) continue;
    if (placeMatches(s.place, texts)) flag.add(`${s.d}:${s.a}`);
    else remove.add(`${s.d}:${s.a}`);
  }

  if (remove.size * 2 > slots.length) return unchanged(itinerary); // >50% guard
  if (remove.size === 0 && flag.size === 0) return { itinerary, applied: true, removed: 0, notMapVerified: 0 };

  let totalCost = itinerary.totalCost;
  const days: TripDay[] = itinerary.days.map((day, d) => {
    const acts = day.activities ?? [];
    const kept: Activity[] = [];
    acts.forEach((act, a) => {
      const k = `${d}:${a}`;
      if (remove.has(k)) return;
      kept.push(flag.has(k) ? { ...act, mapVerified: false } : act);
    });
    if (kept.length === acts.length) {
      return flag.size ? { ...day, activities: kept } : day;
    }
    const total = sumCosts(kept);
    totalCost -= (Number.isFinite(day.total) ? day.total : sumCosts(acts)) - total;
    return { ...day, activities: kept, total };
  });

  return {
    itinerary: { ...itinerary, days, totalCost: Math.max(0, totalCost) },
    applied: true,
    removed: remove.size,
    notMapVerified: flag.size,
  };
}
