import { awsConfig } from "./config";

/**
 * Imagery Service (pure resolution core) - design section 13.
 * Ported from TripSaathi /api/image + /api/photo.
 * Allowlisted HTTPS hosts; slot-specific local fallback (one of 4); no wordmark.
 * Requirements: 11.1-11.7.
 */

export type ImageKind = "attraction" | "hotel" | "destination";

export interface ImageRequest {
  kind: ImageKind;
  query: string;
  slot: number;
}

export interface ImageResult {
  url: string;
  label: string;
  representative: boolean;
  source: "resolved" | "local-fallback";
  /** Optional responsive candidates, "<url> 1x, <url> 2x". */
  srcset?: string;
}

/** Slot is normalized into exactly four bundled photos per surface (Req 11.5/11.7). */
export function fallbackFor(kind: ImageKind, slot: number): string {
  const i = ((Math.trunc(slot) % 4) + 4) % 4;
  return `/${kind}-fallback${i ? `-${i + 1}` : ""}.jpg`;
}

/** Whether a resolved URL is an allowlisted HTTPS host (Req 11.3). */
export function isAllowedImageUrl(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return u.protocol === "https:" && awsConfig.imageHostAllowlist.includes(u.hostname);
}

const PLACE_PHOTO_REF_PATTERN = /^places\/[^/]+\/photos\/[^/]+$/;
const PLACE_PHOTO_MAX_WIDTH = 1600;

/**
 * Whether a result URL may be returned to the client: an allowlisted https
 * host, or the strict same-origin `/api/place-photo?ref=...&w=...` shape.
 */
export function isAllowedResultUrl(value: string): boolean {
  if (typeof value !== "string" || value === "") return false;
  if (isAllowedImageUrl(value)) return true;
  if (!value.startsWith("/api/place-photo?")) return false;
  let u: URL;
  try {
    u = new URL(value, "http://local.invalid");
  } catch {
    return false;
  }
  if (u.pathname !== "/api/place-photo") return false;
  const keys = Array.from(u.searchParams.keys());
  if (keys.some((k) => k !== "ref" && k !== "w")) return false;
  if (u.searchParams.getAll("ref").length !== 1) return false;
  if (u.searchParams.getAll("w").length > 1) return false;
  const ref = u.searchParams.get("ref") ?? "";
  if (!PLACE_PHOTO_REF_PATTERN.test(ref)) return false;
  const w = u.searchParams.get("w");
  if (w !== null) {
    if (!/^\d{1,4}$/.test(w)) return false;
    const n = Number(w);
    if (n < 1 || n > PLACE_PHOTO_MAX_WIDTH) return false;
  }
  return true;
}

/**
 * Resolve an image. When a candidate URL is provided and allowlisted, use it;
 * otherwise fall back to a slot-specific bundled photo. Hotel/destination
 * images are labelled representative unless an authorized exact image is given.
 */
export function resolveImage(
  req: ImageRequest,
  candidate?: { url: string; exactProperty?: boolean },
): ImageResult {
  const isStay = req.kind === "hotel" || req.kind === "destination";
  if (candidate && isAllowedImageUrl(candidate.url)) {
    const exact = Boolean(candidate.exactProperty);
    return {
      url: candidate.url,
      label: isStay && !exact ? `Representative ${req.query} image` : req.query,
      representative: isStay && !exact,
      source: "resolved",
    };
  }
  return {
    url: fallbackFor(req.kind, req.slot),
    label: isStay ? `Representative ${req.query} image` : req.query,
    representative: isStay,
    source: "local-fallback",
  };
}

/** Bounded Commons-style search URL (query capped at 100 chars). */
export function boundedSearchQuery(raw: string): string {
  return raw.trim().slice(0, 100);
}
