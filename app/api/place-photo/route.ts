import { type NextRequest } from "next/server";
import { googlePlacesApiKey } from "@/lib/config";

/**
 * Place-photo proxy route (server-side media proxy for Google Place Photos (New)).
 *
 * Turns an opaque Google photo resource name ("places/XXX/photos/YYY") into a
 * displayable image WITHOUT ever exposing the API key to the browser. It mirrors
 * the Imagery_Service posture in app/api/image/route.ts + lib/imagery.ts: the
 * request is server-mediated, bounded, and allowlisted — only the enumerated
 * Google media endpoint is contacted, the `ref` is validated against a strict
 * resource-name shape to prevent SSRF/path abuse, and the width is clamped.
 *
 * The API key is sent exclusively via the `X-Goog-Api-Key` request header (never
 * in the URL) and NEVER appears in the response headers, body, or any error
 * output. Only the upstream image bytes, their Content-Type, and a cache header
 * cross the wire. On ANY failure (missing ref/key, bad shape, non-ok upstream,
 * network error, or timeout) the route degrades quietly to a 404 so the caller
 * renders its existing /api/image fallback (Req 1.4, 4.3, 4.4, 5.2, 5.3).
 *
 * Design: Components and Interfaces §5 (app/api/place-photo route).
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Cache header mirrors the imagery route (public, one day). */
const CACHE_CONTROL = "public, max-age=86400";

/** Bounded width for the proxied media, per the server-mediated posture. */
const MIN_WIDTH = 100;
const MAX_WIDTH = 1600;
const DEFAULT_WIDTH = 640;

/** Upstream timeout — same ≤5s discipline as lib/live-data.ts. */
const TIMEOUT_MS = 5000;

/**
 * Strict Google photo resource-name shape: "places/<id>/photos/<id>" with no
 * further path segments. Anything else (arbitrary URLs, extra slashes, path
 * traversal) is rejected so the route can only ever address the Google media
 * endpoint for a legitimate photo reference.
 */
const PHOTO_REF_PATTERN = /^places\/[^/]+\/photos\/[^/]+$/;

/** Clamp a raw `w` query param into [MIN_WIDTH, MAX_WIDTH], defaulting safely. */
function clampWidth(value: string | null): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.trunc(n)));
}

export async function GET(request: NextRequest): Promise<Response> {
  const ref = (request.nextUrl.searchParams.get("ref") ?? "").trim();
  const key = googlePlacesApiKey();

  // Degrade quietly: no ref or no configured key means no Google photo. The
  // caller shows its existing /api/image fallback (Req 4.4, 5.3). Never echo ref.
  if (!ref || !key) return new Response(null, { status: 404 });

  // Validate the ref shape minimally to prevent SSRF/path abuse. Only a genuine
  // Google photo resource name is permitted; arbitrary URLs are rejected.
  if (!PHOTO_REF_PATTERN.test(ref)) return new Response(null, { status: 404 });

  const width = clampWidth(request.nextUrl.searchParams.get("w"));
  // The key travels in the X-Goog-Api-Key header only; it is never in this URL.
  const mediaUrl = `https://places.googleapis.com/v1/${ref}/media?maxWidthPx=${width}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(mediaUrl, {
      headers: { "X-Goog-Api-Key": key },
      signal: controller.signal,
    });
    if (!upstream.ok || !upstream.body) return new Response(null, { status: 404 });

    // Stream the image bytes back. Only the content type + cache header are
    // surfaced; no upstream credential, URL, or Google header is forwarded.
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg",
        "Cache-Control": CACHE_CONTROL,
      },
    });
  } catch {
    // Timeout, network error, or any other failure degrades to a quiet 404.
    return new Response(null, { status: 404 });
  } finally {
    clearTimeout(timer);
  }
}
