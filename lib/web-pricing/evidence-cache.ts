/**
 * Small in-memory cache of Evidence_Sets keyed by Place_Key, plus an
 * in-flight de-duplication map. Every operation is failure-tolerant: a
 * throwing read behaves as a miss and a throwing write is skipped.
 */
import type { EvidenceSet } from "@/lib/web-pricing/evidence";
import type { PlaceKey } from "@/lib/web-pricing/query-planner";

export const ENTRY_FEE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const OTHER_TTL_MS = 24 * 60 * 60 * 1000;
export const EMPTY_TTL_MS = 15 * 60 * 1000;
export const EVIDENCE_CACHE_MAX = 500;

export interface EvidenceCache {
  get(key: PlaceKey, nowMs: number): EvidenceSet | undefined;
  /** TTL: empty set 15 min, entry-fee 7 days, others 24 h. Evicts the oldest first beyond the max. */
  set(set: EvidenceSet, nowMs: number): void;
  /** Shares one in-flight producer per key. */
  dedupe<T>(key: PlaceKey, producer: () => Promise<T>): Promise<T>;
  readonly size: number;
}

interface Entry {
  set: EvidenceSet;
  expiresAt: number;
}

function ttlFor(set: EvidenceSet): number {
  if (set.snippets.length === 0) return EMPTY_TTL_MS;
  return set.kind === "entry-fee" ? ENTRY_FEE_TTL_MS : OTHER_TTL_MS;
}

export function createEvidenceCache(max: number = EVIDENCE_CACHE_MAX): EvidenceCache {
  const limit = Number.isFinite(max) && max >= 1 ? Math.floor(max) : EVIDENCE_CACHE_MAX;
  const store = new Map<PlaceKey, Entry>();
  const inflight = new Map<PlaceKey, Promise<unknown>>();

  return {
    get(key, nowMs) {
      try {
        const e = store.get(key);
        if (!e) return undefined;
        if (!(nowMs < e.expiresAt)) {
          store.delete(key);
          return undefined;
        }
        return e.set;
      } catch {
        return undefined;
      }
    },
    set(set, nowMs) {
      try {
        if (!set || typeof set.key !== "string" || !Number.isFinite(nowMs)) return;
        // Re-set moves the key to the newest position.
        store.delete(set.key);
        store.set(set.key, { set, expiresAt: nowMs + ttlFor(set) });
        while (store.size > limit) {
          const oldest = store.keys().next();
          if (oldest.done) break;
          store.delete(oldest.value);
        }
      } catch {
        /* skipped write */
      }
    },
    dedupe<T>(key: PlaceKey, producer: () => Promise<T>): Promise<T> {
      const existing = inflight.get(key);
      if (existing) return existing as Promise<T>;
      let p: Promise<T>;
      try {
        p = Promise.resolve(producer());
      } catch (err) {
        return Promise.reject(err);
      }
      const tracked = p.finally(() => {
        if (inflight.get(key) === tracked) inflight.delete(key);
      });
      inflight.set(key, tracked);
      return tracked;
    },
    get size() {
      return store.size;
    },
  };
}
