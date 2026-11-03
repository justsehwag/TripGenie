/**
 * Provider store: the in-memory LRU cache, in-flight de-duplication registry
 * and monthly usage guard shared by the SerpApi hotel and flight adapters.
 *
 * Pure module: no fetch, no process.env, no React. The clock is passed in on
 * every call so behaviour is deterministic under test.
 *
 * Requirements: 7.1-7.8, 8.1, 8.2, 8.3, 8.6, 8.7.
 */
import { istMonthKey } from "@/lib/ist-time";

/**
 * Same union as `LiveStatus` in serpapi-hotels.ts. Defined locally so this
 * pure module does not import a server-only adapter.
 */
export type LiveStatus = "live" | "unconfigured" | "invalid" | "unavailable";

/** search = full search Result_Set (45 min); detail = offers, returns, booking options (15 min). */
export type CacheKind = "search" | "detail";

export const TTL_MS: Record<CacheKind, number> = {
  search: 45 * 60_000, // Req 7.1
  detail: 15 * 60_000, // Req 7.2
};

/** Maximum number of cached results (Req 7.3). */
export const MAX_ENTRIES = 200;

/** Soft limit used when SERPAPI_MONTHLY_SOFT_LIMIT is unset or invalid (Req 8.3). */
export const DEFAULT_SOFT_LIMIT = 225;

/** The minimum shape of anything the store will cache. */
export interface Stored {
  status: LiveStatus;
  checkedAt: string;
}

export interface ProviderStore {
  /** LRU read; touches recency; drops and misses when nowMs > completedAt + ttl. */
  get<T extends Stored>(key: string, nowMs: number): T | null;
  /** Stores only status === "live"; evicts LRU at capacity; expiry from completedAtMs. */
  set<T extends Stored>(key: string, value: T, kind: CacheKind, completedAtMs: number): void;
  /** Returns the pending promise for key, or starts producer() and registers it until settled. */
  dedupe<T>(key: string, producer: () => Promise<T>): Promise<T>;
  /** True and count += 1 when under the soft limit for istMonthKey(now); false when paused. Resets on month change. */
  tryConsume(now: Date, limit: number): boolean;
  /** Test hook: clears entries, in-flight registry and counter (Req 7.8). */
  clear(): void;
  /** Introspection for tests only (sizes, not values). */
  stats(): { entries: number; inFlight: number; month: string | null; count: number };
}

interface Entry {
  value: Stored;
  expiresAtMs: number;
}

/** Create an independent store. `capacity` defaults to MAX_ENTRIES. */
export function createProviderStore(capacity: number = MAX_ENTRIES): ProviderStore {
  const cap =
    Number.isFinite(capacity) && capacity >= 1 ? Math.floor(capacity) : MAX_ENTRIES;

  // Map iteration follows insertion order, so the first key is the least recently used.
  const entries = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<unknown>>();
  let month: string | null = null;
  let count = 0;

  return {
    get<T extends Stored>(key: string, nowMs: number): T | null {
      const entry = entries.get(key);
      if (!entry) return null;
      if (nowMs > entry.expiresAtMs) {
        entries.delete(key);
        return null;
      }
      // Touch recency: move to the most recently used end.
      entries.delete(key);
      entries.set(key, entry);
      // Return the identical stored object so the original checkedAt is kept (Req 7.7).
      return entry.value as T;
    },

    set<T extends Stored>(key: string, value: T, kind: CacheKind, completedAtMs: number): void {
      if (value.status !== "live") return; // Req 7.6
      if (entries.has(key)) {
        entries.delete(key);
      } else if (entries.size >= cap) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
      entries.set(key, { value, expiresAtMs: completedAtMs + TTL_MS[kind] });
    },

    dedupe<T>(key: string, producer: () => Promise<T>): Promise<T> {
      const pending = inFlight.get(key);
      if (pending) return pending as Promise<T>;

      let started: Promise<T>;
      try {
        started = Promise.resolve(producer());
      } catch (err) {
        started = Promise.reject(err);
      }
      const shared = started.finally(() => {
        // Only remove our own registration (clear() may have replaced it).
        if (inFlight.get(key) === shared) inFlight.delete(key);
      });
      inFlight.set(key, shared);
      return shared;
    },

    tryConsume(now: Date, limit: number): boolean {
      const key = istMonthKey(now);
      if (key !== month) {
        month = key; // Req 8.6: new IST month counts from zero.
        count = 0;
      }
      if (count >= limit) return false;
      count += 1;
      return true;
    },

    clear(): void {
      entries.clear();
      inFlight.clear();
      month = null;
      count = 0;
    },

    stats() {
      return { entries: entries.size, inFlight: inFlight.size, month, count };
    },
  };
}

/** Positive integer from the env string, else DEFAULT_SOFT_LIMIT (Req 8.2, 8.3). */
export function parseSoftLimit(raw: string | undefined): number {
  if (typeof raw !== "string") return DEFAULT_SOFT_LIMIT;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_SOFT_LIMIT;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_SOFT_LIMIT;
}
