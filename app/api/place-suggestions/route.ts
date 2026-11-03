import { NextRequest, NextResponse } from "next/server";
import { suggestPlaces } from "@/lib/providers/google-places";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const q = (request.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length === 0) {
    return NextResponse.json({ suggestions: [] }, { headers: { "Cache-Control": "no-store" } });
  }
  const results = await suggestPlaces(q);
  const suggestions = results.map((s) => ({
    placeId: s.placeId,
    name: s.name,
    rating: s.rating,
    userRatingCount: s.userRatingCount,
    address: s.address,
    photo: s.photo ? { src: "/api/place-photo?ref=" + encodeURIComponent(s.photo.name), attribution: s.photo.attribution ?? "Google" } : null,
  }));
  return NextResponse.json({ suggestions, provider: "Google" }, { headers: { "Cache-Control": "no-store" } });
}
