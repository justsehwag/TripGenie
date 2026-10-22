// Client-safe deterministic intake fallback (pure; no AWS SDK, no server deps).
// Mirrors the server fallback in lib/bedrock-model.ts so the browser planner
// can advance the preference controller with NO network when Bedrock is absent.
import type { TripContext } from "./types";
import type { ExtractionModel, RequiredField } from "./preference-controller";
import { parseRoute, emptyRouteState } from "./route-intake";
import { durationFromText } from "./date-intake";

const MIN_DURATION = 1;
const MAX_DURATION = 30;

const STOP = new Set([
  "hi","hey","hello","yo","hiya","namaste","ok","okay","yes","no",
  "yeah","yep","nope","sure","thanks","please","help","start","hmm",
  "idk","none","na","test","what","who",
]);

function titleCasePlace(v: string): string {
  return v.trim().replace(new RegExp("\\b\\w","g"), (c) => c.toUpperCase()).slice(0, 60);
}

function parseTravellers(text: string): { adults: number; children: number } | null {
  const lower = text.toLowerCase();
  const adultsM = lower.match(new RegExp("(\\d{1,2})\\s*adult"));
  const childM = lower.match(new RegExp("(\\d{1,2})\\s*(?:child|children|kid|infant)"));
  let adults = adultsM ? Number(adultsM[1]) : NaN;
  const children = childM ? Number(childM[1]) : 0;
  if (/solo|just me|myself|1 person|one person/.test(lower)) adults = 1;
  else if (/couple|two of us|my partner|honeymoon/.test(lower)) adults = 2;
  else if (/family of \d/.test(lower)) { const m = lower.match(new RegExp("family of (\\d)")); adults = m ? Number(m[1]) : 4; }
  else if (/family/.test(lower)) adults = 4;
  if (!Number.isFinite(adults)) {
    const bare = lower.match(new RegExp("^\\s*(\\d{1,2})\\s*(?:people|persons|pax|travellers?|travelers?|adults?)?\\s*(?:only)?\\s*$"));
    if (bare) adults = Number(bare[1]);
  }
  if (!Number.isFinite(adults) || adults < 1) return null;
  return { adults: Math.trunc(adults), children: Number.isFinite(children) && children >= 0 ? Math.trunc(children) : 0 };
}


const QUESTIONS: Record<RequiredField, string> = {
  origin: "Which city are you travelling from?",
  destination: "Where would you like to travel to?",
  durationDays: "How many days will your trip be?",
  travellers: "Who's joining you - how many adults and children?",
  budgetLevel: "What's your budget level - budget, mid, or luxury?",
  diet: "Any food or dietary preferences we should plan around?",
  pace: "What pace would you like - relaxed, balanced, or packed?",
  interests: "What are you most interested in - culture, food, adventure, nature?",
};

export function fallbackPhrase(field: RequiredField): string {
  const q = QUESTIONS[field] ?? "Could you share a bit more about your trip?";
  return q.length > 160 ? q.slice(0, 160) : q;
}

/** Field-aware deterministic extraction. Rejects greetings/filler; never fabricates. */
export function fallbackExtractForField(
  delta: string,
  context: TripContext,
  field: RequiredField | undefined,
): Partial<TripContext> {
  const out: Partial<TripContext> = {};
  const text = typeof delta === "string" ? delta.trim() : "";
  if (text.length === 0) return out;
  const lower = text.toLowerCase();

  // Always try the explicit route grammar first (From X to Y / X to Y).
  const route = parseRoute(text, emptyRouteState());
  if (route.origin && !STOP.has(route.origin.toLowerCase())) out.origin = route.origin;
  if (route.destination && !STOP.has(route.destination.toLowerCase())) out.destination = route.destination;
  const days = durationFromText(text);
  if (days !== null && Number.isFinite(days)) { const n = Math.trunc(days); if (n >= MIN_DURATION && n <= MAX_DURATION) out.durationDays = n; }

  if (field === undefined) return out;
  const has = (out as Record<string, unknown>)[field] !== undefined;
  if (has) return out;

  const placeText = text.replace(new RegExp("^\\s*(from|to)\\s+","i"), "").trim();
  const looksLikePlace = !STOP.has(lower) && !STOP.has(placeText.toLowerCase()) && placeText.length >= 3 && new RegExp("^[a-z .'-]{3,45}$","i").test(placeText) && new RegExp("[aeiou]","i").test(placeText);
  switch (field) {
    case "origin": if (looksLikePlace) out.origin = titleCasePlace(placeText); break;
    case "destination": if (looksLikePlace) out.destination = titleCasePlace(placeText); break;
    case "durationDays": { const b = text.match(new RegExp("^\\s*(\\d{1,2})\\s*$")); if (b) { const n = Number(b[1]); if (n >= MIN_DURATION && n <= MAX_DURATION) out.durationDays = n; } break; }
    case "travellers": { const t = parseTravellers(text); if (t) out.travellers = t; break; }
    case "budgetLevel": { if (/budget|cheap|economical/.test(lower)) out.budgetLevel = "budget"; else if (/lux/.test(lower)) out.budgetLevel = "luxury"; else if (/mid|moderate|standard/.test(lower)) out.budgetLevel = "mid"; break; }
    case "pace": { if (/relax|slow|chill|easy/.test(lower)) out.pace = "relaxed"; else if (/pack|fast|busy|intense/.test(lower)) out.pace = "packed"; else if (/balanc|moderate/.test(lower)) out.pace = "balanced"; break; }
    case "diet": { if (/^(no|none|any|anything)\b/.test(lower)) out.diet = "no preference"; else out.diet = text.slice(0, 60); break; }
    case "interests": { const parts = text.split(new RegExp("[,&/]|\\band\\b")).map((p) => p.trim()).filter((p) => p.length > 0); if (parts.length > 0) out.interests = parts.slice(0, 6); break; }
  }
  return out;
}

/** Build a synchronous ExtractionModel for advance(): field-aware extract + phrasing. */
export function syncFallbackModel(field: RequiredField | undefined): ExtractionModel {
  return {
    extract: (delta, context) => fallbackExtractForField(delta, context, field),
    phrase: (f) => fallbackPhrase(f),
  };
}

