import { NextRequest, NextResponse } from "next/server";
import { fetchDestination, fetchWeather, fetchCurrency } from "@/lib/live-data";
// Additive Google enrichment (google-places-integration task 6.1). The adapter
// is server-only, reads the key via googlePlacesApiKey() internally, and returns
// a labelled fallback rather than throwing, so it is safe to compose alongside
// the existing live-data signals (design "Components and Interfaces §5").
import { enrichPlace } from "@/lib/providers/google-places";
// Review attribution flows through the existing engine; no attribution logic is
// duplicated here (design §3 / §5).
import { summarizeReviews, toReviewPayload } from "@/lib/reviews";

/**
 * Place details route for the Discover search engine. Composes LIVE signals for
 * one place - a Wikipedia summary + prominent places, current weather (MET
 * Norway), and an FX rate quoted into INR (Frankfurter/ECB) - each via the
 * existing read-only lib/live-data adapters, which already return a labelled
 * fallback on failure/timeout (never throw). The dynamic, per-request result is
 * why the Discover surface feels fresh on every open.
 *
 * EXTENDED (google-places-integration): a fourth, parallel, server-only Google
 * enrichment call is added ALONGSIDE the untouched destination/weather/currency
 * signals. The resulting `google` block is strictly additive and independent -
 * a Google fallback does not affect the destination/weather/currency block, and
 * no API key, raw Google URL, or raw photo reference (beyond the opaque name
 * embedded inside the `/api/place-photo?ref=` proxy URL) ever appears in the
 * body (Req 1.4, 4.4, 4.5, 10.1).
 */

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const name = (request.nextUrl.searchParams.get("name") ?? "").trim();
  const currency = (request.nextUrl.searchParams.get("currency") ?? "").trim().toUpperCase();
  const attractionsOnly = request.nextUrl.searchParams.get("attractions") === "1";
  if (!name) {
    return NextResponse.json({ error: "A place name is required." }, { status: 400 });
  }

  const [destination, weather, fx, enrichment] = await Promise.all([
    fetchDestination(name),
    fetchWeather(name),
    currency ? fetchCurrency(currency, "INR") : Promise.resolve(null),
    // Req 4.1: additive, independent, never-throwing Google enrichment.
    enrichPlace({ query: name, includedType: attractionsOnly ? "tourist_attraction" : undefined }),
  ]);

  // Build the nullable `google` block ONLY when data is actually present
  // (mode "live" | "cached"). A Google fallback omits the block entirely so the
  // destination/weather/currency signals above are never affected (Req 2.3,
  // 4.4). The `enrichment.data` guard both satisfies the type (data is
  // `PlaceEnrichment | null`) and encodes the fallback contract.
  const google =
    (enrichment.mode === "live" || enrichment.mode === "cached") && enrichment.data
      ? {
          mode: enrichment.mode, // "live" | "cached" provenance (Req 7.1)
          provider: "Google" as const, // attribution (Req 7.2)
          rating: enrichment.data.rating,
          userRatingCount: enrichment.data.userRatingCount,
          priceLevel: enrichment.data.priceLevel,
          // ReviewSummary via the existing engine (Req 3.x, 7.3, 7.4).
          reviews: summarizeReviews(toReviewPayload(enrichment.data)),
          // Only the opaque proxy URL + Google's attribution cross the wire; the
          // raw photo reference never leaves the server except as the encoded
          // `ref` param of the server-mediated photo proxy (Req 1.4, 4.3).
          photos: enrichment.data.photos.map((p) => ({
            src: `/api/place-photo?ref=${encodeURIComponent(p.name)}`,
            attribution: p.attribution ?? "Google",
          })),
        }
      : null;

  return NextResponse.json(
    {
      name,
      retrievedAt: new Date().toISOString(),
      destination: { data: destination.data, mode: destination.mode, provider: destination.provider },
      weather: { data: weather.data, mode: weather.mode, provider: weather.provider },
      currency: fx
        ? { base: currency, quote: "INR", rate: fx.data.rate, mode: fx.mode, provider: fx.provider }
        : null,
      // Additive, nullable Google enrichment next to the existing fields (Req 4.2).
      google,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
