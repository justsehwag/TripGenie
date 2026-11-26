import { NextRequest, NextResponse } from "next/server";
import { autocompletePlaces, searchCandidatesText } from "@/lib/providers/google-places";

/**
 * Typo-correction suggestions for place inputs (server-only). Tries Places
 * Autocomplete first; when that returns nothing and the query is at least 4
 * characters, falls back to a Text Search (max 3). Only `placeId` and a text
 * label are returned. The key is read inside the adapter and never crosses the
 * wire. Without a key the adapters return nothing, so the response is an empty
 * list and no request is made. Never throws.
 */
export const dynamic = "force-dynamic";

const MAX_QUERY_LENGTH = 80;
const MIN_FALLBACK_LENGTH = 4;
const MAX_SUGGESTIONS = 5;
const MAX_TEXT_SEARCH = 3;

interface Suggestion {
  placeId: string;
  label: string;
}

function respond(suggestions: Suggestion[]): NextResponse {
  return NextResponse.json({ suggestions }, { headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const raw = request.nextUrl.searchParams.get("q") ?? "";
  // Strip control characters, collapse whitespace, trim, cap length.
  // eslint-disable-next-line no-control-regex
  const q = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH).trim();
  if (q.length === 0) return respond([]);

  try {
    const predictions = await autocompletePlaces(q);
    const fromAutocomplete: Suggestion[] = [];
    for (const p of predictions) {
      if (!p.placeId || !p.text) continue;
      fromAutocomplete.push({ placeId: p.placeId, label: p.text });
      if (fromAutocomplete.length >= MAX_SUGGESTIONS) break;
    }
    if (fromAutocomplete.length > 0) return respond(fromAutocomplete);

    if (q.length < MIN_FALLBACK_LENGTH) return respond([]);

    const lookup = await searchCandidatesText(q, undefined, { maxResults: MAX_TEXT_SEARCH });
    if (lookup.kind !== "ok") return respond([]);
    const fromText: Suggestion[] = [];
    for (const c of lookup.candidates) {
      if (!c.placeId || !c.name) continue;
      const label = c.address && !c.address.includes(c.name) ? `${c.name}, ${c.address}` : c.address || c.name;
      fromText.push({ placeId: c.placeId, label });
      if (fromText.length >= MAX_TEXT_SEARCH) break;
    }
    return respond(fromText);
  } catch {
    return respond([]);
  }
}
