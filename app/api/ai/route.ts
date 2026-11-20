import { NextResponse } from "next/server";
import type { Itinerary, TripContext } from "@/lib/types";
import {
  type ControllerState,
  type RequiredField,
  uncollected,
} from "@/lib/preference-controller";
import { runPlanningTurn } from "@/lib/planning-turn";
import {
  createBedrockInvoke,
  extractAsync,
  phraseAsync,
  syncModelFrom,
  fallbackPhrase,
  fallbackExtractForField,
  type BedrockModelDeps,
} from "@/lib/bedrock-model";
import { groundExtraction } from "@/lib/extraction-grounding";
import { estimateMisc, validateMiscRequest } from "@/lib/itinerary/misc-estimate";
import { runPlacesFirstBatch } from "@/lib/itinerary/places-first-batch";
import {
  unavailable,
  validateBatchRequest,
  type BatchRequest,
  type BatchResponse,
} from "@/lib/itinerary/batch-wire";
import {
  BATCH_DAYS,
  BATCH_REQUEST_BUDGET_MS,
  MAX_TRIP_DAYS,
} from "@/lib/itinerary/constants";

/**
 * Bedrock_Route - server-only edge over the Bedrock_Model and the
 * deterministic preference controller. The controller owns all flow; the route
 * pre-resolves async extraction/phrasing consumed synchronously via
 * syncModelFrom. On any Bedrock failure the planner degrades to a deterministic
 * fallback and never returns a 500 (Req 2.4, 2.7, 2.8, 3.1, 3.2, 10.3).
 */

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

interface TurnBody {
  action: "turn";
  state: ControllerState;
  inputDelta: string;
}

interface ItineraryBody {
  action: "itinerary";
  context: TripContext;
}

function isControllerState(v: unknown): v is ControllerState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.context === "object" &&
    s.context !== null &&
    typeof s.questionsAsked === "number"
  );
}


async function handleTurn(
  deps: BedrockModelDeps,
  body: TurnBody,
): Promise<Response> {
  const state = body.state;
  const inputDelta = typeof body.inputDelta === "string" ? body.inputDelta : "";

  // The field the previous question targeted (first uncollected before merge).
  const askedField: RequiredField | undefined = uncollected(state.context)[0];

  // Resolve async extraction first. When the model is unavailable the async
  // primitive already returns the context-free rule fallback; if THAT yields
  // nothing for the field being asked, apply the field-aware fallback so a
  // plain answer (e.g. "2 adults", "Economy", a bare place or number) still
  // advances the controller instead of dead-ending on "could you rephrase".
  let extracted = await extractAsync(deps, inputDelta, state.context);
  const got = (extracted as Record<string, unknown>);
  const hasAny = Object.keys(got).some((k) => got[k] !== undefined && got[k] !== null && got[k] !== "");
  // Only substitute the field-aware fallback when the model produced NOTHING
  // interpretable (e.g. Bedrock unavailable). When the model returned a valid
  // partial that simply omits the asked field, the controller correctly asks
  // for the first uncollected field, so we leave the extraction untouched.
  if (!hasAny) {
    const fieldAware = fallbackExtractForField(inputDelta, state.context, askedField);
    extracted = { ...fieldAware, ...extracted };
  }
  // Drop-only grounding: remove any field the traveller's text does not support.
  extracted = groundExtraction({ text: inputDelta, asked: askedField, extracted }).fields;

  const mergedContext: TripContext = { ...state.context, ...extracted };
  const nextField: RequiredField | undefined = uncollected(mergedContext)[0];
  const phrased =
    nextField !== undefined
      ? await phraseAsync(deps, nextField, mergedContext)
      : "";

  const model = syncModelFrom(extracted, (field, ctx) =>
    field === nextField ? phrased : fallbackPhrase(field, ctx),
  );

  const result = runPlanningTurn({ state, inputDelta }, model);

  return NextResponse.json(
    {
      response: result.response,
      systemPromptPrefix: result.systemPromptPrefix,
      source: "bedrock",
    },
    { headers: NO_STORE },
  );
}

interface ExtractBody {
  action: "extract";
  text: string;
  asked?: RequiredField;
}

const REQUIRED_FIELD_NAMES: readonly string[] = [
  "origin",
  "destination",
  "durationDays",
  "travellers",
  "budgetLevel",
  "diet",
  "pace",
  "interests",
];

async function handleExtract(
  deps: BedrockModelDeps,
  text: string,
  asked: RequiredField | undefined,
): Promise<Response> {
  const empty: TripContext = {};
  let source: "bedrock" | "fallback" = "bedrock";
  let extracted: Partial<TripContext> = {};
  // extractAsync swallows model errors, so record a throw here.
  let modelFailed = false;
  const watched: BedrockModelDeps = {
    ...deps,
    invokeModel: async (...args: Parameters<BedrockModelDeps["invokeModel"]>) => {
      try {
        return await deps.invokeModel(...args);
      } catch (e) {
        modelFailed = true;
        throw e;
      }
    },
  };
  try {
    extracted = await extractAsync(watched, text, empty);
    if (modelFailed) source = "fallback";
  } catch {
    source = "fallback";
  }
  const got = extracted as Record<string, unknown>;
  const hasAny = Object.keys(got).some(
    (k) => got[k] !== undefined && got[k] !== null && got[k] !== "",
  );
  if (!hasAny) {
    source = "fallback";
    extracted = fallbackExtractForField(text, empty, asked);
  }
  const grounded = groundExtraction({ text, asked, extracted });
  return NextResponse.json(
    { fields: grounded.fields, routeOnly: grounded.routeOnly, source },
    { headers: NO_STORE },
  );
}

function turnFallback(body: TurnBody): Response {
  const state = body.state;
  const inputDelta = typeof body.inputDelta === "string" ? body.inputDelta : "";
  const askedField: RequiredField | undefined = uncollected(state.context)[0];
  const extracted = fallbackExtractForField(inputDelta, state.context, askedField);
  const model = syncModelFrom(extracted, fallbackPhrase);
  const result = runPlanningTurn({ state, inputDelta }, model);
  return NextResponse.json(
    {
      response: result.response,
      systemPromptPrefix: result.systemPromptPrefix,
      source: "fallback",
    },
    { headers: NO_STORE },
  );
}

/** Runs one batch against the whole-request budget; never throws. */
async function runBatchGuarded(
  req: BatchRequest,
  totalDays: number,
): Promise<BatchResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deps = { invokeModel: createBedrockInvoke() };
    const timeout = new Promise<BatchResponse>((resolve) => {
      timer = setTimeout(
        () => resolve(unavailable(req, "unavailable")),
        BATCH_REQUEST_BUDGET_MS,
      );
    });
    return await Promise.race([runPlacesFirstBatch(req, totalDays, deps), timeout]);
  } catch {
    return unavailable(req, "unavailable");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function unavailableLegacy(reason: BatchResponse["reason"]): Response {
  return NextResponse.json(
    { source: "unavailable", reason: reason ?? "unavailable" },
    { headers: NO_STORE },
  );
}

async function handleLegacyItinerary(context: TripContext): Promise<Response> {
  const raw = context.durationDays;
  const duration =
    typeof raw === "number" && Number.isFinite(raw)
      ? Math.min(MAX_TRIP_DAYS, Math.max(1, Math.round(raw)))
      : 4;
  const dayCount = Math.min(duration, BATCH_DAYS);
  const req: BatchRequest = {
    action: "itinerary-batch",
    context: { ...context, durationDays: duration },
    fromDay: 1,
    dayCount,
    usedPlaces: [],
  };
  const resp = await runBatchGuarded(req, duration);
  if (resp.source !== "model" || resp.days.length === 0) {
    return unavailableLegacy(resp.reason);
  }
  const withheld = [...resp.withheldDays];
  for (let d = dayCount + 1; d <= duration; d++) withheld.push(d);
  const itinerary: Itinerary = {
    title: `${context.destination ?? "Your"} trip`,
    totalCost: resp.days.reduce((n, d) => n + d.total, 0),
    days: resp.days,
    completeness: {
      requestedDays: duration,
      verifiedDays: resp.verifiedDays,
      withheldDays: withheld,
    },
  };
  if (resp.sources && resp.sources.length > 0) itinerary.sources = resp.sources;
  return NextResponse.json(
    resp.sources && resp.sources.length > 0
      ? {
          itinerary,
          source: "model",
          completeness: itinerary.completeness,
          sources: resp.sources,
        }
      : { itinerary, source: "model", completeness: itinerary.completeness },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const action = (body as { action?: unknown } | null)?.action;

  if (action === "turn") {
    const turnBody = body as Partial<TurnBody>;
    if (!isControllerState(turnBody.state)) {
      return NextResponse.json(
        { error: "Missing or invalid controller state." },
        { status: 400 },
      );
    }
    const safeBody: TurnBody = {
      action: "turn",
      state: turnBody.state,
      inputDelta:
        typeof turnBody.inputDelta === "string" ? turnBody.inputDelta : "",
    };
    try {
      const deps: BedrockModelDeps = { invokeModel: createBedrockInvoke() };
      return await handleTurn(deps, safeBody);
    } catch {
      return turnFallback(safeBody);
    }
  }

  if (action === "extract") {
    const exBody = body as Partial<ExtractBody>;
    if (typeof exBody.text !== "string") {
      return NextResponse.json({ error: "Missing text." }, { status: 400 });
    }
    const asked =
      typeof exBody.asked === "string" && REQUIRED_FIELD_NAMES.includes(exBody.asked)
        ? exBody.asked
        : undefined;
    try {
      const deps: BedrockModelDeps = { invokeModel: createBedrockInvoke() };
      return await handleExtract(deps, exBody.text, asked);
    } catch {
      const fb = fallbackExtractForField(exBody.text, {}, asked);
      const g = groundExtraction({ text: exBody.text, asked, extracted: fb });
      return NextResponse.json(
        { fields: g.fields, routeOnly: g.routeOnly, source: "fallback" },
        { headers: NO_STORE },
      );
    }
  }

  if (action === "itinerary") {
    const itinBody = body as Partial<ItineraryBody>;
    if (typeof itinBody.context !== "object" || itinBody.context === null) {
      return NextResponse.json(
        { error: "Missing or invalid trip context." },
        { status: 400 },
      );
    }
    const safeBody: ItineraryBody = {
      action: "itinerary",
      context: itinBody.context as TripContext,
    };
    try {
      return await handleLegacyItinerary(safeBody.context);
    } catch {
      return unavailableLegacy("unavailable");
    }
  }

  if (action === "itinerary-batch") {
    const parsed = validateBatchRequest(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const resp = await runBatchGuarded(parsed.value, parsed.totalDays);
    return NextResponse.json(resp, { headers: NO_STORE });
  }

  if (action === "misc-estimate") {
    const parsed = validateMiscRequest(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const result = await estimateMisc(
      { invokeModel: createBedrockInvoke() },
      parsed.value,
    );
    return NextResponse.json(result, { headers: NO_STORE });
  }

  return NextResponse.json(
    {
      error:
        "Invalid or missing action. Expected turn, extract, itinerary, itinerary-batch or misc-estimate.",
    },
    { status: 400 },
  );
}

