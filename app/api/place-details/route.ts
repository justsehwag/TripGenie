import { NextRequest, NextResponse } from "next/server";
import { fetchDestination, fetchWeather, fetchCurrency } from "@/lib/live-data";

/**
 * Place details route for the Discover search engine. Composes LIVE signals for
 * one place - a Wikipedia summary + prominent places, current weather (MET
 * Norway), and an FX rate quoted into INR (Frankfurter/ECB) - each via the
 * existing read-only lib/live-data adapters, which already return a labelled
 * fallback on failure/timeout (never throw). The dynamic, per-request result is
 * why the Discover surface feels fresh on every open.
 */

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const name = (request.nextUrl.searchParams.get("name") ?? "").trim();
  const currency = (request.nextUrl.searchParams.get("currency") ?? "").trim().toUpperCase();
  if (!name) {
    return NextResponse.json({ error: "A place name is required." }, { status: 400 });
  }

  const [destination, weather, fx] = await Promise.all([
    fetchDestination(name),
    fetchWeather(name),
    currency ? fetchCurrency(currency, "INR") : Promise.resolve(null),
  ]);

  return NextResponse.json(
    {
      name,
      retrievedAt: new Date().toISOString(),
      destination: { data: destination.data, mode: destination.mode, provider: destination.provider },
      weather: { data: weather.data, mode: weather.mode, provider: weather.provider },
      currency: fx
        ? { base: currency, quote: "INR", rate: fx.data.rate, mode: fx.mode, provider: fx.provider }
        : null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}