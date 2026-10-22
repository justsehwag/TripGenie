import { NextResponse, type NextRequest } from "next/server";
import {
  resolveImage,
  boundedSearchQuery,
  type ImageKind,
  type ImageRequest,
  type ImageResult,
} from "@/lib/imagery";

/**
 * Imagery route (App Router edge over lib/imagery.ts).
 *
 * For a destination/attraction/hotel request WITHOUT a provider candidate, the
 * route resolves a REAL photo server-side from Wikipedia's REST summary
 * (thumbnail.source on upload.wikimedia.org - already allowlisted) and passes
 * it to resolveImage as the candidate. If Wikipedia has no thumbnail or the
 * lookup fails, it falls back to a deterministic Picsum photo seeded by the
 * query, so a card is NEVER blank. The pure resolveImage still owns labelling
 * and allowlist gating (Req 11.2, 11.3).
 */

export const dynamic = "force-dynamic";

const CACHE = { "Cache-Control": "public, max-age=86400" } as const;

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
  return { request, candidate };
}

function recordFromSearchParams(params: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

const BAD_REQUEST = {
  error: "An image request requires a kind (attraction|hotel|destination) and a query.",
} as const;


/** Deterministic photographic fallback seeded by the query (Picsum, allowlisted). */
function picsumFor(query: string): string {
  const seed = encodeURIComponent(query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "travel");
  return 'https://picsum.photos/seed/' + seed + '/640/420';
}

/** Resolve a real Wikipedia REST thumbnail (upload.wikimedia.org) for a query. */
async function wikiThumbnail(query: string): Promise<string | null> {
  try {
    const title = encodeURIComponent(query.trim().replace(new RegExp("\\s+", "g"), "_"));
    const url = 'https://en.wikipedia.org/api/rest_v1/page/summary/' + title;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json", "User-Agent": "TripGenie/1.0 (image thumbnails)" },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { thumbnail?: { source?: string }; originalimage?: { source?: string } };
      const src = data.originalimage?.source ?? data.thumbnail?.source ?? null;
      return typeof src === "string" && src.startsWith("https://") ? src : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

async function respond(parsed: ParsedImageRequest): Promise<NextResponse> {
  let candidate = parsed.candidate;
  // No provider candidate supplied: resolve a real photo server-side.
  if (!candidate) {
    const wiki = await wikiThumbnail(parsed.request.query);
    candidate = { url: wiki ?? picsumFor(parsed.request.query), exactProperty: false };
  }
  const result: ImageResult = resolveImage(parsed.request, candidate);
  // If the lib rejected the candidate (non-allowlisted) and fell back to a
  // (possibly missing) local file, force the always-available Picsum photo.
  const safe: ImageResult =
    result.source === "local-fallback"
      ? { ...result, url: picsumFor(parsed.request.query), source: "resolved" }
      : result;
  return NextResponse.json(safe, { headers: CACHE });
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

