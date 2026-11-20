// SERVER-ONLY. Do not import from a "use client" module: this file pulls in the
// Google Places adapter, which reads the API key from the environment.
//
// Bounded in-memory caches for the itinerary Verifier:
//  - verificationCache: successful Text Search lookups (an empty list is a
//    successful lookup). Failed lookups are never stored, so an outage stays
//    retryable.
//  - destinationCentre: one resolveLocation call per destination, memoised.
//    A null result (failure or unknown place) is never memoised.
// Reads and writes never throw.

import { CENTRE_CACHE_TTL_MS, VERIFY_CACHE_MAX, VERIFY_CACHE_TTL_MS } from "./constants";
import {
  resolveLocation,
  type LatLng,
  type PostFetchLike,
  type VerificationCandidate,
} from "../providers/google-places";

export interface VerificationCache {
  get(query: string, nowMs: number): VerificationCandidate[] | undefined;
  /** Only successful lookups, including an empty list, are stored. */
  set(query: string, candidates: VerificationCandidate[], nowMs: number): void;
}

interface Entry {
  value: VerificationCandidate[];
  storedAt: number;
}

function normaliseKey(query: unknown): string {
  return typeof query === "string" ? query.trim().toLowerCase() : "";
}

export function createVerificationCache(
  max: number = VERIFY_CACHE_MAX,
  ttlMs: number = VERIFY_CACHE_TTL_MS,
): VerificationCache {
  const limit = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 1;
  const map = new Map<string, Entry>();

  return {
    get(query, nowMs) {
      try {
        const key = normaliseKey(query);
        if (key === "") return undefined;
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
    set(query, candidates, nowMs) {
      try {
        const key = normaliseKey(query);
        if (key === "" || !Array.isArray(candidates)) return;
        // Re-insert so a refreshed key becomes the newest.
        map.delete(key);
        map.set(key, { value: candidates.slice(), storedAt: nowMs });
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

export const verificationCache: VerificationCache = createVerificationCache();

// ---------------------------------------------------------------------------
// Destination centre
// ---------------------------------------------------------------------------

const CENTRE_MAX = 200;
const centres = new Map<string, { value: LatLng; storedAt: number }>();
const inFlight = new Map<string, Promise<LatLng | null>>();

export async function destinationCentre(
  destination: string,
  nowMs: number,
  fetchImpl?: PostFetchLike,
): Promise<LatLng | null> {
  try {
    const key = normaliseKey(destination);
    if (key === "") return null;

    const hit = centres.get(key);
    if (hit) {
      if (nowMs - hit.storedAt < CENTRE_CACHE_TTL_MS) return { ...hit.value };
      centres.delete(key);
    }

    let pending = inFlight.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          const found = fetchImpl
            ? await resolveLocation(destination, fetchImpl)
            : await resolveLocation(destination);
          if (
            found &&
            Number.isFinite(found.lat) &&
            Number.isFinite(found.lng)
          ) {
            centres.delete(key);
            centres.set(key, { value: { lat: found.lat, lng: found.lng }, storedAt: nowMs });
            while (centres.size > CENTRE_MAX) {
              const oldest = centres.keys().next();
              if (oldest.done) break;
              centres.delete(oldest.value);
            }
            return { lat: found.lat, lng: found.lng };
          }
          return null; // not memoised: a failure stays retryable
        } catch {
          return null;
        } finally {
          inFlight.delete(key);
        }
      })();
      inFlight.set(key, pending);
    }
    const result = await pending;
    return result ? { ...result } : null;
  } catch {
    return null;
  }
}
