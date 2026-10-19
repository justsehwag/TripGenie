import { NextResponse, type NextRequest } from "next/server";

import { runSearch, searchError, type SearchResult, type UpstreamCounts } from "@/lib/search";
import type { InventoryQuery } from "@/lib/inventory-adapter";
import {
  newTurnContext,
  runPlanningTurn,
  type PlanningTurnResult,
} from "@/lib/planning-turn";
import {
  advance,
  emptyControllerState,
  type ControllerState,
  type ExtractionModel,
  type RequiredField,
} from "@/lib/preference-controller";
import type { TripContext } from "@/lib/types";

/**
 * Search_API route handler (design section "Booking Site" / section 5).
 *
 * Thin App Router wrapper over the domain layer: it parses/validates the
 * request and delegates to `runSearch` (lib/search.ts) for the normalized
 * `SearchResult` — exactly min(6, available) per category with per-category
 * `partial` flags and the `confirmedDestination` retained. The search service
 * already owns the failure/timeout -> labelled-error contract (`searchError`),
 * so this handler never reimplements domain logic (Req 4.1-4.3).
 *
 * All secrets and upstream credentials stay server-side; only the normalized,
 * provenance-labelled `SearchResult` crosses the client/server boundary.
 */

export const dynamic = "force-dynamic";

/** Private, no-store: offers are time-bounded and must never be shared/cached. */
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

const MAX_PLACE = 100;

function clampString(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.slice(0, MAX_PLACE);
}

function optionalCount(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.trunc(n));
}

function clampNights(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 3;
  return Math.min(60, Math.max(1, Math.trunc(n)));
}

interface ParsedRequest {
  query: InventoryQuery;
  upstream: UpstreamCounts;
  /** Optional planning branch input delta; absent when only offers are requested. */
  inputDelta?: string;
}

/** Normalize a plain record (query params or JSON body) into a validated query. */
function parse(raw: Record<string, unknown>): ParsedRequest | null {
  const destination = clampString(raw.destination, "");
  if (!destination) return null;

  const query: InventoryQuery = {
    origin: clampString(raw.origin, ""),
    destination,
    cabin: clampString(raw.cabin, "Economy"),
    stayStyle: clampString(raw.stayStyle, "Comfort"),
    nights: clampNights(raw.nights),
  };

  const upstream: UpstreamCounts = {
    flights: optionalCount(raw.flights ?? raw.flightsAvailable),
    hotels: optionalCount(raw.hotels ?? raw.hotelsAvailable),
    places: optionalCount(raw.places ?? raw.placesAvailable),
  };

  const inputDelta =
    typeof raw.inputDelta === "string" && raw.inputDelta.trim().length > 0
      ? raw.inputDelta
      : undefined;

  return { query, upstream, inputDelta };
}

function recordFromSearchParams(params: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

/**
 * Server-side default extraction model for the optional planning branch.
 *
 * No Bedrock client is hardcoded here: the planning turn is driven through the
 * injected {@link ExtractionModel} interface (design section 2/19). Until a
 * credentialed model is wired at the edge, this stub extracts nothing (never
 * fabricating trip context) and phrases a neutral prompt, so the deterministic
 * controller still owns all control flow.
 */
const stubExtractionModel: ExtractionModel = {
  extract(): Partial<TripContext> {
    return {};
  },
  phrase(field: RequiredField): string {
    return `Tell me your ${field}.`.slice(0, 160);
  },
};

function statusForError(message: string): number {
  // Timeout maps to 504; any other labelled failure maps to 502. The labelled
  // body is still returned verbatim so the client can retry (Req 4.3).
  return /timeout|timed out|exceeded/i.test(message) ? 504 : 502;
}

/** Shape returned to the client: the SearchResult, plus an optional planning turn. */
interface SearchResponse extends SearchResult {
  planning?: PlanningTurnResult;
}

function handle(parsed: ParsedRequest): { body: SearchResponse; status: number } {
  let result: SearchResult;
  try {
    result = runSearch(parsed.query, parsed.upstream);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Search unavailable; please retry.";
    const labelled = searchError(parsed.query.destination, reason);
    return { body: labelled, status: statusForError(labelled.error ?? reason) };
  }

  if (result.error) {
    return { body: result, status: statusForError(result.error) };
  }

  const body: SearchResponse = result;

  // Optional, minimal planning branch: only engaged when an input delta is
  // supplied. Driven through the injected ExtractionModel; no model leakage.
  if (parsed.inputDelta !== undefined) {
    const state: ControllerState = seedControllerState(parsed.query);
    body.planning = runPlanningTurn(
      { state, inputDelta: parsed.inputDelta },
      stubExtractionModel,
      newTurnContext(),
    );
  }

  return { body, status: 200 };
}

/** Seed controller state from the confirmed route so the turn has context. */
function seedControllerState(query: InventoryQuery): ControllerState {
  const base = emptyControllerState();
  const context: TripContext = {
    ...base.context,
    origin: query.origin || base.context.origin,
    destination: query.destination,
  };
  // advance() with an empty delta is not needed here; return seeded state.
  void advance;
  return { ...base, context };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const parsed = parse(recordFromSearchParams(request.nextUrl.searchParams));
  if (!parsed) {
    return NextResponse.json(
      { error: "A destination is required to search." },
      { status: 400, headers: NO_STORE },
    );
  }
  const { body, status } = handle(parsed);
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let raw: Record<string, unknown>;
  try {
    const json = (await request.json()) as unknown;
    raw = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400, headers: NO_STORE },
    );
  }
  const parsed = parse(raw);
  if (!parsed) {
    return NextResponse.json(
      { error: "A destination is required to search." },
      { status: 400, headers: NO_STORE },
    );
  }
  const { body, status } = handle(parsed);
  return NextResponse.json(body, { status, headers: NO_STORE });
}
