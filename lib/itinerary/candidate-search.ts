// SERVER-ONLY. Do not import from a "use client" module: this file pulls in the
// Google Places adapter, which reads the API key from the environment.
//
// Budgeted, cached candidate search (Requirements 5.1 to 5.6, 5.8 to 5.10, 9.3, 9.4).
//  - Order inside searchText / searchNearby: cache hit (no budget use), then
//    budget.tryReserve(), then the request, then cache the result on success only.
//  - An empty list is a success and is cached. Failures are never cached.
//  - A rate-limited answer stops the batch: no further request is reserved.
//  - Identical concurrent keys on one budget share one request (in-flight map).
// Nothing here throws. The destination centre is not counted (use destinationCentre).

import {
  searchCandidatesNearby,
  searchCandidatesText,
  type LatLng,
  type PlaceCandidate,
  type PostFetchLike,
} from "../providers/google-places";
import { VERIFY_CACHE_MAX, VERIFY_CACHE_TTL_MS } from "./constants";

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface PlacesBudget {
  /** Uncached requests actually reserved and sent. */
  readonly sent: number;
  readonly cacheHits: number;
  readonly rateLimited: boolean;
  /** true and increments `sent` only when sent < max, not rate limited, and now() < deadline. */
  tryReserve(): boolean;
  /** Bookkeeping used by the search functions. */
  noteCacheHit(): void;
  markRateLimited(): void;
}

export function createPlacesBudget(o: {
  maxRequests: number;
  deadlineMs: number;
  now: () => number;
}): PlacesBudget {
  const max = Number.isFinite(o.maxRequests) ? Math.max(0, Math.floor(o.maxRequests)) : 0;
  let sent = 0;
  let cacheHits = 0;
  let rateLimited = false;
  return {
    get sent() {
      return sent;
    },
    get cacheHits() {
      return cacheHits;
    },
    get rateLimited() {
      return rateLimited;
    },
    tryReserve() {
      let t: number;
      try {
        t = o.now();
      } catch {
        return false;
      }
      if (rateLimited || sent >= max || !Number.isFinite(t) || t >= o.deadlineMs) return false;
      sent += 1;
      return true;
    },
    noteCacheHit() {
      cacheHits += 1;
    },
    markRateLimited() {
      rateLimited = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export interface CandidateCache {
  get(key: string, nowMs: number): PlaceCandidate[] | undefined;
  /** Only successful lookups, including an empty list, are stored. */
  set(key: string, v: PlaceCandidate[], nowMs: number): void;
}

interface Entry {
  value: PlaceCandidate[];
  storedAt: number;
}

export function createCandidateCache(
  max: number = VERIFY_CACHE_MAX,
  ttlMs: number = VERIFY_CACHE_TTL_MS,
): CandidateCache {
  const limit = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 1;
  const map = new Map<string, Entry>();
  return {
    get(key, nowMs) {
      try {
        if (typeof key !== "string" || key === "") return undefined;
        const entry = map.get(key);
        if (!entry) return undefined;
        if (nowMs - entry.storedAt >= ttlMs) {
          map.delete(key);
          return undefined;
        }
        return entry.value.slice();
      } catch {
        return undefined;
      }
    },
    set(key, v, nowMs) {
      try {
        if (typeof key !== "string" || key === "" || !Array.isArray(v)) return;
        map.delete(key); // a refreshed key becomes the newest
        map.set(key, { value: v.slice(), storedAt: nowMs });
        while (map.size > limit) {
          const oldest = map.keys().next();
          if (oldest.done) break;
          map.delete(oldest.value);
        }
      } catch {
        // never throws
      }
    },
  };
}

/** Process-wide cache shared by all batches. */
export const candidateCache: CandidateCache = createCandidateCache();

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export function textCacheKey(query: string): string {
  return typeof query === "string" ? query.trim().toLowerCase() : "";
}

export function nearbyCacheKey(c: LatLng, radiusM: number, types: readonly string[]): string {
  const radius = Number.isFinite(radiusM) ? Math.round(Math.min(Math.max(radiusM, 1), 50_000)) : 0;
  const sorted = (Array.isArray(types) ? types : [])
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .slice()
    .sort();
  return `nearby|${Number(c?.lat).toFixed(3)},${Number(c?.lng).toFixed(3)}|${radius}|${sorted.join(",")}`;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface CandidateSearchDeps {
  fetchImpl?: PostFetchLike;
  cache?: CandidateCache;
  now?: () => number;
  budget: PlacesBudget;
}

// One in-flight map per budget, so sharing is limited to one batch.
const inFlightByBudget = new WeakMap<PlacesBudget, Map<string, Promise<PlaceCandidate[] | null>>>();

function inFlightFor(budget: PlacesBudget): Map<string, Promise<PlaceCandidate[] | null>> {
  let m = inFlightByBudget.get(budget);
  if (!m) {
    m = new Map();
    inFlightByBudget.set(budget, m);
  }
  return m;
}

async function cachedSearch(
  key: string,
  d: CandidateSearchDeps,
  send: () => ReturnType<typeof searchCandidatesText>,
): Promise<PlaceCandidate[] | null> {
  try {
    if (key === "" || !d?.budget) return null;
    const cache = d.cache ?? candidateCache;
    const now = d.now ?? Date.now;

    const hit = cache.get(key, now());
    if (hit) {
      d.budget.noteCacheHit();
      return hit;
    }

    const flights = inFlightFor(d.budget);
    const pending = flights.get(key);
    if (pending) {
      const shared = await pending;
      return shared ? shared.slice() : null;
    }

    if (!d.budget.tryReserve()) return null;

    const run = (async (): Promise<PlaceCandidate[] | null> => {
      try {
        const result = await send();
        if (result.kind === "ok") {
          cache.set(key, result.candidates, now());
          return result.candidates;
        }
        if (result.cause === "rate-limited") d.budget.markRateLimited();
        return null;
      } catch {
        return null;
      } finally {
        flights.delete(key);
      }
    })();
    flights.set(key, run);
    const out = await run;
    return out ? out.slice() : null;
  } catch {
    return null;
  }
}

/** null = failed or refused by the budget (not cached). [] = a real empty answer. */
export function searchText(query: string, d: CandidateSearchDeps): Promise<PlaceCandidate[] | null> {
  const key = textCacheKey(query);
  return cachedSearch(key, d, () => searchCandidatesText(query, d.fetchImpl));
}

export function searchNearby(
  c: LatLng,
  radiusM: number,
  types: readonly string[],
  d: CandidateSearchDeps,
): Promise<PlaceCandidate[] | null> {
  const key = nearbyCacheKey(c, radiusM, types);
  return cachedSearch(key, d, () => searchCandidatesNearby(c, radiusM, types, d.fetchImpl));
}
