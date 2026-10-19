import { NextRequest, NextResponse } from "next/server";
import { fetchCurrency } from "@/lib/live-data";

/**
 * Read-only currency conversion adapter (Req 10.3, 10.5). Returns the
 * {@link import("@/lib/live-data").LiveResult} with its mode/provider; the lib
 * yields a labelled fallback (mode "fallback", rate 1) on failure/timeout which
 * is a successful labelled result and is passed through with 200 (Req 10.4).
 */
export async function GET(request: NextRequest) {
  const from = (request.nextUrl.searchParams.get("from") ?? "").trim();
  const to = (request.nextUrl.searchParams.get("to") ?? "").trim();
  if (!from || !to) {
    return NextResponse.json(
      { error: "Both 'from' and 'to' currency codes are required." },
      { status: 400 },
    );
  }
  const result = await fetchCurrency(from, to);
  return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
}
