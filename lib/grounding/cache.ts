/**
 * Grounding cache: per-destination Grounding_Bundle cache built on its own
 * provider-store instance (same LRU / dedupe rules, separate from the shared
 * SerpApi store so tryConsume is never reached).
 *
 * Pure module: no fetch, no env, no React. Clock is passed in.
 *
 * Requirements: 10.1, 10.3-10.9, 14.1.
 */
import { cacheKey, normalizeDestination } from "@/lib/providers/serpapi-core";
import {
  TTL_MS,
  createProviderStore,
  type ProviderStore,
  type Stored,
} from "@/lib/providers/provider-store";
import { cleanText } from "@/lib/grounding/queries";
import type { GroundingBundle } from "@/lib/grounding/types";

export const OK_TTL_MS = 86_400_000; // ok and partial: 24 h
export const EMPTY_TTL_MS = 900_000; // empty: 15 min

interface CachedBundle extends Stored {
  bundle: GroundingBundle;
}

/** Key from normalized destination and vibe only (no budget, dates or length). */
export function groundingCacheKey(destination: string, vibe: string): string {
  return cacheKey("grounding", {
    destination: normalizeDestination(cleanText(destination)),
    vibe: normalizeDestination(cleanText(vibe)),
  });
}

export interface GroundingCache {
  get(key: string, nowMs: number): GroundingBundle | null;
  set(key: string, bundle: GroundingBundle, nowMs: number): void;
  dedupe<T>(key: string, producer: () => Promise<T>): Promise<T>;
}

export function createGroundingCache(store?: ProviderStore): GroundingCache {
  const s = store ?? createProviderStore(100);
  return {
    get(key, nowMs) {
      try {
        const hit = s.get<CachedBundle>(key, nowMs);
        return hit ? hit.bundle : null;
      } catch {
        return null; // Req 10.9: behave as a miss
      }
    },

    set(key, bundle, nowMs) {
      try {
        let ttl: number;
        if (bundle.status === "ok" || bundle.status === "partial") ttl = OK_TTL_MS;
        else if (bundle.status === "empty") ttl = EMPTY_TTL_MS;
        else return; // unavailable and disabled are never stored
        // The store expires at completedAt + TTL_MS[kind]; shift completedAt so expiry = nowMs + ttl.
        const kind = ttl === OK_TTL_MS ? "search" : "detail";
        s.set<CachedBundle>(
          key,
          { status: "live", checkedAt: new Date(nowMs).toISOString(), bundle },
          kind,
          nowMs + ttl - TTL_MS[kind],
        );
      } catch {
        // Req 10.9: skipped write
      }
    },

    dedupe(key, producer) {
      return s.dedupe(key, producer);
    },
  };
}
