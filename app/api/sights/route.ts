import { NextRequest, NextResponse } from "next/server";
import { resolveSights, type Sight } from "@/lib/sights";

/**
 * Sights / Discover route (App Router) over the pure lib/sights.ts engine.
 *
 * Returns EXACTLY six destination-restricted sights (FR-13). The per-sight live
 * overlay reads a Wikipedia REST summary with a hard timeout; any failure or
 * timeout leaves the curated seed in place (labelled fallback, mode "curated"),
 * so the surface is never blank and never throws (FR-17 parity).
 */

export const dynamic = "force-dynamic";

const USER_AGENT = "TripGenie/1.0 (sights discovery)";

async function wikiSummary(name: string): Promise<{ description?: string; sourceUrl?: string | null } | null> {
  try {
    const title = encodeURIComponent(name.trim().replace(new RegExp("\\s+", "g"), "_"));
    const url = "https://en.wikipedia.org/api/rest_v1/page/summary/" + title;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        extract?: string;
        content_urls?: { desktop?: { page?: string } };
      };
      const description = typeof data.extract === "string" ? data.extract.slice(0, 180) : undefined;
      const sourceUrl = data.content_urls?.desktop?.page ?? null;
      if (!description && !sourceUrl) return null;
      return { description, sourceUrl };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const city = (
    request.nextUrl.searchParams.get("destination") ??
    request.nextUrl.searchParams.get("city") ??
    ""
  ).trim();
  if (!city) {
    return NextResponse.json({ error: "A destination is required." }, { status: 400 });
  }
  const enrich = (sight: Sight) => wikiSummary(sight.name);
  const result = await resolveSights(city, enrich);
  return NextResponse.json(result, { headers: { "Cache-Control": "public, max-age=3600" } });
}