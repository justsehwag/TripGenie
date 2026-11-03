import { NextRequest, NextResponse } from "next/server";
import { fetchHotelOffers } from "@/lib/providers/serpapi-hotels";

/**
 * Per-site booking offers for one hotel (Google Hotels via SerpApi).
 *
 * GET /api/hotel-rates/offers?token=&destination=&checkIn=&checkOut=&adults=
 *
 * Loaded lazily when a traveller opens "Compare & book" on a hotel, so a search
 * costs one provider call and each comparison costs one more (protects the
 * monthly quota). The adapter validates every input and returns only
 * normalised, https-only offers - the API key never appears in the response.
 * Responses are not cached by the browser; the adapter keeps its own short
 * server-side cache and reports `checkedAt`.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const sp = request.nextUrl.searchParams;
  const adults = Number.parseInt(sp.get("adults") ?? "", 10);
  const result = await fetchHotelOffers({
    token: (sp.get("token") ?? "").trim(),
    destination: (sp.get("destination") ?? "").trim(),
    checkIn: (sp.get("checkIn") ?? "").trim(),
    checkOut: (sp.get("checkOut") ?? "").trim(),
    adults: Number.isFinite(adults) ? adults : 0,
  });
  const status = result.status === "invalid" ? 400 : 200;
  return NextResponse.json(result, { status, headers: { "Cache-Control": "no-store" } });
}