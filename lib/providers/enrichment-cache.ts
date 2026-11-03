/**
 * Enrichment_Cache (server-only) - google-places-integration design section
 * "Components and Interfaces §6 (Enrichment_Cache)" + Data Models (CachedEntry).
 *
 * SERVER-ONLY: this module backs the Google Places adapter's cost-control and
 * Terms-of-Service caching boundary. It must never be imported into
 * client/browser code.
 *
 * A bounded, in-process `Map`-backed cache for the NON-REVIEW Place Details
 * fields and resolved `place_id`s. It stores only `rating`, `userRatingCount`,
 * `priceLevel`, and photo references for a retention window hard-capped at 30
 * days, and NEVER stores Google review content - no author, text, per-review
 * rating, or review timestamp (Req 8.1). Entries are served with lazy expiry:
 * an entry is a hit only while its age is within the TTL, and an expired entry
 * is treated as a miss and removed (Req 8.3, 8.5).
 *
 * The clock is injectable (`now`) so the retention property test (task 4.3) can
 * advance time deterministically. The `Map` is in-process and sufficient for
 * the Amplify SSR compute per-instance warm cache; an edge/KV store can replace
 * it behind the same `getPlaceId/setPlaceId/getDetails/setDetails/evict` calls
 * with no caller change.
 */

import type { PhotoRef } from "@/lib/providers/google-places";

/**
 * A cached, NON-REVIEW enrichment record for ONE place (Data Models:
 * CachedEntry). This shape intentionally contains NO review fields - no author,
 * text, per-review rating, or review timestamp - because review content is
 * never cached or persisted anywhere (Req 8.1).
 */
export interface CachedEntry {
  placeId: string;
  rating: number | null;
  userRatingCount: number | null;
  priceLevel: number | null;
  /** Photo references only; images are still proxied on demand, never cached. */
  photos: PhotoRef[];
  /** Epoch ms at which this entry was stored, for lazy TTL expiry. */
  storedAt: number;
}

/**
 * Hard cap on the retention window: 30 days in milliseconds (Req 8.3). The
 * effective TTL is always clamped to be no greater than this, regardless of any
 * configured override.
 */
export const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Default retention window when no override is configured: 7 days. This is
 * deliberately shorter than the 30-day hard cap to keep cached fields fresh
 * while staying well within the Terms-of-Service ceiling (Req 8.3).
 */
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The non-secret env var that may override the TTL, expressed in whole days. */
const TTL_DAYS_ENV = "TRIPGENIE_GOOGLE_CACHE_TTL_DAYS";

/**
 * Resolve the effective TTL in milliseconds from an optional non-secret env var
 * (`TRIPGENIE_GOOGLE_CACHE_TTL_DAYS`), clamped to `(0, MAX_TTL_MS]`.
 *
 * - Unset, empty, non-numeric, or non-positive -> `DEFAULT_TTL_MS` (7 days).
 * - A valid positive value is converted from days to ms and clamped so the
 *   effective TTL can NEVER exceed the 30-day hard cap (Req 8.3).
 */
function resolveConfiguredTtlMs(): number {
  const raw = (process.env[TTL_DAYS_ENV] ?? "").trim();
  if (raw.length === 0) return DEFAULT_TTL_MS;
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) return DEFAULT_TTL_MS;
  return Math.min(days * 24 * 60 * 60 * 1000, MAX_TTL_MS);
}

/** Clamp any requested TTL into `(0, MAX_TTL_MS]`, defaulting when invalid. */
function clampTtlMs(ttlMs?: number): number {
  const requested = typeof ttlMs === "number" && ttlMs > 0 ? ttlMs : resolveConfiguredTtlMs();
  return Math.min(requested, MAX_TTL_MS);
}

/** Normalize a query into the `places:` resolution key (lowercased, trimmed). */
function placeKey(query: string): string {
  return `places:${query.trim().toLowerCase()}`;
}

/** The `details:` key for a resolved place id. */
function detailsKey(placeId: string): string {
  return `details:${placeId}`;
}

/** The public cache API surface, returned by `createEnrichmentCache`. */
export interface EnrichmentCache {
  /** The effective, clamped retention window in ms (`<= MAX_TTL_MS`). */
  readonly ttlMs: number;
  /** Resolve a free-text query to a cached place id, or null on miss/expiry. */
  getPlaceId(query: string): string | null;
  /** Cache a `query -> place_id` resolution. */
  setPlaceId(query: string, placeId: string): void;
  /** Read a cached non-review `CachedEntry` by place id, or null on miss/expiry. */
  getDetails(placeId: string): CachedEntry | null;
  /** Cache a non-review `CachedEntry` (reviews are never written here, Req 8.1). */
  setDetails(entry: CachedEntry): void;
  /** Remove a cache entry by its full key (`places:...` or `details:...`). */
  evict(key: string): void;
  /** Remove every entry (primarily for test isolation). */
  clear(): void;
}

interface TimestampedPlaceId {
  placeId: string;
  storedAt: number;
}

/** Options for {@link createEnrichmentCache}. */
export interface EnrichmentCacheOptions {
  /** Injectable clock for testability; defaults to `Date.now`. */
  now?: () => number;
  /**
   * Explicit TTL override in ms. Clamped to `(0, MAX_TTL_MS]`. When omitted the
   * TTL is resolved from the `TRIPGENIE_GOOGLE_CACHE_TTL_DAYS` env var, falling
   * back to `DEFAULT_TTL_MS`.
   */
  ttlMs?: number;
}

/**
 * Build an isolated Enrichment_Cache instance with an injectable clock and TTL.
 *
 * The clock (`now`) is injectable so the retention property test can advance
 * time without real delays; it defaults to `Date.now`. The effective TTL is
 * clamped to `(0, MAX_TTL_MS]` at construction, so a configured override can
 * never breach the 30-day hard cap (Req 8.3).
 *
 * Both sub-caches apply lazy expiry on read: an entry is returned only while
 * `(now() - storedAt) <= ttlMs`; an expired entry is removed and reported as a
 * miss so a fresh Google fetch repopulates it (Req 8.5).
 */
export function createEnrichmentCache(options: EnrichmentCacheOptions = {}): EnrichmentCache {
  const now = options.now ?? Date.now;
  const ttlMs = clampTtlMs(options.ttlMs);

  const placeIds = new Map<string, TimestampedPlaceId>();
  const details = new Map<string, CachedEntry>();

  /** True when an entry stored at `storedAt` is still within the TTL window. */
  function isFresh(storedAt: number): boolean {
    return now() - storedAt <= ttlMs;
  }

  return {
    ttlMs,

    getPlaceId(query: string): string | null {
      const key = placeKey(query);
      const hit = placeIds.get(key);
      if (hit === undefined) return null;
      if (!isFresh(hit.storedAt)) {
        placeIds.delete(key); // expired -> miss + remove (Req 8.5)
        return null;
      }
      return hit.placeId;
    },

    setPlaceId(query: string, placeId: string): void {
      placeIds.set(placeKey(query), { placeId, storedAt: now() });
    },

    getDetails(placeId: string): CachedEntry | null {
      const key = detailsKey(placeId);
      const hit = details.get(key);
      if (hit === undefined) return null;
      if (!isFresh(hit.storedAt)) {
        details.delete(key); // expired -> miss + remove (Req 8.5)
        return null;
      }
      return hit;
    },

    setDetails(entry: CachedEntry): void {
      // Store ONLY the non-review fields; this shape carries no review content
      // by construction (CachedEntry has no review fields, Req 8.1).
      details.set(detailsKey(entry.placeId), {
        placeId: entry.placeId,
        rating: entry.rating,
        userRatingCount: entry.userRatingCount,
        priceLevel: entry.priceLevel,
        photos: entry.photos,
        storedAt: entry.storedAt,
      });
    },

    evict(key: string): void {
      placeIds.delete(key);
      details.delete(key);
    },

    clear(): void {
      placeIds.clear();
      details.clear();
    },
  };
}

/**
 * Default shared singleton cache the Google Places adapter uses in task 4.2.
 * Uses the real clock and the env-configured (clamped) TTL. Tests that need to
 * control time should build their own instance via `createEnrichmentCache`.
 */
export const enrichmentCache: EnrichmentCache = createEnrichmentCache();
