import { createHash } from "node:crypto";

/** Minimal structural types (kept local so this module compiles standalone). */
export interface PricerActivity {
  id: string;
  title: string;
  time: string;
  kind: string;
}

export interface PriceResult {
  id: string;
  inr: number;
  basis: string;
  source: "ai" | "estimated" | "web";
  unit?: "person" | "group";
  sourceUrl?: string;
  sourceHost?: string;
  checkedAt?: string;
}

export const PRICE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const PRICE_CACHE_MAX_ENTRIES = 200;

function normaliseDestination(destination: string): string {
  return destination.trim().replace(/\s+/g, " ").toLowerCase();
}

/** sha256 hex of a canonical JSON of [normalisedDestination, [[id,title,time,kind],...]] in request order. */
export function priceCacheKey(
  destination: string,
  activities: readonly PricerActivity[],
  extra?: unknown,
): string {
  const base: unknown[] = [
    normaliseDestination(destination),
    activities.map((a) => [a.id, a.title, a.time, a.kind]),
  ];
  // Unchanged canonical form (and key) when `extra` is undefined.
  if (extra !== undefined) base.push(extra);
  const canonical = JSON.stringify(base);
  return createHash("sha256").update(canonical).digest("hex");
}

/** True when at least one result is "ai" or "web". All-estimated results are never cached (Req 6.19). */
export function shouldCache(prices: readonly PriceResult[]): boolean {
  return prices.some((p) => p.source === "ai" || p.source === "web");
}

interface Entry {
  value: PriceResult[];
  storedAt: number;
  meta?: unknown;
}

export class PriceCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly store = new Map<string, Entry>();

  constructor(opts?: { ttlMs?: number; maxEntries?: number }) {
    this.ttlMs = opts?.ttlMs ?? PRICE_CACHE_TTL_MS;
    this.maxEntries = opts?.maxEntries ?? PRICE_CACHE_MAX_ENTRIES;
  }

  private isExpired(entry: Entry, nowMs: number): boolean {
    return nowMs - entry.storedAt >= this.ttlMs;
  }

  /** Expired entry is deleted and treated as a miss. */
  get(key: string, nowMs: number): PriceResult[] | undefined {
    return this.getWithMeta(key, nowMs)?.value;
  }

  /** Like get, but also returns the optional meta (e.g. a validated route fare). */
  getWithMeta(
    key: string,
    nowMs: number,
  ): { value: PriceResult[]; meta?: unknown } | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.isExpired(entry, nowMs)) {
      this.store.delete(key);
      return undefined;
    }
    return { value: entry.value, meta: entry.meta };
  }

  /** Purge expired, then evict oldest until size < max; re-set moves the key to newest. */
  set(key: string, value: PriceResult[], nowMs: number, meta?: unknown): void {
    this.store.delete(key);
    for (const [k, e] of this.store) {
      if (this.isExpired(e, nowMs)) this.store.delete(k);
    }
    while (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      this.store.delete(oldest.value);
    }
    if (this.maxEntries <= 0) return;
    this.store.set(key, { value, storedAt: nowMs, meta });
  }

  get size(): number {
    return this.store.size;
  }
}
