import { wikimediaContact } from "./config";
import { isAllowedImageUrl } from "./imagery";
import {
  MIN_USABLE_WIDTH,
  buildSrcSet,
  chooseWidths,
  classifyImage,
  smallestStandardAtLeast,
  type SizeClass,
} from "./wiki-image-policy";

/**
 * Wiki_Image_Resolver (server). Requirement 11.
 * Search first (REST title search, then full-text search), then request the
 * summary of a title taken from a search result, never from the raw query.
 * Returns thumbnails at standard widths only (see wiki-image-policy), skips
 * flags, emblems, maps, logos and SVGs. Never throws, never returns a
 * substitute photograph.
 */

export type WikiReason =
  | "no-page"
  | "no-thumbnail"
  | "rejected-url"
  | "timeout"
  | "rate-limited"
  | "upstream-error"
  | "no-representative-image";

export type WikiImageResult = { url: string; srcset?: string } | { url: null; reason: WikiReason };

export interface WikiDeps {
  /** Size class that decides the 1x and 2x widths. Default "card". */
  size?: SizeClass;
  /** Image kind. "destination" is delegated to lib/destination-image.ts. */
  kind?: "attraction" | "hotel" | "destination";
  /** Slot used to vary the pick for destination images. Default 0. */
  slot?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  contact?: string;
  /** Overall timeout for search and summary together. Default 6,000 ms. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_RETRY_SECONDS = 60;
const MAX_RETRY_SECONDS = 300;
const MIN_WIDTH = 320;
const MAX_WIDTH = 960;
const TARGET_WIDTH = 640;
const NON_PLACE_TITLE = /^(flag of|coat of arms of|emblem of|seal of|map of|list of|geography of)\b/i;
const MAX_QUERY_CHARS = 100;
const MAX_SUMMARY_REQUESTS = 2;
const DISAMBIGUATION = /disambiguation|may refer to/i;
const ALLOWED_EXTENSIONS = /\.(jpe?g|png|webp)$/i;

/** Module-level back-off: no Wikimedia request before this time (ms). */
let retryUntil = 0;

/** Test helper: clear the module-level back-off. */
export function resetWikiImageBackoff(): void {
  retryUntil = 0;
}

/** Shared back-off, read by lib/destination-image.ts so both resolvers honour one 429. */
export function wikiBackoffUntil(): number {
  return retryUntil;
}

export function setWikiBackoffUntil(ms: number): void {
  retryUntil = ms;
}

export function wikimediaUserAgent(contact: string): string {
  return `TripGenie/1.0 (${contact})`;
}

/** True for page titles that are not a place: flags, arms, emblems, seals, maps, lists, geography. */
function isNonPlaceTitle(title: string): boolean {
  return NON_PLACE_TITLE.test(title.replace(/_/g, " ").trim());
}

/** Replaces the "<n>px-" segment of a thumbnail URL. null when there is none. */
function withWidth(src: string, width: number): string | null {
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    return null;
  }
  const m = /(\d+)px-([^/]+)$/.exec(u.pathname);
  if (!m) return null;
  u.pathname = `${u.pathname.slice(0, m.index)}${width}px-${m[2]}`;
  return u.toString();
}

/**
 * Pure. Picks standard 1x/2x widths for a summary thumbnail and builds the URLs.
 * With an unknown original width a non-standard thumbnail width is rounded up to
 * the next standard width. null when no usable width exists.
 */
function pickThumbnails(
  src: string,
  thumbWidth: number,
  originalWidth: number | undefined,
  size: SizeClass,
): { url: string; srcset?: string } | null {
  let widths = chooseWidths(size, originalWidth, thumbWidth);
  if (widths === null && originalWidth === undefined && Number.isFinite(thumbWidth)) {
    const std = smallestStandardAtLeast(thumbWidth);
    if (std !== null && std >= MIN_USABLE_WIDTH) widths = { x1: std };
  }
  if (widths === null) return null;
  const x1 = withWidth(src, widths.x1);
  if (x1 === null || !acceptImageUrl(x1)) return null;
  let x2: string | undefined;
  if (widths.x2 !== undefined) {
    const c = withWidth(src, widths.x2);
    if (c === null || !acceptImageUrl(c)) return null;
    x2 = c;
  }
  const srcset = buildSrcSet(x1, x2);
  return srcset ? { url: x1, srcset } : { url: x1 };
}

/**
 * Pure. First item of a REST media-list body that classifyImage accepts, sized
 * through the policy. Items: { title: "File:X.jpg", type: "image", srcset: [{ src, scale }] }.
 * Entries with protocol-relative "//host/..." sources get https. Items with no
 * "<n>px-" thumbnail (unscaled originals) are skipped.
 */
function pickFromMediaList(body: unknown, size: SizeClass): { url: string; srcset?: string } | null {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return null;
  for (const it of items) {
    const item = it as { title?: unknown; type?: unknown; srcset?: unknown } | null;
    if (!item || item.type !== "image" || typeof item.title !== "string") continue;
    if (!Array.isArray(item.srcset)) continue;
    const fileName = item.title.replace(/^[^:]*:/, "");
    if (classifyImage({ fileName }) === "reject") continue;
    // The widest listed thumbnail is a lower bound of the original width.
    let best: { src: string; width: number } | null = null;
    for (const e of item.srcset) {
      const raw = (e as { src?: unknown } | null)?.src;
      if (typeof raw !== "string") continue;
      const src = raw.startsWith("//") ? `https:${raw}` : raw;
      const m = /(\d+)px-[^/]+$/.exec(src.split(/[?#]/)[0]);
      if (!m) continue;
      const width = Number(m[1]);
      if (best === null || width > best.width) best = { src, width };
    }
    if (best === null) continue;
    const picked = pickThumbnails(best.src, best.width, best.width, size);
    if (picked !== null) return picked;
  }
  return null;
}

/**
 * Pure. https, host allowed by isAllowedImageUrl, extension jpg/jpeg/png/webp
 * (case and query ignored), no ".svg" in the path, and the file name is not a
 * flag, emblem, map or logo.
 */
export function acceptImageUrl(url: unknown): url is string {
  if (typeof url !== "string" || url === "") return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (!isAllowedImageUrl(url)) return false;
  if (!ALLOWED_EXTENSIONS.test(u.pathname)) return false;
  let decoded = u.pathname;
  try {
    decoded = decodeURIComponent(u.pathname);
  } catch {
    /* keep the raw path */
  }
  if (/\.svg/i.test(u.pathname) || /\.svg/i.test(decoded)) return false;
  return classifyImage({ url }) === "accept";
}

/**
 * Pure. Rewrites the "<n>px-" thumb segment into 320..960 (target 640). null when impossible.
 * @deprecated Kept for existing tests. The resolver uses chooseWidths from wiki-image-policy.
 */
export function sizeThumbnail(
  src: string,
  thumbWidth: number,
  originalWidth: number | undefined,
): string | null {
  if (typeof src !== "string" || src === "") return null;
  if (typeof thumbWidth === "number" && thumbWidth >= MIN_WIDTH && thumbWidth <= MAX_WIDTH) {
    return src;
  }
  const knownOriginal =
    typeof originalWidth === "number" && Number.isFinite(originalWidth) ? originalWidth : undefined;
  // Wikimedia refuses to upscale: the original must be wide enough.
  if (knownOriginal !== undefined && knownOriginal < TARGET_WIDTH) return null;
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    return null;
  }
  const m = /(\d+)px-([^/]+)$/.exec(u.pathname);
  if (!m) return null;
  u.pathname = u.pathname.slice(0, m.index) + `${TARGET_WIDTH}px-${m[2]}`;
  return u.toString();
}

/** Pure. Seconds or HTTP date, capped at 300; 60 when absent or invalid. */
export function parseRetryAfter(h: string | null, nowMs: number): number {
  if (typeof h !== "string") return DEFAULT_RETRY_SECONDS;
  const v = h.trim();
  if (v === "") return DEFAULT_RETRY_SECONDS;
  if (/^\d+$/.test(v)) {
    const s = Number(v);
    return Number.isFinite(s) ? Math.min(s, MAX_RETRY_SECONDS) : DEFAULT_RETRY_SECONDS;
  }
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return DEFAULT_RETRY_SECONDS;
  const secs = Math.ceil((t - nowMs) / 1000);
  return Math.min(Math.max(secs, 0), MAX_RETRY_SECONDS);
}

/** Internal control-flow signal carrying a reason. */
class WikiStop {
  constructor(readonly reason: WikiReason) {}
}

function cleanQuery(q: unknown): string {
  if (typeof q !== "string") return "";
  return q.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS).trim();
}

function titleKey(t: string): string {
  return encodeURIComponent(t.replace(/ /g, "_"));
}

export async function resolveWikiImage(
  query: string,
  deps: WikiDeps = {},
): Promise<WikiImageResult> {
  const now = deps.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    const q = cleanQuery(query);
    if (q === "") return { url: null, reason: "no-page" };
    if (now() < retryUntil) return { url: null, reason: "rate-limited" };

    if (deps.kind === "destination") {
      // Dynamic import: destination-image imports this module statically.
      const { resolveDestinationImage } = await import("./destination-image");
      const d = await resolveDestinationImage(q, deps.size ?? "card", deps.slot ?? 0, {
        fetchImpl: deps.fetchImpl,
        now: deps.now,
        contact: deps.contact,
        timeoutMs: deps.timeoutMs,
      });
      if (d.url === null) return { url: null, reason: d.reason };
      return d.srcset ? { url: d.url, srcset: d.srcset } : { url: d.url };
    }

    const fetchImpl = deps.fetchImpl ?? fetch;
    const contact = deps.contact ?? wikimediaContact();
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const headers = {
      "User-Agent": wikimediaUserAgent(contact),
      Accept: "application/json",
    };

    let timedOut = false;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new WikiStop("timeout"));
      }, timeoutMs);
    });
    // The race rejection is observed below; avoid an unhandled rejection otherwise.
    timeout.catch(() => undefined);

    /** One request: maps 429, 5xx and other failures to a WikiStop. Returns the Response. */
    const get = async (url: string): Promise<Response> => {
      let res: Response;
      try {
        res = await Promise.race([fetchImpl(url, { headers, signal: controller.signal }), timeout]);
      } catch (e) {
        if (e instanceof WikiStop) throw e;
        throw new WikiStop(timedOut ? "timeout" : "upstream-error");
      }
      if (res.status === 429) {
        const secs = parseRetryAfter(res.headers?.get?.("retry-after") ?? null, now());
        retryUntil = now() + secs * 1000;
        throw new WikiStop("rate-limited");
      }
      if (res.status >= 500) throw new WikiStop("upstream-error");
      return res;
    };

    const json = async (res: Response): Promise<unknown> => {
      try {
        return await Promise.race([res.json(), timeout]);
      } catch (e) {
        if (e instanceof WikiStop) throw e;
        throw new WikiStop(timedOut ? "timeout" : "upstream-error");
      }
    };

    const enc = encodeURIComponent(q);

    // Step 4: REST title search.
    const titles: string[] = [];
    {
      const res = await get(`https://en.wikipedia.org/w/rest.php/v1/search/title?q=${enc}&limit=3`);
      if (!res.ok) throw new WikiStop("upstream-error");
      const body = (await json(res)) as { pages?: unknown } | null;
      const pages = Array.isArray(body?.pages) ? (body!.pages as unknown[]) : [];
      for (const p of pages) {
        const page = p as { key?: unknown; title?: unknown; description?: unknown } | null;
        if (!page) continue;
        const desc = typeof page.description === "string" ? page.description : "";
        if (DISAMBIGUATION.test(desc)) continue;
        const pageName = typeof page.title === "string" ? page.title : typeof page.key === "string" ? page.key : "";
        if (isNonPlaceTitle(pageName)) continue;
        if (typeof page.key === "string" && page.key !== "") titles.push(encodeURIComponent(page.key));
        else if (typeof page.title === "string" && page.title !== "") titles.push(titleKey(page.title));
      }
    }

    // Step 5: full-text fallback, only when the title search gave nothing usable.
    if (titles.length === 0) {
      const res = await get(
        `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${enc}&srlimit=3&srnamespace=0&format=json&formatversion=2`,
      );
      if (!res.ok) throw new WikiStop("upstream-error");
      const body = (await json(res)) as { query?: { search?: unknown } } | null;
      const hits = Array.isArray(body?.query?.search) ? (body!.query!.search as unknown[]) : [];
      for (const h of hits) {
        const title = (h as { title?: unknown } | null)?.title;
        if (typeof title !== "string" || title === "") continue;
        if (/\(disambiguation\)/i.test(title)) continue;
        if (isNonPlaceTitle(title)) continue;
        titles.push(titleKey(title));
      }
    }
    if (titles.length === 0) return { url: null, reason: "no-page" };

    const size = deps.size ?? "card";
    let sawRejectedImage = false;

    // Step 6: summary of a title that came from a search result.
    for (const t of titles.slice(0, MAX_SUMMARY_REQUESTS)) {
      const res = await get(`https://en.wikipedia.org/api/rest_v1/page/summary/${t}`);
      if (res.status === 404) return { url: null, reason: "no-page" };
      if (!res.ok) throw new WikiStop("upstream-error");
      const s = (await json(res)) as {
        type?: unknown;
        title?: unknown;
        thumbnail?: { source?: unknown; width?: unknown } | null;
        originalimage?: { width?: unknown } | null;
      } | null;
      if (s && s.type === "disambiguation") continue;

      // Step 7: thumbnail.source only.
      const src = s?.thumbnail?.source;
      if (typeof src !== "string" || src === "") return { url: null, reason: "no-thumbnail" };
      const tw = typeof s?.thumbnail?.width === "number" ? s.thumbnail.width : NaN;
      const ow = typeof s?.originalimage?.width === "number" ? s.originalimage.width : undefined;
      // Flags, emblems, maps, logos and SVGs: try the next title.
      const summaryTitle = typeof s?.title === "string" ? s.title : undefined;
      if (summaryTitle !== undefined && isNonPlaceTitle(summaryTitle)) {
        sawRejectedImage = true;
        continue;
      }
      if (
        ALLOWED_EXTENSIONS.test(src.split(/[?#]/)[0]) &&
        classifyImage({ url: src, title: summaryTitle }) === "reject"
      ) {
        sawRejectedImage = true;
        // One extra request for this page: the first acceptable photo of its media list.
        const res2 = await get(`https://en.wikipedia.org/api/rest_v1/page/media-list/${t}`);
        if (res2.ok) {
          const photo = pickFromMediaList(await json(res2), size);
          if (photo !== null) return photo;
        }
        continue;
      }

      const picked = pickThumbnails(src, tw, ow, size);
      if (picked === null) {
        // A host or extension failure is rejected-url; an unusable width is no-thumbnail.
        if (!acceptImageUrl(src)) return { url: null, reason: "rejected-url" };
        return { url: null, reason: "no-thumbnail" };
      }
      return picked;
    }
    return { url: null, reason: sawRejectedImage ? "no-representative-image" : "no-page" };
  } catch (e) {
    if (e instanceof WikiStop) return { url: null, reason: e.reason };
    return { url: null, reason: "upstream-error" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
