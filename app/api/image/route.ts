import { NextResponse, type NextRequest } from "next/server";

import {
  resolveImage,
  boundedSearchQuery,
  type ImageKind,
  type ImageRequest,
  type ImageResult,
} from "@/lib/imagery";

/**
 * Imagery route handler (thin App Router edge over lib/imagery.ts) - design section 13.
 *
 * Parses an {@link ImageRequest} (kind, query, slot) plus an optional provider
 * candidate (url + exactProperty) and delegates resolution to `resolveImage`.
 * The domain layer owns every imagery rule:
 *   - allowlisted HTTPS hosts only (Req 11.3, via `isAllowedImageUrl`); a
 *     non-allowlisted candidate is never resolved and silently falls back;
 *   - slot-specific bundled local photograph on resolution failure (Req 11.5),
 *     rotating among exactly four photos per surface (Req 11.7);
 *   - hotel/destination imagery labelled representative unless an authorized
 *     exact-property image is supplied (Req 11.2);
 *   - no branded wordmark in fallbacks (Req 11.6).
 *
 * This handler never reimplements that logic. It only validates/normalizes the
 * request, surfaces the immediate-local-then-overlay contract to the client
 * (the returned `source` tells the client whether the URL is the bundled local
 * photo to render immediately or the resolved image to overlay, Req 11.4), and
 * returns the `ImageResult`. Server-side only; no secrets are read or emitted.
 */

export const dynamic = "force-dynamic";

/** Resolved imagery is derived from public, bounded inputs and may be cached. */
const CACHE = { "Cache-Control": "public, max-age=300" } as const;

const KINDS: readonly ImageKind[] = ["attraction", "hotel", "destination"];

function isImageKind(value: unknown): value is ImageKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

/** Normalize slot to a finite non-negative integer; default 0. The lib wraps it to one of four. */
function clampSlot(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

interface ParsedImageRequest {
  request: ImageRequest;
  candidate?: { url: string; exactProperty?: boolean };
}

/** Normalize a plain record (query params or JSON body) into a validated request. */
function parse(raw: Record<string, unknown>): ParsedImageRequest | null {
  if (!isImageKind(raw.kind)) return null;

  const rawQuery = typeof raw.query === "string" ? raw.query : "";
  const query = boundedSearchQuery(rawQuery);
  if (query.length === 0) return null;

  const request: ImageRequest = {
    kind: raw.kind,
    query,
    slot: clampSlot(raw.slot),
  };

  // Optional provider candidate. The lib gates it through the allowlist, so a
  // non-allowlisted host here is harmless (it is never resolved); we still only
  // forward a non-empty string to keep the contract explicit.
  const candidateUrl = typeof raw.url === "string" ? raw.url.trim() : "";
  const candidate =
    candidateUrl.length > 0
      ? { url: candidateUrl, exactProperty: parseBool(raw.exactProperty) }
      : undefined;

  return { request, candidate };
}

function parseBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return false;
}

function recordFromSearchParams(params: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

const BAD_REQUEST = {
  error: "An image request requires a kind (attraction|hotel|destination) and a query.",
} as const;

function respond(parsed: ParsedImageRequest): NextResponse {
  const result: ImageResult = resolveImage(parsed.request, parsed.candidate);
  return NextResponse.json(result, { headers: CACHE });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const parsed = parse(recordFromSearchParams(request.nextUrl.searchParams));
  if (!parsed) {
    return NextResponse.json(BAD_REQUEST, { status: 400 });
  }
  return respond(parsed);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let raw: Record<string, unknown>;
  try {
    const json = (await request.json()) as unknown;
    raw = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const parsed = parse(raw);
  if (!parsed) {
    return NextResponse.json(BAD_REQUEST, { status: 400 });
  }
  return respond(parsed);
}
