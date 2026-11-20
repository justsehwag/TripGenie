import { googlePlacesApiKey, wikimediaContact } from "./config";
import { isValidPhotoRef } from "./itinerary/maps-link";
import {
  acceptImageUrl,
  parseRetryAfter,
  setWikiBackoffUntil,
  wikiBackoffUntil,
  wikimediaUserAgent,
  type WikiReason,
} from "./wiki-image";
import {
  MIN_USABLE_WIDTH,
  SIZE_WIDTHS,
  buildSrcSet,
  chooseWidths,
  classifyImage,
  thumbFromOriginal,
  type SizeClass,
} from "./wiki-image-policy";

/**
 * Destination_Image_Request resolver (server). Requirement 6.
 * Source order, stopping at the first image that passes the width policy and the classifier:
 *   1. Google Places photo of the top tourist attraction (one POST, skipped without a key,
 *      outside the itinerary PlacesBudget), returned as /api/place-photo?ref=...&w=...
 *   2. Lead image of the Wikipedia page "Tourism in <X>" (pageimages, 1 request).
 *   3. Images of the destination page (images + imageinfo, 2 requests).
 * At most 1 Places and 3 Wikimedia requests, one AbortController and one overall timeout.
 * Never throws. Never returns a flag, emblem, map, logo or SVG. No bundled substitute.
 *
 * This module imports from lib/wiki-image.ts. lib/wiki-image.ts must reach it only through
 * a dynamic import (task 4.9), so there is no static import cycle.
 */

export type DestinationImageReason = WikiReason | "no-representative-image";

export type DestinationImageResult =
  | { url: string; srcset?: string; source: "places" | "tourism-page" | "destination-page" }
  | { url: null; reason: DestinationImageReason };

export interface CacheEntry {
  value: DestinationImageResult;
  expiresAt: number;
}

export interface DestinationImageCache {
  get(key: string, nowMs: number): DestinationImageResult | undefined;
  set(key: string, value: DestinationImageResult, ttlMs: number, nowMs: number): void;
  clear(): void;
  readonly size: number;
}

export interface DestinationImageDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  contact?: string;
  /** Google Places key. Default googlePlacesApiKey (server env). */
  placesKey?: () => string;
  cache?: DestinationImageCache;
  /** Overall timeout. Default 6000 ms. */
  timeoutMs?: number;
}

export const DESTINATION_CACHE_MAX = 500;
export const DESTINATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const NO_IMAGE_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 6000;
const MAX_WIKIMEDIA_REQUESTS = 3;
const MAX_PLACES_REQUESTS = 1;
const MAX_QUERY_CHARS = 100;
const PLACES_MAX_RESULTS = 5;
const PLACES_MAX_WIDTH = 1600;
const IMAGE_LIST_LIMIT = 20;
const IMAGEINFO_BATCH = 10;
const RASTER_MIME = /^image\/(jpeg|png|webp)$/i;
const PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const PLACES_FIELD_MASK = "places.id,places.displayName,places.primaryType,places.photos";

/** Bounded insertion-order cache with per-entry expiry. */
export function createDestinationImageCache(max: number = DESTINATION_CACHE_MAX): DestinationImageCache {
  const map = new Map<string, CacheEntry>();
  return {
    get(key, nowMs) {
      const e = map.get(key);
      if (!e) return undefined;
      if (e.expiresAt <= nowMs) {
        map.delete(key);
        return undefined;
      }
      return e.value;
    },
    set(key, value, ttlMs, nowMs) {
      if (map.has(key)) map.delete(key);
      map.set(key, { value, expiresAt: nowMs + ttlMs });
      while (map.size > max) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}

const defaultCache = createDestinationImageCache();

/** Test helper: empty the process-wide cache. */
export function resetDestinationImageCache(): void {
  defaultCache.clear();
}

/** Internal control-flow signal carrying a reason. */
class Stop {
  constructor(readonly reason: DestinationImageReason) {}
}

function cleanQuery(q: unknown): string {
  if (typeof q !== "string") return "";
  return q.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS).trim();
}

function normaliseSlot(slot: unknown): number {
  return typeof slot === "number" && Number.isFinite(slot) ? Math.trunc(slot) : 0;
}

function pick<T>(items: T[], slot: number): T | undefined {
  if (items.length === 0) return undefined;
  return items[((slot % items.length) + items.length) % items.length];
}

/** Pure. Places photo name to a place-photo proxy URL pair, widths capped at 1600. */
function placePhotoUrls(ref: string, size: SizeClass): { url: string; srcset?: string } {
  const want = SIZE_WIDTHS[size];
  const x1 = Math.min(want.x1, PLACES_MAX_WIDTH);
  const x2 = Math.min(want.x2, PLACES_MAX_WIDTH);
  const make = (w: number) => `/api/place-photo?ref=${encodeURIComponent(ref)}&w=${w}`;
  const url = make(x1);
  const srcset = x2 > x1 ? buildSrcSet(url, make(x2)) : undefined;
  return srcset ? { url, srcset } : { url };
}

/** Pure. Thumbnail URLs for an original upload.wikimedia.org file of known width. */
function thumbsFromOriginal(
  originalUrl: string,
  originalWidth: number,
  size: SizeClass,
): { url: string; srcset?: string } | null {
  const widths = chooseWidths(size, originalWidth, NaN);
  if (widths === null || widths.x1 < MIN_USABLE_WIDTH) return null;
  const x1 = thumbFromOriginal(originalUrl, widths.x1);
  if (x1 === null || !acceptImageUrl(x1)) return null;
  let x2: string | undefined;
  if (widths.x2 !== undefined) {
    const c = thumbFromOriginal(originalUrl, widths.x2);
    if (c === null || !acceptImageUrl(c)) return null;
    x2 = c;
  }
  const srcset = buildSrcSet(x1, x2);
  return srcset ? { url: x1, srcset } : { url: x1 };
}

function fileNameOf(title: string): string {
  return title.replace(/^[^:]*:/, "").replace(/ /g, "_");
}

export async function resolveDestinationImage(
  query: string,
  size: SizeClass,
  slot: number,
  deps: DestinationImageDeps = {},
): Promise<DestinationImageResult> {
  const now = deps.now ?? Date.now;
  const cache = deps.cache ?? defaultCache;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    const destination = cleanQuery(query);
    if (destination === "") return { url: null, reason: "no-page" };
    const slotN = normaliseSlot(slot);
    const key = `${destination.toLowerCase()}|${size}|${slotN}`;
    const hit = cache.get(key, now());
    if (hit) return hit;

    const fetchImpl = deps.fetchImpl ?? fetch;
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Stop("timeout"));
      }, timeoutMs);
    });
    timeout.catch(() => undefined);

    let placesRequests = 0;
    let wikimediaRequests = 0;

    const readJson = async (res: Response): Promise<unknown> => {
      try {
        return await Promise.race([res.json(), timeout]);
      } catch (e) {
        if (e instanceof Stop) throw e;
        throw new Stop(timedOut ? "timeout" : "upstream-error");
      }
    };

    // ---- Source 1: Google Places -------------------------------------------------
    const placesPhoto = async (): Promise<{ url: string; srcset?: string } | null> => {
      let apiKey = "";
      try {
        apiKey = (deps.placesKey ?? googlePlacesApiKey)();
      } catch {
        apiKey = "";
      }
      if (!apiKey || placesRequests >= MAX_PLACES_REQUESTS) return null;
      placesRequests += 1;
      let res: Response;
      try {
        res = await Promise.race([
          fetchImpl(PLACES_SEARCH_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Goog-Api-Key": apiKey,
              "X-Goog-FieldMask": PLACES_FIELD_MASK,
            },
            body: JSON.stringify({
              textQuery: `top tourist attractions in ${destination}`,
              maxResultCount: PLACES_MAX_RESULTS,
            }),
            signal: controller.signal,
          }),
          timeout,
        ]);
      } catch (e) {
        if (e instanceof Stop) throw e;
        if (timedOut) throw new Stop("timeout");
        return null; // Places failure: fall through to Wikimedia.
      }
      if (!res.ok) return null;
      let body: unknown;
      try {
        body = await readJson(res);
      } catch (e) {
        if (e instanceof Stop && e.reason === "timeout") throw e;
        return null;
      }
      const places = (body as { places?: unknown } | null)?.places;
      if (!Array.isArray(places)) return null;
      const refs: string[] = [];
      for (const p of places) {
        const photos = (p as { photos?: unknown } | null)?.photos;
        if (!Array.isArray(photos)) continue;
        for (const ph of photos) {
          const name = (ph as { name?: unknown } | null)?.name;
          if (isValidPhotoRef(name)) {
            refs.push(name);
            break; // first valid photo of this place
          }
        }
      }
      const ref = pick(refs, slotN);
      return ref === undefined ? null : placePhotoUrls(ref, size);
    };

    // ---- Wikimedia requests ------------------------------------------------------
    const headers = { "User-Agent": wikimediaUserAgent(deps.contact ?? wikimediaContact()), Accept: "application/json" };
    const wikiGet = async (url: string): Promise<unknown> => {
      if (wikimediaRequests >= MAX_WIKIMEDIA_REQUESTS) throw new Stop("upstream-error");
      wikimediaRequests += 1;
      let res: Response;
      try {
        res = await Promise.race([fetchImpl(url, { headers, signal: controller.signal }), timeout]);
      } catch (e) {
        if (e instanceof Stop) throw e;
        throw new Stop(timedOut ? "timeout" : "upstream-error");
      }
      if (res.status === 429) {
        const secs = parseRetryAfter(res.headers?.get?.("retry-after") ?? null, now());
        setWikiBackoffUntil(now() + secs * 1000);
        throw new Stop("rate-limited");
      }
      if (!res.ok) throw new Stop("upstream-error");
      return readJson(res);
    };

    const api = "https://en.wikipedia.org/w/api.php";
    const common = "&redirects=1&format=json&formatversion=2";

    // ---- Source 2: "Tourism in X" lead image -------------------------------------
    const tourismPage = async (): Promise<{ url: string; srcset?: string } | null> => {
      const titles = encodeURIComponent(`Tourism in ${destination}`);
      const body = (await wikiGet(
        `${api}?action=query&prop=pageimages&piprop=name%7Coriginal&titles=${titles}${common}`,
      )) as { query?: { pages?: unknown } } | null;
      const pages = Array.isArray(body?.query?.pages) ? (body!.query!.pages as unknown[]) : [];
      for (const p of pages) {
        const page = p as {
          missing?: unknown;
          pageimage?: unknown;
          original?: { source?: unknown; width?: unknown } | null;
        } | null;
        if (!page || page.missing) continue;
        const src = page.original?.source;
        const width = page.original?.width;
        if (typeof src !== "string" || typeof width !== "number") continue;
        const fileName = typeof page.pageimage === "string" ? page.pageimage : undefined;
        if (classifyImage({ fileName, url: src }) === "reject") continue;
        const thumbs = thumbsFromOriginal(src, width, size);
        if (thumbs !== null) return thumbs;
      }
      return null;
    };

    // ---- Source 3: destination page images ---------------------------------------
    const destinationPage = async (): Promise<{ url: string; srcset?: string } | null> => {
      const titles = encodeURIComponent(destination);
      const list = (await wikiGet(
        `${api}?action=query&prop=images&titles=${titles}&imlimit=${IMAGE_LIST_LIMIT}${common}`,
      )) as { query?: { pages?: unknown } } | null;
      const listPages = Array.isArray(list?.query?.pages) ? (list!.query!.pages as unknown[]) : [];
      const files: string[] = [];
      for (const p of listPages) {
        const imgs = (p as { images?: unknown } | null)?.images;
        if (!Array.isArray(imgs)) continue;
        for (const im of imgs) {
          const title = (im as { title?: unknown } | null)?.title;
          if (typeof title !== "string" || !/^File:/i.test(title)) continue;
          if (!/\.(jpe?g|png|webp)$/i.test(title)) continue;
          if (classifyImage({ fileName: fileNameOf(title) }) === "reject") continue;
          files.push(title);
        }
      }
      if (files.length === 0) return null;
      const batch = files.slice(0, IMAGEINFO_BATCH);
      const info = (await wikiGet(
        `${api}?action=query&prop=imageinfo&iiprop=url%7Csize%7Cmime&iiurlwidth=${SIZE_WIDTHS[size].x1}` +
          `&titles=${encodeURIComponent(batch.join("|"))}${common}`,
      )) as { query?: { pages?: unknown } } | null;
      const infoPages = Array.isArray(info?.query?.pages) ? (info!.query!.pages as unknown[]) : [];
      const byTitle = new Map<string, { url: string; width: number }>();
      for (const p of infoPages) {
        const page = p as { title?: unknown; imageinfo?: unknown } | null;
        const ii = Array.isArray(page?.imageinfo) ? (page!.imageinfo as unknown[])[0] : undefined;
        const meta = ii as { url?: unknown; width?: unknown; height?: unknown; mime?: unknown } | undefined;
        if (!page || typeof page.title !== "string" || !meta) continue;
        if (typeof meta.url !== "string" || typeof meta.width !== "number" || typeof meta.height !== "number") continue;
        if (typeof meta.mime !== "string" || !RASTER_MIME.test(meta.mime)) continue;
        if (meta.width < MIN_USABLE_WIDTH) continue;
        if (meta.width < meta.height) continue; // portrait
        byTitle.set(page.title, { url: meta.url, width: meta.width });
      }
      const usable: { url: string; srcset?: string }[] = [];
      for (const t of batch) {
        const m = byTitle.get(t);
        if (!m) continue;
        if (classifyImage({ fileName: fileNameOf(t), url: m.url }) === "reject") continue;
        const thumbs = thumbsFromOriginal(m.url, m.width, size);
        if (thumbs !== null) usable.push(thumbs);
      }
      return pick(usable, slotN) ?? null;
    };

    // ---- Run the sources in order ------------------------------------------------
    let result: DestinationImageResult;
    const places = await placesPhoto();
    if (places !== null) {
      result = { ...places, source: "places" };
    } else if (now() < wikiBackoffUntil()) {
      return { url: null, reason: "rate-limited" };
    } else {
      const tourism = await tourismPage();
      if (tourism !== null) {
        result = { ...tourism, source: "tourism-page" };
      } else {
        const own = await destinationPage();
        result = own !== null ? { ...own, source: "destination-page" } : { url: null, reason: "no-representative-image" };
      }
    }
    cache.set(key, result, result.url === null ? NO_IMAGE_CACHE_TTL_MS : DESTINATION_CACHE_TTL_MS, now());
    return result;
  } catch (e) {
    // Transient failures are returned and never cached.
    if (e instanceof Stop) return { url: null, reason: e.reason };
    return { url: null, reason: "upstream-error" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
