// Chat intake state machine (pure, client-safe; no network, no storage, no AWS SDK).
// The chat owns control flow here: fixed question order, no defaults, explicit skip,
// and navigation only on the "generate" event. See the chat-images-bedrock-planner
// design, "Part A: Chat intake".
import type { TripContext } from "./types";
import { REQUIRED_FIELDS, MAX_QUESTIONS, type RequiredField } from "./preference-controller";
import { fallbackPhrase } from "./intake-fallback";
import { resolvePace } from "./itinerary/pace";
import { resolveBudgetLevel } from "./cost-caps";

export type FieldStatus = "unset" | "answered" | "skipped" | "carried";
export type IntakePhase = "recap" | "collecting" | "summary";

export interface ChatIntakeState {
  /** Values only; never defaults. */
  context: TripContext;
  status: Record<RequiredField, FieldStatus>;
  /** The field of the open question. */
  asked: RequiredField | null;
  /** Questions asked so far. Re-asks are not counted. */
  questionsAsked: number;
  phase: IntakePhase;
}

export type ChatEvent =
  | { type: "seed"; context: TripContext }
  /** `extracted` is already grounded by the caller. */
  | { type: "text"; text: string; extracted: Partial<TripContext>; routeOnly?: boolean }
  | { type: "skip" }
  | { type: "keep-carried" }
  | { type: "edit"; field: RequiredField; value: TripContext[RequiredField] | undefined }
  | { type: "generate" }
  | { type: "reset" };

export interface ChatStep {
  state: ChatIntakeState;
  /** Assistant message to append (question, recap or summary lead-in). */
  message: string;
  /** True only for `generate` with origin and destination set. */
  navigate: boolean;
}

export interface SummaryRow {
  field: RequiredField;
  label: string;
  /** The value, "Skipped" or "Not answered". */
  display: string;
  status: FieldStatus | "not-answered";
  carried: boolean;
  /** For example "Pace defaults to balanced". Text only. */
  defaultNote?: string;
}

export const SKIPPABLE: readonly RequiredField[] = REQUIRED_FIELDS.filter(
  (f) => f !== "origin" && f !== "destination",
);

export const SKIP_REFUSAL_TEXT = "I need this one to plan your trip.";
export const SUMMARY_TEXT =
  "Here is your trip summary. Edit anything, then choose Generate itinerary.";
export const REASK_PREFIX = "I did not catch a trip detail there.";

const LABELS: Record<RequiredField, string> = {
  origin: "From",
  destination: "To",
  durationDays: "Days",
  travellers: "Travellers",
  budgetLevel: "Budget",
  diet: "Diet",
  pace: "Pace",
  interests: "Interests",
};

function hasValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.length > 0;
  return typeof v === "object";
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isCount(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** Type check for an edited value. origin and destination must be non-empty strings. */
function isValidFieldValue(field: RequiredField, v: unknown): boolean {
  switch (field) {
    case "origin":
    case "destination":
    case "budgetLevel":
    case "diet":
    case "pace":
      return isNonEmptyString(v);
    case "durationDays":
      return typeof v === "number" && Number.isFinite(v) && v > 0;
    case "travellers": {
      if (!v || typeof v !== "object" || Array.isArray(v)) return false;
      const t = v as { adults?: unknown; children?: unknown };
      return isCount(t.adults) && isCount(t.children);
    }
    case "interests":
      return Array.isArray(v) && v.length > 0 && v.every(isNonEmptyString);
  }
}

function blankStatus(): Record<RequiredField, FieldStatus> {
  const s = {} as Record<RequiredField, FieldStatus>;
  for (const f of REQUIRED_FIELDS) s[f] = "unset";
  return s;
}

export function initialIntakeState(): ChatIntakeState {
  return {
    context: {},
    status: blankStatus(),
    asked: REQUIRED_FIELDS[0],
    questionsAsked: 1,
    phase: "collecting",
  };
}

/** First field in REQUIRED_FIELDS order whose status is "unset". */
export function nextUnset(state: ChatIntakeState): RequiredField | undefined {
  return REQUIRED_FIELDS.find((f) => state.status[f] === "unset");
}

function formatValue(field: RequiredField, v: unknown): string {
  if (field === "travellers" && v && typeof v === "object") {
    const t = v as { adults?: number; children?: number };
    const a = t.adults ?? 0;
    const c = t.children ?? 0;
    return c > 0 ? `${a} adult${a === 1 ? "" : "s"}, ${c} child${c === 1 ? "" : "ren"}` : `${a} adult${a === 1 ? "" : "s"}`;
  }
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

function defaultNoteFor(field: RequiredField): string | undefined {
  if (field === "pace") return `Pace defaults to ${resolvePace(undefined)}`;
  if (field === "budgetLevel") return `Budget defaults to ${resolveBudgetLevel(undefined)}`;
  return undefined;
}

/** Summary rows in fixed order. Skipped and unset rows carry no value. */
export function summaryRows(state: ChatIntakeState): SummaryRow[] {
  return REQUIRED_FIELDS.map((field) => {
    const st = state.status[field];
    const value = state.context[field];
    if ((st === "answered" || st === "carried") && hasValue(value)) {
      return { field, label: LABELS[field], display: formatValue(field, value), status: st, carried: st === "carried" };
    }
    const skipped = st === "skipped";
    return {
      field,
      label: LABELS[field],
      display: skipped ? "Skipped" : "Not answered",
      status: skipped ? ("skipped" as const) : ("not-answered" as const),
      carried: false,
      defaultNote: defaultNoteFor(field),
    };
  });
}

function recapMessage(state: ChatIntakeState): string {
  const parts = REQUIRED_FIELDS.filter((f) => state.status[f] === "carried").map(
    (f) => `${LABELS[f]}: ${formatValue(f, state.context[f])}`,
  );
  return `Already provided from your earlier trip: ${parts.join("; ")}.`;
}

interface FinishOpts {
  prevAsked: RequiredField | null;
  prefix?: string;
}

/** Choose the next question or the summary. Returns the new state and message. */
function finish(base: ChatIntakeState, o: FinishOpts): { state: ChatIntakeState; message: string } {
  const next = nextUnset(base);
  const lead = o.prefix ? `${o.prefix} ` : "";
  if (!next) {
    return { state: { ...base, asked: null, phase: "summary" }, message: lead + SUMMARY_TEXT };
  }
  const keepRecap = base.phase === "recap";
  const phase: IntakePhase = keepRecap ? "recap" : "collecting";
  if (next === o.prevAsked) {
    return { state: { ...base, asked: next, phase }, message: lead + fallbackPhrase(next) };
  }
  if (base.questionsAsked >= MAX_QUESTIONS) {
    return { state: { ...base, asked: null, phase: "summary" }, message: lead + SUMMARY_TEXT };
  }
  return {
    state: { ...base, asked: next, phase, questionsAsked: base.questionsAsked + 1 },
    message: lead + fallbackPhrase(next),
  };
}

function confirmCarried(state: ChatIntakeState): ChatIntakeState {
  const status = { ...state.status };
  for (const f of REQUIRED_FIELDS) if (status[f] === "carried") status[f] = "answered";
  return { ...state, status };
}

function seed(context: TripContext): ChatStep {
  const status = blankStatus();
  const clean: TripContext = {};
  for (const f of REQUIRED_FIELDS) {
    const v = context?.[f];
    if (hasValue(v)) {
      (clean as Record<string, unknown>)[f] = v;
      status[f] = "carried";
    }
  }
  const anyCarried = REQUIRED_FIELDS.some((f) => status[f] === "carried");
  const base: ChatIntakeState = {
    context: clean,
    status,
    asked: null,
    questionsAsked: 0,
    phase: anyCarried ? "recap" : "collecting",
  };
  const fin = finish(base, { prevAsked: null });
  const message = anyCarried ? `${recapMessage(base)} ${fin.message}` : fin.message;
  // A fully carried context shows the recap, not the summary, until the traveller continues.
  if (anyCarried && !nextUnset(base)) {
    return { state: { ...base, asked: null, phase: "recap" }, message, navigate: false };
  }
  return { state: fin.state, message, navigate: false };
}

export function step(state: ChatIntakeState, event: ChatEvent): ChatStep {
  switch (event.type) {
    case "reset": {
      const s = initialIntakeState();
      return { state: s, message: fallbackPhrase(REQUIRED_FIELDS[0]), navigate: false };
    }
    case "seed":
      return seed(event.context);

    case "keep-carried": {
      const base = confirmCarried(state);
      const r = finish({ ...base, phase: "collecting" }, { prevAsked: state.asked });
      return { ...r, navigate: false };
    }

    case "text": {
      const base0 = confirmCarried(state);
      const extracted = (event.extracted ?? {}) as Record<string, unknown>;
      const context: TripContext = { ...base0.context };
      const status = { ...base0.status };
      let appliedAsked = false;
      let appliedAny = false;
      // A route-only turn updates the route even when it was already answered (design item 9).
      const routeTurn =
        event.routeOnly === true ||
        // Without the flag, both route fields must already be answered. Otherwise an existing
        // test (chat-intake.test.ts "does not overwrite an answered field...") would break.
        (isNonEmptyString(extracted.origin) &&
          isNonEmptyString(extracted.destination) &&
          state.status.origin !== "unset" &&
          state.status.destination !== "unset");
      for (const f of REQUIRED_FIELDS) {
        const v = extracted[f];
        if (!hasValue(v)) continue;
        const isAsked = f === state.asked;
        const isRouteField = f === "origin" || f === "destination";
        if (isRouteField && !isNonEmptyString(v)) continue;
        // "carried" was just confirmed to "answered"; use the pre-confirmation status.
        const was = state.status[f];
        if (!(was === "unset" || was === "carried" || isAsked || (routeTurn && isRouteField))) continue;
        (context as Record<string, unknown>)[f] = v;
        status[f] = "answered";
        appliedAny = true;
        if (isAsked) appliedAsked = true;
      }
      const base: ChatIntakeState = { ...base0, context, status, phase: "collecting" };
      const prefix = state.asked && !appliedAsked && !appliedAny ? REASK_PREFIX : undefined;
      return { ...finish(base, { prevAsked: state.asked, prefix }), navigate: false };
    }

    case "skip": {
      const asked = state.asked;
      if (asked === null) {
        // Nothing is open (summary or recap with no question): no change.
        return { state, message: state.phase === "summary" ? SUMMARY_TEXT : recapMessage(state), navigate: false };
      }
      if (SKIPPABLE.indexOf(asked) < 0) {
        return { state, message: `${SKIP_REFUSAL_TEXT} ${fallbackPhrase(asked)}`, navigate: false };
      }
      const base0 = confirmCarried(state);
      const status = { ...base0.status, [asked]: "skipped" as FieldStatus };
      const context = { ...base0.context };
      delete context[asked];
      const base: ChatIntakeState = { ...base0, context, status, phase: "collecting" };
      return { ...finish(base, { prevAsked: null }), navigate: false };
    }

    case "edit": {
      const context: TripContext = { ...state.context };
      const status = { ...state.status };
      if (hasValue(event.value)) {
        // An invalid value leaves the field unchanged.
        if (!isValidFieldValue(event.field, event.value)) {
          return { state, message: "", navigate: false };
        }
        (context as Record<string, unknown>)[event.field] = event.value;
        status[event.field] = "answered";
      } else {
        delete context[event.field];
        status[event.field] = "unset";
      }
      const base: ChatIntakeState = { ...state, context, status };
      return { ...finish(base, { prevAsked: state.asked }), navigate: false };
    }

    case "generate": {
      const originSet = isNonEmptyString(state.context.origin);
      if (originSet && isNonEmptyString(state.context.destination)) {
        return { state, message: "", navigate: true };
      }
      const missing: RequiredField = originSet ? "destination" : "origin";
      const status = { ...state.status };
      if (status[missing] !== "unset") status[missing] = "unset";
      const context = { ...state.context };
      delete context[missing];
      const base: ChatIntakeState = { ...state, context, status, phase: "collecting" };
      const next = nextUnset(base) as RequiredField; // origin/destination come first in order
      const reask = next === state.asked;
      const questionsAsked =
        reask || base.questionsAsked >= MAX_QUESTIONS ? base.questionsAsked : base.questionsAsked + 1;
      return {
        state: { ...base, asked: next, questionsAsked },
        message: fallbackPhrase(next),
        navigate: false,
      };
    }
  }
}
