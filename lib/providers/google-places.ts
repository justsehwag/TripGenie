/**
 * Google Places adapter (server-only, read-only) - google-places-integration
 * design section "Components and Interfaces §1".
 *
 * SERVER-ONLY: this module reads the Google Places API key via
 * `googlePlacesApiKey()` and must never be imported into client/browser code.
 * The key is sent only as the `X-Goog-Api-Key` request header and never appears
 * in any returned value, log line, or browser-bound payload (Req 1.2, 1.4).
 *
 * The adapter mirrors `lib/live-data.ts` exactly: an injectable `FetchLike`, a
 * bounded `AbortController` timeout (<=5s), and a single labelled result family
 * that returns a fallback rather than throwing (Req 1.1, 2.1-2.4, 10.5).
 */

import type { ProviderReview } from "@/lib/reviews";
// Reuse the exact injectable fetch contract from live-data.ts so the adapter is
// unit-testable as a pure read with no network (mirrors lib/live-data.ts).
import type { FetchLike } from "@/lib/live-data";
import { googlePlacesApiKey } from "@/lib/config";
// Shared, bounded, server-only Enrichment_Cache (task 4.1). It stores ONLY the
// non-review Place Details fields and resolved place_ids with lazy <=30-day
// expiry; review content is never written to it (Req 8.1). See design
// "Components and Interfaces §6 (Enrichment_Cache)".
import { enrichmentCache, type CachedEntry } from "@/lib/providers/enrichment-cache";

/** Retrieval mode - identical vocabulary to live-data.ts LiveMode. */
export type EnrichmentMode = "live" | "cached" | "fallback";

/** A Google photo reference, resolved to a displayable URL only via the proxy. */
export interface PhotoRef {
  /** Opaque Google photo resource name, e.g. "places/XXX/photos/YYY". */
  name: string;
  /** Optional attribution text Google requires to be shown with the photo. */
  attribution?: string;
}

/**
 * Normalized enrichment for ONE place (Glossary: Place_Enrichment).
 * `reviews` are present only in a live result and are NEVER cached (Req 8.1).
 */
export interface PlaceEnrichment {
  placeId: string;
  rating: number | null;        // Google rating (0-5), null when absent
  userRatingCount: number | null;
  reviews: ProviderReview[];     // up to a bounded number; shaped for reviews.ts
  photos: PhotoRef[];
  priceLevel: number | null;     // Price_Level_Band 0-4, indicative only (Req 6.6)
  provider: "Google";            // attribution, always "Google" (Req 1.5)
}

/** Single labelled result - same shape family as live-data.ts LiveResult<T>. */
export interface EnrichmentResult {
  data: PlaceEnrichment | null;  // null only on fallback
  mode: EnrichmentMode;
  provider: "Google";
}

export interface EnrichInput {
  /** A free-text place query (name + locality), for Text Search resolution. */
  query?: string;
  /** Optional Google place type bias, e.g. tourist_attraction, to avoid hotels/transit. */
  includedType?: string;
  /** A pre-resolved Google place_id, skipping the Text Search step. */
  placeId?: string;
  /** Per-request timeout; defaults to 5000ms and is clamped to <= 5000 (Req 2.1). */
  timeoutMs?: number;
}

/**
 * The Google Places API (New) endpoints this adapter reads from. A contracted
 * replacement can be swapped behind the same adapter contract with no caller
 * change (mirrors live-data.ts LIVE_SOURCES).
 */
const GOOGLE_PLACES = {
  textSearch: "https://places.googleapis.com/v1/places:searchText",
  /** Place Details (New) base; the place id is appended as a path segment. */
  detailsBase: "https://places.googleapis.com/v1/places/",
} as const;

/**
 * Map Google Places API (New) `priceLevel` ENUM strings to the indicative
 * Price_Level_Band 0-4 (Req 6.6). Anything else or absent -> null. Google
 * never returns a numeric price level on the New API, so only the enum is
 * honoured.
 */
const PRICE_LEVEL_BY_ENUM: Record<string, number> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

/** Default and maximum per-request timeout; clamped to <= 5000ms (Req 2.1). */
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 5000;

/**
 * Minimal POST-capable fetch shape. `FetchLike` from live-data.ts models only
 * read (GET) requests and intentionally omits a `body` field; the Text Search
 * endpoint is a POST with a JSON body, so we widen the injected fetcher's init
 * locally WITHOUT modifying live-data.ts. Any `FetchLike` is assignable to this
 * type, so tests can keep injecting the same mock fetch they use elsewhere.
 */
type PostFetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Resolve the global fetch, erroring clearly when none is available. */
function defaultFetch(): PostFetchLike {
  const f = (globalThis as { fetch?: unknown }).fetch;
  if (typeof f !== "function") throw new Error("no fetch available");
  return f as PostFetchLike;
}

/** Clamp a requested timeout into (0, MAX_TIMEOUT_MS]. */
function clampTimeout(timeoutMs?: number): number {
  const requested = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  return Math.min(requested, MAX_TIMEOUT_MS);
}

/**
 * Resolve a free-text query to a Google place_id via Text Search (Req 1.1).
 *
 * Issues a single bounded POST to the Places API (New) `searchText` endpoint
 * with an `AbortController` + `setTimeout` cleared in `finally` (mirrors the
 * `readJson` helper in lib/live-data.ts). The minimal `X-Goog-FieldMask` of
 * `places.id` (+ `places.displayName` for disambiguation) bounds response size
 * and cost (Req 9.4). The key is read via `googlePlacesApiKey()` and sent only
 * as the `X-Goog-Api-Key` header; it never appears in the returned value.
 *
 * Returns the first result's place id, or `null` when there is no key, no
 * result, or any error/timeout. This function NEVER throws (Req 2.2, 10.5).
 */
export async function resolvePlaceId(
  query: string,
  fetchImpl: PostFetchLike = defaultFetch(),
  includedType?: string,
): Promise<string | null> {
  const text = query.trim();
  if (text.length === 0) return null;

  const key = googlePlacesApiKey();
  if (key.length === 0) return null; // no key -> no request, no throw (Req 10.4)

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), clampTimeout());
  try {
    const response = await fetchImpl(GOOGLE_PLACES.textSearch, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.id,places.displayName",
      },
      body: JSON.stringify(includedType ? { textQuery: text, includedType, strictTypeFiltering: true } : { textQuery: text }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      places?: Array<{ id?: string }>;
    };
    const id = data.places?.[0]?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null; // network error / timeout / abort -> null, never throw
  } finally {
    clearTimeout(timer);
  }
}

/** The raw Google Places API (New) Place Details shape we read (field-masked). */
interface GooglePlaceDetails {
  id?: string;
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  photos?: Array<{
    name?: string;
    authorAttributions?: Array<{ displayName?: string }>;
  }>;
  reviews?: Array<{
    rating?: number;
    publishTime?: string;
    authorAttribution?: { displayName?: string };
    text?: { text?: string; languageCode?: string };
    originalText?: { text?: string; languageCode?: string };
  }>;
}

/** Max individual reviews surfaced at the adapter boundary (Req 3.7). */
const MAX_REVIEWS = 5;

/**
 * Fetch Place Details for a resolved `place_id` and normalize the result into a
 * `PlaceEnrichment` (Req 1.5, 1.6, 3.7, 9.1, 9.4).
 *
 * Issues a single bounded GET to the Places API (New) Place Details endpoint
 * (`GOOGLE_PLACES.detailsBase` + the URL-encoded place id) using the same
 * `AbortController` + `setTimeout(clampTimeout())` discipline as
 * `resolvePlaceId`, cleared in `finally`. The `X-Goog-FieldMask` header lists
 * ONLY the enumerated fields (`id,rating,userRatingCount,priceLevel,photos,
 * reviews`) so no field outside the mask is ever requested, bounding response
 * size and cost (Req 9.1, 9.4). The key is read via `googlePlacesApiKey()` and
 * sent only as the `X-Goog-Api-Key` header; it never appears in the returned
 * shape, is never logged, and is never embedded in any value.
 *
 * Normalization notes:
 * - `priceLevel` is mapped from Google's ENUM string to the 0-4 band, else null.
 * - `photos[].name` becomes a `PhotoRef`; no URL is built and no key is embedded.
 * - `reviews[]` map to `ProviderReview[]`, dropping any entry missing author,
 *   text, or rating, then sliced to at most 5 at this boundary (Req 3.7).
 *
 * Returns `null` when there is no key, a non-ok status, a network error, a
 * timeout, or a missing id. This function NEVER throws (Req 2.2, 10.5).
 */
export async function fetchPlaceDetails(
  placeId: string,
  fetchImpl: PostFetchLike = defaultFetch(),
): Promise<PlaceEnrichment | null> {
  const id = placeId.trim();
  if (id.length === 0) return null;

  const key = googlePlacesApiKey();
  if (key.length === 0) return null; // no key -> no request, no throw (Req 10.4)

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), clampTimeout());
  try {
    const response = await fetchImpl(GOOGLE_PLACES.detailsBase + encodeURIComponent(id), {
      method: "GET",
      headers: {
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "id,rating,userRatingCount,priceLevel,photos,reviews",
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const data = (await response.json()) as GooglePlaceDetails;
    const resolvedId = typeof data.id === "string" && data.id.length > 0 ? data.id : id;
    if (resolvedId.length === 0) return null;

    const priceLevel =
      typeof data.priceLevel === "string" && data.priceLevel in PRICE_LEVEL_BY_ENUM
        ? PRICE_LEVEL_BY_ENUM[data.priceLevel]
        : null;

    const photos: PhotoRef[] = (data.photos ?? [])
      .map((photo): PhotoRef | null => {
        if (typeof photo.name !== "string" || photo.name.length === 0) return null;
        const attribution = photo.authorAttributions?.[0]?.displayName;
        return {
          name: photo.name,
          attribution: typeof attribution === "string" && attribution.length > 0 ? attribution : undefined,
        };
      })
      .filter((photo): photo is PhotoRef => photo !== null);

    const reviews: ProviderReview[] = (data.reviews ?? [])
      .map((review): ProviderReview | null => {
        const author = review.authorAttribution?.displayName;
        const text = review.text?.text ?? review.originalText?.text;
        const rating = review.rating;
        if (
          typeof author !== "string" ||
          author.length === 0 ||
          typeof text !== "string" ||
          text.length === 0 ||
          typeof rating !== "number"
        ) {
          return null; // drop reviews missing author/text/rating
        }
        return {
          author,
          rating,
          text,
          publishedAt: typeof review.publishTime === "string" ? review.publishTime : "",
        };
      })
      .filter((review): review is ProviderReview => review !== null)
      .slice(0, MAX_REVIEWS); // cap at the adapter boundary (Req 3.7)

    return {
      placeId: resolvedId,
      rating: typeof data.rating === "number" ? data.rating : null,
      userRatingCount: typeof data.userRatingCount === "number" ? data.userRatingCount : null,
      reviews,
      photos,
      priceLevel,
      provider: "Google",
    };
  } catch {
    return null; // network error / timeout / abort -> null, never throw
  } finally {
    clearTimeout(timer);
  }
}

/** Normalize a free-text query into the request-scoped memo key. */
function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * Build a `PlaceEnrichment` from a cached NON-REVIEW entry. Reviews are NEVER
 * cached (Req 8.1), so a cache-served enrichment always carries `reviews: []`.
 */
function enrichmentFromCache(entry: CachedEntry): PlaceEnrichment {
  return {
    placeId: entry.placeId,
    rating: entry.rating,
    userRatingCount: entry.userRatingCount,
    reviews: [], // reviews are never cached; a cached result has none (Req 8.1)
    photos: entry.photos,
    priceLevel: entry.priceLevel,
    provider: "Google",
  };
}

/**
 * The single public entry point every surface calls to enrich ONE place
 * (Req 2.1-2.4, 7.1, 8.1, 8.2, 8.5, 9.2, 9.3, 10.4, 10.5). Mirrors the
 * `resolveLive` wrapper in lib/live-data.ts: it produces a single labelled
 * result and NEVER throws for any outcome.
 *
 * Flow (design "Enrichment request/response flow" sequence + "Components and
 * Interfaces §1 / §6" + the Error Handling table):
 * 1. If `googlePlacesApiKey()` is empty, short-circuit to a fallback result
 *    WITHOUT issuing any outbound request (Req 10.4).
 * 2. Request-scoped memo (Req 9.3): when the caller supplies a per-request
 *    `memo` map, a place already computed in THIS request is returned verbatim
 *    so the same place is fetched at most once per server request. The memo is
 *    keyed by the resolved placeId, or the normalized query while no placeId is
 *    known yet. Only the single caller-provided map is ever touched, so memo
 *    scope is strictly one request.
 * 3. Resolve the place id (Req 9.2): use `input.placeId` verbatim when non-empty
 *    (skips Text Search); otherwise resolve `input.query` via the cache first
 *    (`enrichmentCache.getPlaceId`) and only call `resolvePlaceId` on a miss,
 *    writing the resolution back with `setPlaceId`. If neither yields a place
 *    id, return a fallback result.
 * 4. Details via the cache for NON-REVIEW fields (Req 8.5, 9.2): consult
 *    `enrichmentCache.getDetails(placeId)` before any new Place Details call.
 *    - HIT: serve `mode: "cached"` from the cached non-review fields. Reviews
 *      are NEVER cached (Req 8.1), so a cached result carries `reviews: []`;
 *      per the design, a surface that needs reviews fetches them live each time.
 *      This keeps the task simple and correct while still serving cached
 *      rating/count/photos/price-band.
 *    - MISS/expiry: call `fetchPlaceDetails`; on success write ONLY the
 *      non-review fields to the cache via `setDetails` (reviews excluded,
 *      Req 8.1) and return `{ data, mode: "live" }` with the FULL live data
 *      INCLUDING its reviews.
 * 5. On a `fetchPlaceDetails` null result (non-2xx, network error, timeout, or
 *    empty) return a fallback.
 *
 * `resolvePlaceId` and `fetchPlaceDetails` already bound every request with an
 * `AbortController` + `setTimeout(clampTimeout())` (<=5000ms) and already return
 * null rather than throwing, so this wrapper does not loosen the <=5s bound. The
 * whole body - including the new cache/memo logic - is wrapped in try/catch so
 * any unexpected error is converted into the fallback result (Req 2.2, 2.3,
 * 10.5).
 *
 * Caching/memoization policy (keeps a transient Google outage retryable): only
 * SUCCESSFUL results feed the shared cache - the resolved place_id and the
 * non-review details fields. A fallback is NEVER written to the shared cache.
 * The request-scoped memo may hold a fallback, but only inside the single
 * caller-provided map (it dies with the request), so a later request can still
 * retry. Nothing Google-sourced is written to the Trips store by this path
 * (Req 8.2) - this wrapper only touches the in-memory cache.
 *
 * The returned value never carries the API key. `data` is null ONLY on
 * fallback, and a fallback result carries no rating/review/photo/price-band
 * content.
 *
 * The `memo` parameter is OPTIONAL and backward-compatible: existing callers
 * that pass only `(input)` or `(input, fetchImpl)` keep working unchanged; the
 * memo is simply skipped when absent.
 */
export async function enrichPlace(
  input: EnrichInput,
  fetchImpl: PostFetchLike = defaultFetch(),
  memo?: Map<string, EnrichmentResult>,
): Promise<EnrichmentResult> {
  const fallback: EnrichmentResult = { data: null, mode: "fallback", provider: "Google" };

  try {
    // No key -> no outbound request, labelled fallback (Req 10.4).
    if (googlePlacesApiKey().length === 0) return fallback;

    // Pre-compute a memo key for the pre-resolution phase. When a placeId is
    // supplied up front we can memo by it immediately; otherwise we memo by the
    // normalized query until a placeId is resolved (Req 9.3).
    const providedPlaceId = typeof input.placeId === "string" ? input.placeId.trim() : "";
    const query = typeof input.query === "string" ? input.query.trim() : "";
    const earlyMemoKey = providedPlaceId.length > 0 ? providedPlaceId : normalizeQuery(query);

    // Request-scoped memo hit on the early key (resolved placeId, or query when
    // no placeId yet) -> return the already-computed result for this request.
    if (memo && earlyMemoKey.length > 0) {
      const memoed = memo.get(earlyMemoKey);
      if (memoed !== undefined) return memoed;
    }

    // Resolve the place id (Req 9.2): a pre-resolved placeId wins and skips
    // Text Search; otherwise resolve a non-empty query via the cache, falling
    // back to a live Text Search on a cache miss and caching the resolution.
    let placeId: string | null = null;
    if (providedPlaceId.length > 0) {
      placeId = providedPlaceId;
    } else if (query.length > 0) {
      const cachedPlaceId = enrichmentCache.getPlaceId(query);
      if (cachedPlaceId !== null) {
        placeId = cachedPlaceId;
      } else {
        placeId = await resolvePlaceId(query, fetchImpl, input.includedType);
        // If a strict type filter (e.g. tourist_attraction) returned nothing,
        // retry once WITHOUT the filter so the day still gets a non-hotel image
        // rather than a blank, since some titles are not classified strictly.
        if ((placeId === null || placeId.length === 0) && input.includedType) {
          placeId = await resolvePlaceId(query, fetchImpl);
        }
        if (placeId !== null && placeId.length > 0) {
          enrichmentCache.setPlaceId(query, placeId); // cache only a successful resolution
        }
      }
    }

    // Neither a placeId nor a resolvable query -> fallback (Req 2.3). Memoize
    // the fallback only in the caller's request-scoped map so a later request
    // can still retry; never write a fallback to the shared cache.
    if (placeId === null || placeId.length === 0) {
      if (memo && earlyMemoKey.length > 0) memo.set(earlyMemoKey, fallback);
      return fallback;
    }

    // Now that we have a resolved placeId, prefer memoizing by it. A different
    // input (e.g. query) that resolved to the same place reuses the computed
    // result within this request (Req 9.3).
    if (memo) {
      const memoedByPlaceId = memo.get(placeId);
      if (memoedByPlaceId !== undefined) return memoedByPlaceId;
    }

    // Details via the cache for NON-REVIEW fields (Req 8.5, 9.2). Consult the
    // shared cache before issuing any new Place Details call.
    const cachedDetails = enrichmentCache.getDetails(placeId);
    let result: EnrichmentResult;
    if (cachedDetails !== null) {
      // Cache HIT: serve the non-review fields as `mode: "cached"`. Reviews are
      // NEVER cached (Req 8.1), so the served enrichment carries `reviews: []`;
      // a surface that needs reviews fetches them live each time (per design).
      result = { data: enrichmentFromCache(cachedDetails), mode: "cached", provider: "Google" };
    } else {
      // Cache MISS/expiry: fetch live, then write ONLY the non-review fields
      // back to the cache (reviews excluded, Req 8.1) and return the FULL live
      // data including reviews for this request.
      const data = await fetchPlaceDetails(placeId, fetchImpl);
      if (data === null) {
        // non-2xx / error / timeout / empty (Req 2.2). Do NOT cache the
        // fallback (a transient outage must stay retryable); memoize only in
        // the request-scoped map.
        if (memo) memo.set(placeId, fallback);
        if (memo && earlyMemoKey.length > 0) memo.set(earlyMemoKey, fallback);
        return fallback;
      }

      enrichmentCache.setDetails({
        placeId: data.placeId,
        rating: data.rating,
        userRatingCount: data.userRatingCount,
        priceLevel: data.priceLevel,
        photos: data.photos,
        storedAt: Date.now(),
        // NOTE: reviews are intentionally NOT passed to setDetails (Req 8.1).
      });
      result = { data, mode: "live", provider: "Google" };
    }

    // Memoize the successful result under both the resolved placeId and the
    // early key (query) so repeat enrichment in this request reuses it (Req 9.3).
    if (memo) {
      memo.set(placeId, result);
      if (earlyMemoKey.length > 0) memo.set(earlyMemoKey, result);
    }

    return result;
  } catch {
    // Defensive: nothing above is expected to throw, but any unexpected error
    // still degrades to the labelled fallback rather than crossing into a
    // calling surface (Req 2.2, 10.5). Fallbacks are never written to the
    // shared cache.
    return fallback;
  }
}

/**
 * A single autocomplete prediction surfaced to the Discover search box.
 * `placeId` lets a later Place Details call skip Text Search; `text` is the
 * full human-readable suggestion shown in the dropdown.
 */
export interface PlacePrediction {
  placeId: string;
  text: string;
  /** Primary (main) text of the suggestion, e.g. "Eiffel Tower". */
  primary: string;
  /** Secondary text, e.g. "Paris, France". */
  secondary: string;
}

/**
 * As-you-type place predictions via Places Autocomplete (New) (Req: Discover
 * realtime suggestions). Mirrors the adapter contract exactly: server-only key
 * via `googlePlacesApiKey()` sent only as `X-Goog-Api-Key`, a bounded
 * AbortController timeout cleared in `finally`, and a TOTAL fallback - any
 * missing key, non-2xx, empty body, timeout, or error resolves to `[]` and
 * NEVER throws into the caller. The key never appears in the returned value.
 */
export async function autocompletePlaces(
  input: string,
  fetchImpl: PostFetchLike = defaultFetch(),
): Promise<PlacePrediction[]> {
  const text = input.trim();
  if (text.length === 0) return [];

  const key = googlePlacesApiKey();
  if (key.length === 0) return []; // no key -> no request, no throw

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), clampTimeout());
  try {
    const response = await fetchImpl("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
      },
      body: JSON.stringify({ input: text }),
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const data = (await response.json()) as {
      suggestions?: Array<{
        placePrediction?: {
          placeId?: string;
          text?: { text?: string };
          structuredFormat?: {
            mainText?: { text?: string };
            secondaryText?: { text?: string };
          };
        };
      }>;
    };
    const out: PlacePrediction[] = [];
    for (const s of data.suggestions ?? []) {
      const p = s.placePrediction;
      if (!p) continue;
      const placeId = typeof p.placeId === "string" ? p.placeId : "";
      const full = p.text?.text ?? "";
      const primary = p.structuredFormat?.mainText?.text ?? full;
      const secondary = p.structuredFormat?.secondaryText?.text ?? "";
      if (placeId.length === 0 || full.length === 0) continue;
      out.push({ placeId, text: full, primary, secondary });
    }
    return out.slice(0, 6);
  } catch {
    return []; // network error / timeout / abort -> empty, never throw
  } finally {
    clearTimeout(timer);
  }
}

/** A geographic point (WGS84), used for hotel search + haversine distances. */
export interface LatLng {
  lat: number;
  lng: number;
}

/** A single hotel result from Nearby Search, with coordinates for distances. */
export interface HotelResult {
  placeId: string;
  name: string;
  rating: number | null;
  userRatingCount: number | null;
  priceLevel: number | null;
  location: LatLng | null;
  photos: PhotoRef[];
  address: string;
}

/**
 * Resolve a free-text destination to a center LatLng via Text Search (New).
 * Uses a minimal field mask (id + location). Returns null on any failure so the
 * hotels feature degrades cleanly. Never throws.
 */
export async function resolveLocation(
  query: string,
  fetchImpl: PostFetchLike = defaultFetch(),
): Promise<LatLng | null> {
  const text = query.trim();
  if (text.length === 0) return null;
  const key = googlePlacesApiKey();
  if (key.length === 0) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), clampTimeout());
  try {
    const response = await fetchImpl(GOOGLE_PLACES.textSearch, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.id,places.location",
      },
      body: JSON.stringify({ textQuery: text }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      places?: Array<{ location?: { latitude?: number; longitude?: number } }>;
    };
    const loc = data.places?.[0]?.location;
    if (loc && typeof loc.latitude === "number" && typeof loc.longitude === "number") {
      return { lat: loc.latitude, lng: loc.longitude };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Find lodging near a center point via Nearby Search (New) (Req: hotels list).
 * Returns up to `maxResults` real hotels with coordinates, rating, price band,
 * and photos. Server-only key; total fallback to [] on any error; never throws.
 */
export async function nearbyHotels(
  center: LatLng,
  radiusMeters = 6000,
  maxResults = 8,
  fetchImpl: PostFetchLike = defaultFetch(),
): Promise<HotelResult[]> {
  const key = googlePlacesApiKey();
  if (key.length === 0) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), clampTimeout());
  try {
    const response = await fetchImpl("https://places.googleapis.com/v1/places:searchNearby", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.rating,places.userRatingCount,places.priceLevel,places.location,places.photos,places.formattedAddress",
      },
      body: JSON.stringify({
        includedTypes: ["lodging"],
        maxResultCount: Math.min(Math.max(maxResults, 1), 20),
        locationRestriction: {
          circle: {
            center: { latitude: center.lat, longitude: center.lng },
            radius: Math.min(Math.max(radiusMeters, 500), 50000),
          },
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const data = (await response.json()) as {
      places?: Array<{
        id?: string;
        displayName?: { text?: string };
        rating?: number;
        userRatingCount?: number;
        priceLevel?: string;
        location?: { latitude?: number; longitude?: number };
        formattedAddress?: string;
        photos?: Array<{ name?: string; authorAttributions?: Array<{ displayName?: string }> }>;
      }>;
    };
    const out: HotelResult[] = [];
    for (const p of data.places ?? []) {
      const placeId = typeof p.id === "string" ? p.id : "";
      const name = p.displayName?.text ?? "";
      if (placeId.length === 0 || name.length === 0) continue;
      const loc = p.location;
      const location: LatLng | null =
        loc && typeof loc.latitude === "number" && typeof loc.longitude === "number"
          ? { lat: loc.latitude, lng: loc.longitude }
          : null;
      const photos: PhotoRef[] = (p.photos ?? [])
        .map((ph): PhotoRef | null => {
          if (typeof ph.name !== "string" || ph.name.length === 0) return null;
          const attribution = ph.authorAttributions?.[0]?.displayName;
          return { name: ph.name, attribution: typeof attribution === "string" ? attribution : undefined };
        })
        .filter((ph): ph is PhotoRef => ph !== null)
        .slice(0, 4);
      out.push({
        placeId,
        name,
        rating: typeof p.rating === "number" ? p.rating : null,
        userRatingCount: typeof p.userRatingCount === "number" ? p.userRatingCount : null,
        priceLevel: typeof p.priceLevel === "string" && p.priceLevel in PRICE_LEVEL_BY_ENUM ? PRICE_LEVEL_BY_ENUM[p.priceLevel] : null,
        location,
        photos,
        address: typeof p.formattedAddress === "string" ? p.formattedAddress : "",
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Straight-line (haversine) distance in kilometers between two points. Pure
 * math, no API call, no cost. Used to label a hotel's approximate distance from
 * each planned itinerary spot (clearly "approx", not a routed drive distance).
 */
export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371; // Earth radius km
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A suggested place for the Edit Day picker: a real spot with a photo. */
export interface PlaceSuggestion {
  placeId: string;
  name: string;
  rating: number | null;
  userRatingCount: number | null;
  address: string;
  photo: PhotoRef | null;
}

/**
 * Suggest real places for a destination (+ optional interest) via Text Search
 * (New), each with one photo for a mini visual preview. Server-only key;
 * returns [] on any failure; never throws.
 */
export async function suggestPlaces(
  query: string,
  fetchImpl: PostFetchLike = defaultFetch(),
): Promise<PlaceSuggestion[]> {
  const text = query.trim();
  if (text.length === 0) return [];
  const key = googlePlacesApiKey();
  if (key.length === 0) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), clampTimeout());
  try {
    const response = await fetchImpl(GOOGLE_PLACES.textSearch, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.id,places.displayName,places.rating,places.userRatingCount,places.formattedAddress,places.photos",
      },
      body: JSON.stringify({ textQuery: text, maxResultCount: 8 }),
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const data = (await response.json()) as { places?: Array<{ id?: string; displayName?: { text?: string }; rating?: number; userRatingCount?: number; formattedAddress?: string; photos?: Array<{ name?: string; authorAttributions?: Array<{ displayName?: string }> }> }> };
    const out: PlaceSuggestion[] = [];
    for (const p of data.places ?? []) {
      const placeId = typeof p.id === "string" ? p.id : "";
      const name = p.displayName?.text ?? "";
      if (placeId.length === 0 || name.length === 0) continue;
      const ph = (p.photos ?? [])[0];
      const photo: PhotoRef | null = ph && typeof ph.name === "string" ? { name: ph.name, attribution: ph.authorAttributions?.[0]?.displayName } : null;
      out.push({ placeId, name, rating: typeof p.rating === "number" ? p.rating : null, userRatingCount: typeof p.userRatingCount === "number" ? p.userRatingCount : null, address: typeof p.formattedAddress === "string" ? p.formattedAddress : "", photo });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Search hotels for a destination via Text Search (New) with pagination so
 * we can return 30+ real lodging options (Nearby Search caps at 20). Each
 * hotel carries rating, review count, price band, coordinates, and photos.
 * Server-only key; total fallback to [] on any error; never throws.
 */
export async function searchHotels(
  destination: string,
  minResults = 30,
  fetchImpl: PostFetchLike = defaultFetch(),
): Promise<HotelResult[]> {
  const dest = destination.trim();
  if (dest.length === 0) return [];
  const key = googlePlacesApiKey();
  if (key.length === 0) return [];
  const results: HotelResult[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined = undefined;
  const mask = "places.id,places.displayName,places.rating,places.userRatingCount,places.priceLevel,places.location,places.photos,places.formattedAddress,nextPageToken";
  for (let page = 0; page < 3 && results.length < minResults; page++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), clampTimeout());
    try {
      const body: Record<string, unknown> = { textQuery: "hotels in " + dest, maxResultCount: 20 };
      if (pageToken) body.pageToken = pageToken;
      const response = await fetchImpl(GOOGLE_PLACES.textSearch, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": mask },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) break;
      const data = (await response.json()) as { places?: Array<{ id?: string; displayName?: { text?: string }; rating?: number; userRatingCount?: number; priceLevel?: string; location?: { latitude?: number; longitude?: number }; formattedAddress?: string; photos?: Array<{ name?: string; authorAttributions?: Array<{ displayName?: string }> }> }>; nextPageToken?: string };
      for (const p of data.places ?? []) {
        const placeId = typeof p.id === "string" ? p.id : "";
        const name = p.displayName?.text ?? "";
        if (placeId.length === 0 || name.length === 0 || seen.has(placeId)) continue;
        seen.add(placeId);
        const loc = p.location;
        const location: LatLng | null = loc && typeof loc.latitude === "number" && typeof loc.longitude === "number" ? { lat: loc.latitude, lng: loc.longitude } : null;
        const photos: PhotoRef[] = (p.photos ?? []).map((ph): PhotoRef | null => (typeof ph.name === "string" && ph.name.length > 0 ? { name: ph.name, attribution: ph.authorAttributions?.[0]?.displayName } : null)).filter((ph): ph is PhotoRef => ph !== null).slice(0, 4);
        results.push({ placeId, name, rating: typeof p.rating === "number" ? p.rating : null, userRatingCount: typeof p.userRatingCount === "number" ? p.userRatingCount : null, priceLevel: typeof p.priceLevel === "string" && p.priceLevel in PRICE_LEVEL_BY_ENUM ? PRICE_LEVEL_BY_ENUM[p.priceLevel] : null, location, photos, address: typeof p.formattedAddress === "string" ? p.formattedAddress : "" });
      }
      pageToken = typeof data.nextPageToken === "string" ? data.nextPageToken : undefined;
      if (!pageToken) break;
    } catch {
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  return results;
}
