import { NextRequest, NextResponse } from "next/server";
import { autocompletePlaces } from "@/lib/providers/google-places";

/**
 * Place autocomplete route (server-only) - powers the Discover search box's
 * as-you-type suggestions. Delegates to the server-only `autocompletePlaces`
 * adapter, which reads the key internally and returns [] (never throws) on any
 * failure, so this route always responds with a well-formed JSON array and the
 * key never crosses the wire. Dynamic + no-store so every keystroke is fresh.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const q = (request.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length === 0) {
    return NextResponse.json({ predictions: [] }, { headers: { "Cache-Control": "no-store" } });
  }
  const predictions = await autocompletePlaces(q);
  return NextResponse.json({ predictions }, { headers: { "Cache-Control": "no-store" } });
}
