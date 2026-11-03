/**
 * SerpApi core (server-only): the shared transport, cache and usage guard for
 * the Google Hotels and Google Flights adapters.
 *
 * Every SerpApi request goes through `cachedProviderCall`, in this order:
 *   cache get -> in-flight de-duplication -> (cache re-check) -> monthly usage
 *   guard -> GET with a 10 s abort -> parse -> build -> store when live.
 *
 * Honesty and secrecy rules enforced here:
 *  - The key is read only through `serpApiKey()`. SerpApi takes it as a query
 *    parameter, so the request URL is never logged or returned. Log lines carry
 *    only a tag and a status (Req 20.3).
 *  - Failures (missing key, paused guard, non-2xx, bad JSON, `error` payload,
 *    abort/timeout, a throwing builder) become a labelled `unavailable` result;
 *    this module never throws (Req 1.8, 1.9, 20.1).
 *  - Only `live` results are cached, and a cache hit returns the stored object
 *    unchanged so its original `checkedAt` is kept (Req 7.6, 7.7).
 *  - When the monthly soft limit is reached no request is sent and the caller
 *    gets `unavailable(PAUSED_MESSAGE)`; cache hits and de-duplicated calls do
 *    not count against the limit (Req 7.4, 8.1-8.5).
 *
 * SERVER-ONLY: import from server components and route handlers only.
 *
 * Requirements: 1.8, 1.9, 6.5, 7.4, 7.6, 7.7, 8.1, 8.2, 8.3, 8.4, 8.5, 8.7, 20.1, 20.3.
 */

import type { FetchLike } from "@/lib/live-data";
import { serpApiKey, serpApiMonthlySoftLimit } from "@/lib/config";
import {
  createProviderStore,
  type CacheKind,
  type ProviderStore,
  type Stored,
} from "@/lib/providers/provider-store";

export type { FetchLike } from "@/lib/live-data";

export const SERPAPI_ENDPOINT = "https://serpapi.com/search.json";
export const PROVIDER_TIMEOUT_MS = 10_000;
/** Slower live detail lookups (flight booking options, return legs). */
export const PROVIDER_DETAIL_TIMEOUT_MS = 25_000;

/** Shown when the monthly usage guard pauses live checks (Req 8.4). */
export const PAUSED_MESSAGE = "Live price checks are paused for this month, so estimates are shown.";

/** Generic labelled failure for a missing key; callers normally return `unconfigured` first. */
export const UNAVAILABLE_MESSAGE = "Live prices are temporarily unavailable. Please try again shortly.";

/** Process-wide cache, in-flight registry and usage counter shared by all adapters. */
export const providerStore: ProviderStore = createProviderStore();

export interface AdapterOptions {
  fetchImpl?: FetchLike;
  /** Injectable clock for date validation and timestamps (tests). */
  now?: Date;
}

/* ------------------------------------------------------------------------- *
 * JSON helpers (pure)
 * ------------------------------------------------------------------------- */

export type Json = Record<string, unknown>;

export function obj(v: unknown): Json | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

export function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

export function posNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** Only https URLs survive; everything else (javascript:, http:, garbage) is dropped. */
export function safeHttpsUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------- *
 * Cache keys (pure)
 * ------------------------------------------------------------------------- */

/** Trim, collapse internal whitespace and lower-case, so "  Goa " and "goa" share a key (Req 6.5). */
export function normalizeDestination(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/** `scope:` followed by the params as JSON with keys in sorted order (insertion order never matters). */
export function cacheKey(scope: string, params: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(params).sort()) sorted[k] = params[k];
  return `${scope}:${JSON.stringify(sorted)}`;
}

/* ------------------------------------------------------------------------- *
 * Transport
 * ------------------------------------------------------------------------- */

function defaultFetch(): FetchLike {
  return ((url, init) => fetch(url, init as RequestInit)) as FetchLike;
}

async function getJson(
  params: Record<string, string>,
  fetchImpl: FetchLike,
  logTag: string,
  timeoutMs: number = PROVIDER_TIMEOUT_MS,
): Promise<{ ok: true; data: Json } | { ok: false }> {
  const url = `${SERPAPI_ENDPOINT}?${new URLSearchParams(params).toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: "GET", signal: controller.signal });
    if (!res.ok) {
      // Status only - never the URL, which contains the API key.
      console.warn(`[${logTag}] provider responded ${res.status}`);
      return { ok: false };
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      console.warn(`[${logTag}] provider returned an unreadable payload`);
      return { ok: false };
    }
    const data = obj(parsed);
    if (!data || data.error !== undefined) {
      console.warn(`[${logTag}] provider returned an error payload`);
      return { ok: false };
    }
    return { ok: true, data };
  } catch {
    console.warn(`[${logTag}] request failed or timed out`);
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

export interface CachedProviderCallArgs<T extends Stored> {
  /** Cache and de-duplication key, normally from `cacheKey(scope, params)`. */
  key: string;
  kind: CacheKind;
  /** Request params WITHOUT the api key; the key is added here. */
  params: Record<string, string>;
  now: Date;
  fetchImpl?: FetchLike;
  logTag: string;
  /** Per-call abort budget (ms); defaults to PROVIDER_TIMEOUT_MS. Slower detail lookups pass more. */
  timeoutMs?: number;
  /** Normalise a successful payload into a live result; `completedAt` becomes `checkedAt`. */
  build: (data: Json, completedAt: Date) => T;
  /** Labelled failure result for the given user-facing message. */
  unavailable: (message: string) => T;
}

/**
 * The single path to SerpApi. Order: cache get -> dedupe -> usage guard -> GET
 * with a 10 s abort -> parse -> build -> store when live. Never throws.
 */
export async function cachedProviderCall<T extends Stored>(args: CachedProviderCallArgs<T>): Promise<T> {
  const { key, kind, params, now, logTag, build, unavailable } = args;

  try {
    const hit = providerStore.get<T>(key, now.getTime());
    if (hit) return hit;

    return await providerStore.dedupe<T>(key, async () => {
      try {
        // Another caller may have stored the result between our miss and now.
        const again = providerStore.get<T>(key, now.getTime());
        if (again) return again;

        const apiKey = serpApiKey();
        if (!apiKey) return unavailable(UNAVAILABLE_MESSAGE);

        if (!providerStore.tryConsume(now, serpApiMonthlySoftLimit())) {
          console.warn(`[${logTag}] monthly soft limit reached; live checks paused`);
          return unavailable(PAUSED_MESSAGE);
        }

        // Measure elapsed wall time so the completion time respects an injected clock.
        const startedWall = Date.now();
        const res = await getJson({ ...params, api_key: apiKey }, args.fetchImpl ?? defaultFetch(), logTag, args.timeoutMs);
        if (!res.ok) return unavailable(UNAVAILABLE_MESSAGE);

        const completedAt = new Date(now.getTime() + Math.max(0, Date.now() - startedWall));
        const result = build(res.data, completedAt);
        providerStore.set(key, result, kind, completedAt.getTime()); // ignores non-live results
        return result;
      } catch {
        console.warn(`[${logTag}] provider result could not be processed`);
        return unavailable(UNAVAILABLE_MESSAGE);
      }
    });
  } catch {
    console.warn(`[${logTag}] provider call failed`);
    return unavailable(UNAVAILABLE_MESSAGE);
  }
}
