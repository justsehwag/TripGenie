import { NextRequest, NextResponse } from "next/server";
import { fetchFlightBookingOptions } from "@/lib/providers/serpapi-flights";

/**
 * Per-site booking options for one flight itinerary (Google Flights via SerpApi).
 *
 * GET /api/flight-fares/booking?bookingToken=&origin=&destination=&tripType=
 *     &departDate=&returnDate=&cabin=&travellers=
 *
 * Loaded lazily when a traveller opens "Compare & book" on a flight, so a search
 * costs one provider call and each comparison costs one more (protects the
 * monthly quota). The adapter validates every input and the booking token, and
 * returns only normalised, https-only options - the API key and provider URL
 * never appear in the response. Responses are not cached by the browser; the
 * adapter keeps its own short server-side cache and reports `checkedAt`.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const sp = request.nextUrl.searchParams;
  const travellers = Number.parseInt(sp.get("travellers") ?? "", 10);
  const tripType = (sp.get("tripType") ?? "").trim() === "round-trip" ? "round-trip" : "one-way";
  const returnDate = (sp.get("returnDate") ?? "").trim();
  const result = await fetchFlightBookingOptions({
    bookingToken: (sp.get("bookingToken") ?? "").trim(),
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
