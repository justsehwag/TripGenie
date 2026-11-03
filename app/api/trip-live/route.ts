import { NextRequest, NextResponse } from "next/server";
import { searchHotelRates } from "@/lib/providers/serpapi-hotels";
import { searchFlightFares } from "@/lib/providers/serpapi-flights";

/**
 * Combined live stays + flights for a generated trip (Google Hotels and Google
 * Flights via SerpApi). The planner calls this once an itinerary is ready, so
 * the trip page can show real hotel and flight prices for the captured route
 * and dates.
 *
 * GET /api/trip-live?origin=&destination=&checkIn=&checkOut=&travellers=&cabin=&tripType=
 *
 * Both lookups run server-side (the adapters are server-only) and each returns
 * a labelled status; the API key and provider URL never reach the response. A
 * trip that produces an itinerary therefore costs at most two provider searches
 * (one stays, one flights), both protected by the shared cache and usage guard.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const sp = request.nextUrl.searchParams;
  const origin = (sp.get("origin") ?? "").trim();
  const destination = (sp.get("destination") ?? "").trim();
  const checkIn = (sp.get("checkIn") ?? "").trim();
  const checkOut = (sp.get("checkOut") ?? "").trim();
  const cabin = (sp.get("cabin") ?? "economy").trim() || "economy";
  const tripType = (sp.get("tripType") ?? "round-trip").trim() === "one-way" ? "one-way" : "round-trip";
  const t = Number.parseInt(sp.get("travellers") ?? "", 10);
  const travellers = Number.isFinite(t) && t >= 1 && t <= 9 ? t : 1;

  const [stays, flights] = await Promise.all([
    searchHotelRates({ destination, checkIn, checkOut, adults: travellers }),
    searchFlightFares({
      origin,
      destination,
      tripType,
      departDate: checkIn,
      returnDate: tripType === "round-trip" ? checkOut : undefined,
      cabin,
      adults: travellers,
    }),
  ]);

  return NextResponse.json({ stays, flights }, { headers: { "Cache-Control": "no-store" } });
}