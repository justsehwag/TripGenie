// Extraction grounding (pure, client-safe; no AWS SDK, no server deps).
// Drops any extracted field that the traveller's own text does not support.
// Spec: chat-images-bedrock-planner, design "extraction-grounding", Req 1.3, 1.7, 1.12.
import type { TripContext } from "./types";
import type { RequiredField } from "./preference-controller";
import { parseRoute, emptyRouteState } from "./route-intake";
import { durationFromText } from "./date-intake";

export interface GroundingInput {
  /** The traveller's turn, verbatim. */
  text: string;
  asked: RequiredField | undefined;
  /** From Bedrock or the offline fallback. */
  extracted: Partial<TripContext>;
}

export interface GroundingResult {
  /** Only fields supported by `text`. */
  fields: Partial<TripContext>;
  routeOnly: boolean;
  /** Names only, for counts-only logging. */
  dropped: RequiredField[];
}

const FILLER = new Set([
  "hi", "hey", "hello", "yo", "hiya", "namaste", "ok", "okay", "yes", "no",
  "yeah", "yep", "nope", "sure", "thanks", "thank you", "please", "help",
  "start", "hmm", "idk", "na", "test", "what", "who", "skip", "maybe",
  "dont know", "not sure",
]);

const NO_PREFERENCE = new Set(["no preference", "none", "any", "anything", "no", "nothing", "no restrictions"]);

const MAX_DIET_CHARS = 60;

const DIET_KEYWORD =
  /\b(vegetarian|veg|vegan|non[- ]?veg(?:etarian)?|jain|halal|kosher|gluten|eggetarian|pescatarian|pescetarian|dairy|lactose|nut allerg\w*|allerg\w*|keto|sattvic)\b/i;
const BUDGET_KEYWORD = /\b(budget|cheap|economical|economy|mid|moderate|standard|medium|lux\w*|premium)\b/i;
const PACE_KEYWORD = /\b(relax\w*|slow|chill\w*|easy|leisurely|pack\w*|fast|busy|intense|balanc\w*|moderate)\b/i;
const TRAVELLER_KEYWORD =
  /(\d{1,2}\s*(?:adults?|child|children|kids?|infants?|people|persons|pax|travell?ers?)|\bsolo\b|\bjust me\b|\bmyself\b|\bcouple\b|\btwo of us\b|\bmy partner\b|\bhoneymoon\b|\bfamily\b)/i;

function normalise(s: string): string {
  return ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

function bareNumber(text: string): number | null {
  const m = text.match(/^\s*(\d{1,3})\s*$/);
  return m ? Number(m[1]) : null;
}

function routeOf(text: string): { origin: string; destination: string } {
  const r = parseRoute(text, emptyRouteState());
  return { origin: r.origin, destination: r.destination };
}

function readsAsRoute(text: string): boolean {
  const r = routeOf(text);
  return r.origin !== "" || r.destination !== "";
}

function hasOtherDetail(text: string): boolean {
  return (
    durationFromText(text) !== null ||
    /\d/.test(text) ||
    TRAVELLER_KEYWORD.test(text) ||
    BUDGET_KEYWORD.test(text) ||
    PACE_KEYWORD.test(text) ||
    DIET_KEYWORD.test(text)
  );
}

/** True when the text parses as an origin-and-destination route and carries no other detail. */
export function isRouteOnlyAnswer(text: string): boolean {
  if (typeof text !== "string" || text.trim() === "") return false;
  const r = routeOf(text);
  if (r.origin === "" || r.destination === "") return false;
  return !hasOtherDetail(text);
}

/**
 * Returns a diet string taken from the text, or null when the text is a route,
 * a bare number, filler, or has no letter. "no preference"/"none"/"any" map to "no preference".
 */
export function validateDiet(text: string): string | null {
  if (typeof text !== "string") return null;
  const t = text.trim().replace(/\s+/g, " ");
  if (t === "" || !/[a-z]/i.test(t)) return null;
  if (bareNumber(t) !== null) return null;
  const key = t.toLowerCase().replace(/[^a-z ]+/g, "").trim();
  if (NO_PREFERENCE.has(key) || /^(no|none|any|anything)\b/.test(key) && key.split(" ").length <= 2) {
    return "no preference";
  }
  if (FILLER.has(key)) return null;
  if (readsAsRoute(t)) return null;
  return t.slice(0, MAX_DIET_CHARS);
}

function placeSupported(value: unknown, text: string, routePart: string): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  const v = normalise(value);
  if (v.trim() === "") return false;
  if (normalise(text).includes(v)) return true;
  return normalise(routePart) === v;
}

function budgetSupported(value: unknown, text: string): boolean {
  if (typeof value !== "string") return false;
  const lower = text.toLowerCase();
  switch (value.toLowerCase()) {
    case "budget": return /\b(budget|cheap|economical|economy)\b/.test(lower);
    case "mid": return /\b(mid|moderate|standard|medium)\b/.test(lower);
    case "luxury": return /\b(lux\w*|premium)\b/.test(lower);
    default: return false;
  }
}

function paceSupported(value: unknown, text: string): boolean {
  if (typeof value !== "string") return false;
  const lower = text.toLowerCase();
  switch (value.toLowerCase()) {
    case "relaxed": return /\b(relax\w*|slow|chill\w*|easy|leisurely)\b/.test(lower);
    case "packed": return /\b(pack\w*|fast|busy|intense)\b/.test(lower);
    case "balanced": return /\b(balanc\w*|moderate)\b/.test(lower);
    default: return false;
  }
}

function travellersSupported(text: string, asked: RequiredField | undefined): boolean {
  if (TRAVELLER_KEYWORD.test(text)) return true;
  return asked === "travellers" && bareNumber(text) !== null;
}

function dietSupported(value: unknown, text: string): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  const valid = validateDiet(text);
  if (valid !== null && valid === value.trim()) return true;
  return DIET_KEYWORD.test(text);
}

function interestsSupported(value: unknown, text: string, asked: RequiredField | undefined): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (!value.every((i) => typeof i === "string" && i.trim() !== "")) return false;
  const hay = normalise(text);
  if ((value as string[]).every((i) => hay.includes(normalise(i)))) return true;
  return asked === "interests" && !readsAsRoute(text);
}

export function groundExtraction(i: GroundingInput): GroundingResult {
  const text = typeof i?.text === "string" ? i.text : "";
  const asked = i?.asked;
  const extracted: Partial<TripContext> = i?.extracted ?? {};
  const routeOnly = isRouteOnlyAnswer(text);
  const route = routeOf(text);
  const fields: Partial<TripContext> = {};
  const dropped: RequiredField[] = [];

  const keep = (f: RequiredField, ok: boolean, set: () => void): void => {
    if (extracted[f] === undefined) return;
    if (ok && (!routeOnly || f === "origin" || f === "destination")) set();
    else dropped.push(f);
  };

  keep("origin", placeSupported(extracted.origin, text, route.origin), () => {
    fields.origin = extracted.origin;
  });
  keep("destination", placeSupported(extracted.destination, text, route.destination), () => {
    fields.destination = extracted.destination;
  });
  keep(
    "durationDays",
    typeof extracted.durationDays === "number" &&
      (durationFromText(text) === extracted.durationDays ||
        (asked === "durationDays" && bareNumber(text) === extracted.durationDays)),
    () => { fields.durationDays = extracted.durationDays; },
  );
  keep("travellers", extracted.travellers !== undefined && travellersSupported(text, asked), () => {
    fields.travellers = extracted.travellers;
  });
  keep("budgetLevel", budgetSupported(extracted.budgetLevel, text), () => {
    fields.budgetLevel = extracted.budgetLevel;
  });
  keep("pace", paceSupported(extracted.pace, text), () => {
    fields.pace = extracted.pace;
  });
  keep("diet", dietSupported(extracted.diet, text), () => {
    fields.diet = extracted.diet;
  });
  keep("interests", interestsSupported(extracted.interests, text, asked), () => {
    fields.interests = extracted.interests;
  });

  return { fields, routeOnly, dropped };
}
