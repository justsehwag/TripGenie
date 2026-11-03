import { NextRequest, NextResponse } from "next/server";
import { fetchReturnFlights } from "@/lib/providers/serpapi-flights";

/**
 * Return-leg flight fares for one outbound itinerary (Google Flights via SerpApi).
 *
 * GET /api/flight-fares/returns?departureToken=&origin=&destination=&tripType=
 *     &departDate=&returnDate=&cabin=&travellers=
 *
 * Loaded lazily when a traveller opens the return leg for a live flight, so a
 * search costs one provider call and each return lookup costs one more (protects
 * the monthly quota). The adapter validates every input - including the opaque
 * departure token - and returns only normalised, https-only data; the provider
 * URL and API key never appear in the response. Responses are not cached by the
 * browser; the adapter keeps its own short server-side cache and reports
 * `checkedAt`.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const sp = request.nextUrl.searchParams;
  const travellers = Number.parseInt(sp.get("travellers") ?? "", 10);
  const tripType = (sp.get("tripType") ?? "").trim() === "one-way" ? "one-way" : "round-trip";
  const returnDate = (sp.get("returnDate") ?? "").trim();
  const result = await fetchReturnFlights({
    departureToken: (sp.get("departureToken") ?? "").trim(),
    origin: (sp.get("origin") ?? "").trim(),
    destination: (sp.get("destination") ?? "").trim(),
    tripType,
    departDate: (sp.get("departDate") ?? "").trim(),
    returnDate: returnDate || undefined,
    cabin: (sp.get("cabin") ?? "").trim(),
    adults: Number.isFinite(travellers) ? travellers : 0,
  });
  const status = result.status === "invalid" ? 400 : 200;
  return NextResponse.json(result, { status, headers: { "Cache-Control": "no-store" } });
}
