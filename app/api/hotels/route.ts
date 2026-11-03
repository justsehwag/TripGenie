import { NextRequest, NextResponse } from "next/server";
import {
  resolveLocation,
  searchHotels,
  haversineKm,
  type LatLng,
  type HotelResult,
} from "@/lib/providers/google-places";

/**
 * Hotels route (server-only) - lists real lodging near a destination via Google
 * Places Nearby Search (New), and labels each hotel's APPROXIMATE straight-line
 * distance (haversine, computed locally - no extra API, no cost) from each
 * planned itinerary spot. The key is read internally and never crosses the wire;
 * on any failure the route returns an empty list so the surface degrades.
 *
 * Query params:
 *   destination = free-text place (required) - the search center
 *   spots       = comma-separated itinerary place names (optional) - for distances
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const destination = (request.nextUrl.searchParams.get("destination") ?? "").trim();
  const spotsParam = (request.nextUrl.searchParams.get("spots") ?? "").trim();
  if (destination.length === 0) {
    return NextResponse.json({ hotels: [] }, { headers: { "Cache-Control": "no-store" } });
  }

  // 1) Fetch 30+ real hotels for the destination via paginated Text Search.
  const hotels = await searchHotels(destination, 30);
  if (hotels.length === 0) {
    return NextResponse.json({ hotels: [] }, { headers: { "Cache-Control": "no-store" } });
  }

  // 3) Resolve each spot's coordinates (bounded, in parallel) so we can label
  //    an approximate distance from every hotel to every spot.
  const spotNames = spotsParam
    ? spotsParam.split(",").map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 8)
    : [];
  const spotCoords: Array<{ name: string; loc: LatLng }> = [];
  if (spotNames.length > 0) {
    const resolved = await Promise.all(
      spotNames.map(async (name) => {
        const loc = await resolveLocation(name + " " + destination);
        return loc ? { name, loc } : null;
      }),
    );
    for (const r of resolved) if (r) spotCoords.push(r);
  }

  // 4) Attach approximate distances to each hotel.
  const withDistances = hotels.map((h: HotelResult) => ({
    placeId: h.placeId,
    name: h.name,
    rating: h.rating,
    userRatingCount: h.userRatingCount,
    priceLevel: h.priceLevel,
    address: h.address,
    photos: h.photos.map((p) => ({ src: `/api/place-photo?ref=${encodeURIComponent(p.name)}`, attribution: p.attribution ?? "Google" })),
    distances:
      h.location && spotCoords.length > 0
        ? spotCoords.map((s) => ({ spot: s.name, km: Math.round(haversineKm(h.location as LatLng, s.loc) * 10) / 10 }))
        : [],
  }));

  return NextResponse.json({ hotels: withDistances, provider: "Google" }, { headers: { "Cache-Control": "no-store" } });
}
