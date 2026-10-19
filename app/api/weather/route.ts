import { NextRequest, NextResponse } from "next/server";
import { fetchWeather } from "@/lib/live-data";

/**
 * Read-only weather adapter (Req 10.2, 10.5). Returns the
 * {@link import("@/lib/live-data").LiveResult} with its mode/provider; the lib
 * yields a labelled fallback (mode "fallback") on failure/timeout which is a
 * successful labelled result and is passed through with 200 (Req 10.4).
 */
export async function GET(request: NextRequest) {
  const dest = (
    request.nextUrl.searchParams.get("destination") ??
    request.nextUrl.searchParams.get("dest") ??
    ""
  ).trim();
  if (!dest) {
    return NextResponse.json({ error: "A destination is required." }, { status: 400 });
  }
  const result = await fetchWeather(dest);
  return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
}
