import { NextResponse, type NextRequest } from "next/server";
import {
  resolveImage,
  boundedSearchQuery,
  type ImageKind,
  isAllowedImageUrl,
  isAllowedResultUrl,
  type ImageRequest,
} from "@/lib/imagery";
import { resolveWikiImage, type WikiReason } from "@/lib/wiki-image";
import { parseSizeClass, type SizeClass } from "@/lib/wiki-image-policy";

/**
 * Imagery route (thin App Router edge).
 *
 * With a provider candidate `url`, the pure resolveImage owns labelling and
 * allowlist gating. Without one, lib/wiki-image.ts resolves a Wikipedia
 * thumbnail. The route never substitutes a stock or bundled photograph for a
 * named place: when no real image exists it answers `url: null` with a reason
 * and the client shows its Image_Fallback (Req 11.5, 11.6, 11.7).
 */

export const dynamic = "force-dynamic";

const CACHE_PUBLIC = { "Cache-Control": "public, max-age=86400" } as const;
/** Definitive "no representative image": cacheable for 1 h, matching the server cache. */
const CACHE_SHORT = { "Cache-Control": "public, max-age=3600" } as const;
const CACHE_NONE = { "Cache-Control": "no-store" } as const;

/** Transient failures must not stick in browser or CDN caches. */
const TRANSIENT: readonly WikiReason[] = ["timeout", "rate-limited", "upstream-error"];

const KINDS: readonly ImageKind[] = ["attraction", "hotel", "destination"];

function isImageKind(value: unknown): value is ImageKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

function clampSlot(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

interface ParsedImageRequest {
  request: ImageRequest;
  size: SizeClass;
  candidate?: { url: string; exactProperty?: boolean };
}

function parseBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return false;
}

function parse(raw: Record<string, unknown>): ParsedImageRequest | null {
  if (!isImageKind(raw.kind)) return null;
  const query = boundedSearchQuery(typeof raw.query === "string" ? raw.query : "");
  if (query.length === 0) return null;
  const request: ImageRequest = { kind: raw.kind, query, slot: clampSlot(raw.slot) };
  const candidateUrl = typeof raw.url === "string" ? raw.url.trim() : "";
  const candidate = candidateUrl.length > 0 ? { url: candidateUrl, exactProperty: parseBool(raw.exactProperty) } : undefined;
  return { request, size: parseSizeClass(raw.size), candidate };
}

function recordFromSearchParams(params: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

const BAD_REQUEST = {
  error: "An image request requires a kind (attraction|hotel|destination) and a query.",
} as const;

/** True when every "<url> <descriptor>" entry of a srcset passes isAllowedResultUrl. */
function srcsetUrlsAllowed(srcset: string): boolean {
  const parts = srcset.split(/,\s+/).map((p) => p.trim());
  if (parts.length === 0 || parts.some((p) => p === "")) return false;
  return parts.every((p) => {
    const url = p.split(/\s+/)[0];
    return isAllowedResultUrl(url);
  });
}

function noImage(query: string, reason: WikiReason): NextResponse {
  const headers = TRANSIENT.includes(reason)
    ? CACHE_NONE
    : reason === "no-representative-image"
      ? CACHE_SHORT
      : CACHE_PUBLIC;
  return NextResponse.json(
    { url: null, label: query, representative: false, source: "none", reason },
    { status: 200, headers },
  );
}

async function respond(parsed: ParsedImageRequest): Promise<NextResponse> {
  const { request, candidate } = parsed;

  if (candidate) {
    const result = resolveImage(request, candidate);
    // A rejected candidate must not turn into a bundled photo for a named place.
    if (result.source === "local-fallback") return noImage(request.query, "rejected-url");
    return NextResponse.json(result, { headers: CACHE_PUBLIC });
  }

  const wiki = await resolveWikiImage(request.query, {
    size: parsed.size,
    slot: request.slot,
    kind: request.kind,
  });
  if (wiki.url === null) return noImage(request.query, wiki.reason);
  const srcset =
    typeof wiki.srcset === "string" && srcsetUrlsAllowed(wiki.srcset) ? wiki.srcset : undefined;

  // A same-origin place-photo URL is not on the host allowlist: gate it by shape.
  if (!isAllowedImageUrl(wiki.url)) {
    if (!isAllowedResultUrl(wiki.url)) return noImage(request.query, "rejected-url");
    const isStay = request.kind === "hotel" || request.kind === "destination";
    return NextResponse.json(
      {
        url: wiki.url,
        label: isStay ? `Representative ${request.query} image` : request.query,
        representative: isStay,
        source: "resolved",
        ...(srcset ? { srcset } : {}),
      },
      { headers: CACHE_PUBLIC },
    );
  }

  const result = resolveImage(request, { url: wiki.url, exactProperty: false });
  if (result.source === "local-fallback") return noImage(request.query, "rejected-url");
  return NextResponse.json(srcset ? { ...result, srcset } : result, { headers: CACHE_PUBLIC });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const parsed = parse(recordFromSearchParams(request.nextUrl.searchParams));
  if (!parsed) return NextResponse.json(BAD_REQUEST, { status: 400 });
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
  if (!parsed) return NextResponse.json(BAD_REQUEST, { status: 400 });
  return respond(parsed);
}
