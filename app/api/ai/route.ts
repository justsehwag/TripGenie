import { NextResponse } from "next/server";
import type { TripContext } from "@/lib/types";
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
  generateItineraryAsync,
  syncModelFrom,
  fallbackPhrase,
  fallbackExtractForField,
  type BedrockModelDeps,
} from "@/lib/bedrock-model";

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

async function handleItinerary(
  deps: BedrockModelDeps,
  body: ItineraryBody,
): Promise<Response> {
  const context = (body.context ?? {}) as TripContext;
  const itinerary = await generateItineraryAsync(deps, context);
  return NextResponse.json(
    { itinerary, source: "bedrock" },
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
      const deps: BedrockModelDeps = { invokeModel: createBedrockInvoke() };
      return await handleItinerary(deps, safeBody);
    } catch {
      const { buildItinerary } = await import("@/lib/itinerary-engine");
      const context = safeBody.context;
      const itinerary = buildItinerary({
        destination: context.destination ?? "your destination",
        startDate: new Date().toISOString().slice(0, 10),
        days: context.durationDays ?? 4,
        vibes: context.interests,
      });
      return NextResponse.json(
        { itinerary, source: "fallback" },
        { headers: NO_STORE },
      );
    }
  }

  return NextResponse.json(
    { error: "Invalid or missing action. Expected turn or itinerary." },
    { status: 400 },
  );
}

