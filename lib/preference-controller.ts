import type { TripContext } from "./types";

/**
 * Preference Controller state machine (pure control flow) - design section 2.
 * Ported from TripSaathi lib/conversation.ts (nextIntakeStep/mergeTripPreferences).
 * The state machine owns control flow; the model only supplies extraction/phrasing.
 * Requirements: 2.1-2.7, 2.9-2.11.
 */

export const REQUIRED_FIELDS = [
  "origin",
  "destination",
  "durationDays",
  "travellers",
  "budgetLevel",
  "diet",
  "pace",
  "interests",
] as const;

export type RequiredField = (typeof REQUIRED_FIELDS)[number];
export const MAX_QUESTIONS = 8;
export const MAX_ANSWER_CHARS = 160;
export const COMPLETION_TEXT =
  "Your trip profile is ready. Review the summary and change any category before generating your itinerary.";

export interface ControllerState {
  context: TripContext;
  questionsAsked: number;
}

export interface ControllerResponse {
  state: ControllerState;
  prompt: string;
  phase: "collecting" | "completion";
  completionText?: string;
  uncollectedRequired?: RequiredField[];
}

/** Extraction model interface; Bedrock implements this at the edge. */
export interface ExtractionModel {
  /** Extract partial TripContext from an input delta. No interpretation => {}. */
  extract(delta: string, context: TripContext): Partial<TripContext>;
  /** Phrase the next question for a field (<= 160 chars enforced by caller). */
  phrase(field: RequiredField, context: TripContext): string;
}

function isFilled(context: TripContext, field: RequiredField): boolean {
  const v = context[field as keyof TripContext];
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

export function uncollected(context: TripContext): RequiredField[] {
  return REQUIRED_FIELDS.filter((f) => !isFilled(context, f));
}

export function emptyControllerState(): ControllerState {
  return { context: {}, questionsAsked: 0 };
}

/** Reset clears all fields (Req 2.7). */
export function reset(): ControllerState {
  return emptyControllerState();
}

/**
 * Per-field edit control (Req 2.7): replace a single Trip_Context field
 * without reopening conversational intake or touching any other field.
 * Passing `undefined` clears the field. The question count is left unchanged.
 */
export function editField<K extends RequiredField>(
  state: ControllerState,
  field: K,
  value: TripContext[K],
): ControllerState {
  const context: TripContext = { ...state.context };
  if (value === undefined) {
    delete context[field];
  } else {
    context[field] = value;
  }
  return { context, questionsAsked: state.questionsAsked };
}

/**
 * Advance the intake one turn. The controller owns control flow: at most 8
 * questions, exactly one per turn, each <= 160 chars; fixed completion text.
 */
export function advance(
  state: ControllerState,
  inputDelta: string,
  model: ExtractionModel,
): ControllerResponse {
  const extracted = model.extract(inputDelta, state.context) ?? {};
  const hasAny = Object.keys(extracted).some((k) => {
    const v = (extracted as Record<string, unknown>)[k];
    return v !== undefined && v !== null && v !== "";
  });
  // Uninterpretable input: retain context unchanged, ask for clarification (Req 2.11).
  if (!hasAny) {
    return {
      state,
      prompt: "I did not catch a trip detail there. Could you rephrase?",
      phase: "collecting",
    };
  }
  const context: TripContext = { ...state.context, ...extracted };
  const missing = uncollected(context);
  if (missing.length === 0) {
    return {
      state: { context, questionsAsked: state.questionsAsked },
      prompt: COMPLETION_TEXT,
      phase: "completion",
      completionText: COMPLETION_TEXT,
    };
  }
  // Question-limit reached with gaps remaining: stop, surface uncollected (Req 2.3).
  if (state.questionsAsked >= MAX_QUESTIONS) {
    return {
      state: { context, questionsAsked: state.questionsAsked },
      prompt: COMPLETION_TEXT,
      phase: "completion",
      completionText: COMPLETION_TEXT,
      uncollectedRequired: missing,
    };
  }
  const nextField = missing[0];
  const raw = model.phrase(nextField, context);
  const prompt = raw.length > MAX_ANSWER_CHARS ? raw.slice(0, MAX_ANSWER_CHARS) : raw;
  return {
    state: { context, questionsAsked: state.questionsAsked + 1 },
    prompt,
    phase: "collecting",
  };
}

/** Omit any offer lacking confirmed availability (Req 2.10). */
export function filterConfirmedOffers<T extends { confirmedAvailability?: boolean }>(
  offers: T[],
): T[] {
  return offers.filter((o) => o.confirmedAvailability === true);
}
