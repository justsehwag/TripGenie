/**
 * Bedrock_Model â€” server-only Amazon Bedrock implementation of the controller's
 * Extraction_Model plus itinerary generation (design: Components and Interfaces
 * â†’ Bedrock_Model). Realtime AI integration, tasks 2.1â€“2.4.
 *
 * SERVER-ONLY. This module must never be imported by a `"use client"` module
 * (Req 2.7: Bedrock is invoked only from the server-side Bedrock_Route, never
 * from the browser). The AWS SDK is NOT imported statically here â€” the real
 * invoke wrapper is built via `createBedrockInvoke()` using a dynamic import so
 * this module stays unit-testable without AWS and without a live model call.
 *
 * Design choices honored:
 *  - Prompts begin with `SYSTEM_PROMPT_PREFIX` (lib/planning-turn.ts) reused
 *    byte-identically as the start of `ModelPrompt.system` (Req 19.4).
 *  - `parseExtraction` validates against a strict JSON schema and VALIDATE-AND-
 *    DROPS anything non-conforming, never fabricating a field (Req 2.2, 2.10).
 *  - Every async primitive bounds the model call with an AbortController and
 *    falls back deterministically on any error/timeout/non-JSON output so the
 *    planner never breaks (Req 2.5, 2.8, 10.3). No flight/stay/car is ever
 *    marked confirmed or available (Req 2.9).
 *  - `syncModelFrom` adapts pre-resolved async results into the synchronous
 *    `ExtractionModel` the controller consumes, with NO controller change.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.5, 2.8, 2.9, 2.10, 3.1, 10.3; Design: Bedrock_Model.
 */

import type { Itinerary, TripContext } from "./types";
import type { ExtractionModel, RequiredField } from "./preference-controller";
import { SYSTEM_PROMPT_PREFIX } from "./planning-turn";
import { buildItinerary } from "./itinerary-engine";
import { parseRoute, emptyRouteState } from "./route-intake";
import { durationFromText } from "./date-intake";
import { awsConfig } from "./config";

/* ===========================================================================
 * 2.1 â€” Contract, deps, and strict JSON extraction schema
 * ======================================================================== */

/** A single bounded model call. `system` begins with SYSTEM_PROMPT_PREFIX. */
export interface ModelPrompt {
  /** Begins with SYSTEM_PROMPT_PREFIX (byte-identical reuse). */
  system: string;
  /** Task-specific instruction + input delta/context. */
  user: string;
  /** Upper bound on generated tokens (small for extract/phrase, larger for itinerary). */
  maxTokens: number;
  /** Bounded per-call timeout in milliseconds. */
  timeoutMs: number;
}

/** Injected dependencies; `invokeModel` is mocked in tests, real in the route. */
export interface BedrockModelDeps {
  /** Returns the raw model text for a prompt, or throws on error/timeout. */
  invokeModel: (prompt: ModelPrompt) => Promise<string>;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

/** Allowed budget levels (schema-constrained). */
const BUDGET_LEVELS = new Set(["budget", "mid", "luxury"]);
/** Allowed pace values (schema-constrained). */
const PACE_VALUES = new Set(["relaxed", "balanced", "packed"]);
/** Keys the extraction schema may ever produce (Property 2: keys âŠ† schema). */
export const EXTRACTION_SCHEMA_KEYS: readonly (keyof TripContext)[] = [
  "origin",
  "destination",
  "durationDays",
  "travellers",
  "budgetLevel",
  "diet",
  "pace",
  "interests",
] as const;

/** Duration bounds enforced by the schema (keep only 1..30). */
const MIN_DURATION = 1;
const MAX_DURATION = 30;

function cleanString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function cleanDuration(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  const i = Math.trunc(n);
  return i >= MIN_DURATION && i <= MAX_DURATION ? i : undefined;
}

function cleanTravellers(v: unknown): { adults: number; children: number } | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const rec = v as Record<string, unknown>;
  const adultsRaw = rec.adults;
  const adults =
    typeof adultsRaw === "number"
      ? adultsRaw
      : typeof adultsRaw === "string"
      ? Number(adultsRaw)
      : NaN;
  if (!Number.isFinite(adults) || !Number.isInteger(adults) || adults < 1) return undefined;
  const childrenRaw = rec.children;
  const childrenNum =
    typeof childrenRaw === "number"
      ? childrenRaw
      : typeof childrenRaw === "string"
      ? Number(childrenRaw)
      : NaN;
  const children =
    Number.isFinite(childrenNum) && Number.isInteger(childrenNum) && childrenNum >= 0
      ? childrenNum
      : 0;
  return { adults, children };
}

function cleanEnum(v: unknown, allowed: Set<string>): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().toLowerCase();
  return allowed.has(t) ? t : undefined;
}

function cleanInterests(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const cleaned = v
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Validate a raw JSON model output against the strict extraction schema and
 * VALIDATE-AND-DROP anything non-conforming. The result only ever contains
 * fields the traveler actually supplied (no-fabrication, Req 2.10). Non-JSON,
 * parse error, or empty input â‡’ `{}` (Req 2.5).
 */
export function parseExtraction(text: string): Partial<TripContext> {
  if (typeof text !== "string" || text.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const obj = parsed as Record<string, unknown>;
  const out: Partial<TripContext> = {};

  const origin = cleanString(obj.origin);
  if (origin !== undefined) out.origin = origin;

  const destination = cleanString(obj.destination);
  if (destination !== undefined) out.destination = destination;

  const durationDays = cleanDuration(obj.durationDays);
  if (durationDays !== undefined) out.durationDays = durationDays;

  const travellers = cleanTravellers(obj.travellers);
  if (travellers !== undefined) out.travellers = travellers;

  const budgetLevel = cleanEnum(obj.budgetLevel, BUDGET_LEVELS);
  if (budgetLevel !== undefined) out.budgetLevel = budgetLevel;

  const diet = cleanString(obj.diet);
  if (diet !== undefined) out.diet = diet;

  const pace = cleanEnum(obj.pace, PACE_VALUES);
  if (pace !== undefined) out.pace = pace;

  const interests = cleanInterests(obj.interests);
  if (interests !== undefined) out.interests = interests;

  return out;
}

/** The required JSON shape appended to extraction prompts. */
const EXTRACTION_JSON_SHAPE = `Respond with ONLY a single JSON object (no prose, no code fences) containing only the fields the traveler actually supplied. Omit any field not mentioned. Shape:
{
  "origin": string,
  "destination": string,
  "durationDays": integer 1-30,
  "travellers": { "adults": integer >= 1, "children": integer >= 0 },
  "budgetLevel": "budget" | "mid" | "luxury",
  "diet": string,
  "pace": "relaxed" | "balanced" | "packed",
  "interests": [string, ...]
}`;

/** Build the extraction prompt; `system` starts with SYSTEM_PROMPT_PREFIX. */
export function buildExtractionPrompt(delta: string, context: TripContext): ModelPrompt {
  return {
    system: `${SYSTEM_PROMPT_PREFIX}\n\nExtract structured trip context from the latest traveler input. Never invent a detail the traveler did not supply.\n\n${EXTRACTION_JSON_SHAPE}`,
    user: `Known context so far: ${JSON.stringify(context)}\nLatest input: ${delta}`,
    maxTokens: 400,
    timeoutMs: 5000,
  };
}

/** Build the phrasing prompt; `system` starts with SYSTEM_PROMPT_PREFIX. */
export function buildPhrasePrompt(field: RequiredField, context: TripContext): ModelPrompt {
  return {
    system: `${SYSTEM_PROMPT_PREFIX}\n\nAsk one concise question (at most 160 characters) for the single missing trip field named. Return only the question text, no quotes or prose.`,
    user: `Missing field: ${field}\nKnown context so far: ${JSON.stringify(context)}`,
    maxTokens: 100,
    timeoutMs: 5000,
  };
}

/** The exact JSON shape required back from the itinerary model call. */
const ITINERARY_JSON_SHAPE = [
  "Return ONLY a single JSON object (no prose, no code fences) in EXACTLY this shape:",
  "{",
  '  "title": string,',
  '  "totalCost": number,',
  '  "days": [',
  "    {",
  '      "day": 1,',
  '      "date": "YYYY-MM-DD",',
  '      "title": string,',
  '      "theme": string,',
  '      "activities": [ { "time": "09:00", "title": string, "description": string, "cost": number } ],',
  '      "total": number',
  "    }",
  "  ]",
  "}",
  "Each day must have EXACTLY 5 time-ordered activities. totalCost = sum of every day.total. Each day.total = sum of that day's activity costs. All costs are INR estimates.",
].join("\n");

/**
 * System prompt for itinerary generation. Demands SPECIFIC, REAL, named places
 * for the exact destination (actual landmarks, neighbourhoods, dining areas),
 * never vague filler like "local lunch" or "signature experience", and a
 * geographically sensible plan. Costs are INR estimates; nothing is marked
 * confirmed/available. Starts with SYSTEM_PROMPT_PREFIX (byte-identical reuse).
 */
function buildItinerarySystem(context: TripContext): string {
  const dest = context.destination ?? "the destination";
  return [
    SYSTEM_PROMPT_PREFIX,
    "",
    `You are an expert local travel planner. Build a specific, logical, day-by-day itinerary for ${dest} using the full trip context.`,
    "",
    "Hard rules:",
    `- Name REAL, specific places in ${dest}: actual landmarks, museums, neighbourhoods, viewpoints, markets, parks and well-known dining areas. Never write vague placeholders like "local lunch", "signature experience", "afternoon activity" or "evening experience".`,
    "- Each day has EXACTLY 5 time-ordered activities and is geographically sensible (group nearby places; do not zig-zag across the city).",
    "- Respect the traveller's duration, party, budget level, diet and interests. Relaxed pace means fewer stops and more rest; packed means more.",
    "- Every cost is an INR ESTIMATE. Never mark any flight, stay, or car as confirmed or available.",
    "- Keep each activity description to one concrete sentence that references the real place.",
    "",
    ITINERARY_JSON_SHAPE,
  ].join("\n");
}

/** Build the itinerary prompt; `system` starts with SYSTEM_PROMPT_PREFIX. */
export function buildItineraryPrompt(context: TripContext): ModelPrompt {
  return {
    system: buildItinerarySystem(context),
    user: `Trip context: ${JSON.stringify(context)}`,
    maxTokens: 4000,
    timeoutMs: 40000,
  };
}

/* ===========================================================================
 * 2.2 â€” Deterministic rule-based fallback extractor and phrasing
 * ======================================================================== */

/** Keyword heuristics lifted from components/concierge-home.tsx. */
function detectDiet(text: string): string | null {
  const m = text.match(/veg(?:etarian|an)?|vegan|halal|jain|gluten(?:-free)?/);
  return m ? m[0] : null;
}
function detectBudgetLevel(text: string): string | null {
  if (/\bluxury\b/.test(text)) return "luxury";
  if (/\bbudget\b/.test(text)) return "budget";
  if (/\bmid(?:-range)?\b|\bmoderate\b/.test(text)) return "mid";
  return null;
}
function detectPace(text: string): string | null {
  if (/\brelaxed\b|\bslow\b|\bchill\b/.test(text)) return "relaxed";
  if (/\bpacked\b|\bfast\b|\bbusy\b/.test(text)) return "packed";
  if (/\bbalanced\b/.test(text)) return "balanced";
  return null;
}
function detectWhosJoining(text: string): { adults: number; children: number } | null {
  if (/\bsolo\b/.test(text)) return { adults: 1, children: 0 };
  if (/\bcouple\b|\bhoneymoon\b/.test(text)) return { adults: 2, children: 0 };
  if (/\bfamily\b/.test(text)) return { adults: 2, children: 2 };
  if (/\bfriends\b/.test(text)) return { adults: 3, children: 0 };
  return null;
}
function detectInterests(text: string): string[] | null {
  const found: string[] = [];
  for (const kw of ["adventure", "culture", "beach", "nature", "food", "nightlife", "shopping", "history"]) {
    if (new RegExp(`\\b${kw}\\b`).test(text)) found.push(kw);
  }
  return found.length > 0 ? found : null;
}

/**
 * Pure deterministic extractor used whenever the model call fails/times out or
 * returns non-JSON. Reuses `parseRoute` (origin/destination) and
 * `durationFromText` (durationDays), plus the concierge keyword heuristics.
 * Never throws (Req 2.5, 10.3; Design: deterministic FALLBACK path).
 */
export function fallbackExtract(delta: string, context: TripContext): Partial<TripContext> {
  const out: Partial<TripContext> = {};
  try {
    const text = typeof delta === "string" ? delta : "";
    const lower = text.toLowerCase();

    const route = parseRoute(text, emptyRouteState());
    if (route.origin) out.origin = route.origin;
    if (route.destination) out.destination = route.destination;

    const days = durationFromText(text);
    if (days !== null && Number.isFinite(days)) {
      const clamped = Math.trunc(days);
      if (clamped >= MIN_DURATION && clamped <= MAX_DURATION) out.durationDays = clamped;
    }

    const travellers = detectWhosJoining(lower);
    if (travellers) out.travellers = travellers;

    const budget = detectBudgetLevel(lower);
    if (budget) out.budgetLevel = budget;

    const diet = detectDiet(lower);
    if (diet) out.diet = diet;

    const pace = detectPace(lower);
    if (pace) out.pace = pace;

    const interests = detectInterests(lower);
    if (interests) out.interests = interests;
  } catch {
    // Never throw â€” degrade to whatever was parsed so far (possibly {}).
  }
  return out;
}

/** Fixed per-field fallback questions, each <= 160 chars (Req 2.3). */
const FALLBACK_QUESTIONS: Record<RequiredField, string> = {
  origin: "Which city are you travelling from?",
  destination: "Where would you like to travel to?",
  durationDays: "How many days will your trip be?",
  travellers: "Who's joining you - how many adults and children?",
  budgetLevel: "What's your budget level - budget, mid, or luxury?",
  diet: "Any food or dietary preferences we should plan around?",
  pace: "What pace would you like - relaxed, balanced, or packed?",
  interests: "What are you most interested in - culture, food, adventure, nature?",
};

/** Deterministic phrasing fallback for a single field (<= 160 chars). */
export function fallbackPhrase(field: RequiredField, _context: TripContext): string {
  const q = FALLBACK_QUESTIONS[field] ?? "Could you share a bit more about your trip?";
  return q.length > 160 ? q.slice(0, 160) : q;
}

/* ===========================================================================
 * 2.3 â€” Async primitives (bounded timeout + deterministic fallback)
 * ======================================================================== */

/** Max question length enforced on every phrasing (Req 2.3). */
const MAX_QUESTION_CHARS = 160;

/**
 * Run a model call bounded by an AbortController timeout. Resolves with the raw
 * text, or rejects on error/timeout. The timeout is treated as an error by the
 * callers (â‡’ deterministic fallback). `invokeModel` implementations that honor
 * the AbortSignal abort promptly; those that do not are still bounded by the
 * timeout race here.
 */
async function invokeWithTimeout(deps: BedrockModelDeps, prompt: ModelPrompt): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), prompt.timeoutMs);
  try {
    const result = await Promise.race<string>([
      deps.invokeModel(prompt),
      new Promise<string>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(new Error(`model call timed out after ${prompt.timeoutMs}ms`));
        });
      }),
    ]);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Async extraction: invoke the model, parse+validate the output into a
 * `Partial<TripContext>`. On ANY error/timeout/non-JSON, return the rule-based
 * `fallbackExtract`. Keys are always âŠ† schema and values always validated
 * (Property 2); the planner never breaks (Req 2.2, 2.5).
 */
export async function extractAsync(
  deps: BedrockModelDeps,
  delta: string,
  context: TripContext,
): Promise<Partial<TripContext>> {
  try {
    const text = await invokeWithTimeout(deps, buildExtractionPrompt(delta, context));
    const parsed = parseExtraction(text);
    // An empty parse on a non-empty delta still yields {} here; callers treat
    // {} as "no interpretable detail" (Req 2.5). We do NOT silently substitute
    // the fallback for a well-formed-but-empty model response.
    return parsed;
  } catch {
    return fallbackExtract(delta, context);
  }
}

/**
 * Async phrasing: invoke the model for a single field's question, clamped to
 * <= 160 chars. On any error/timeout/blank output, return `fallbackPhrase`
 * (Req 2.3).
 */
export async function phraseAsync(
  deps: BedrockModelDeps,
  field: RequiredField,
  context: TripContext,
): Promise<string> {
  try {
    const raw = await invokeWithTimeout(deps, buildPhrasePrompt(field, context));
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (trimmed.length === 0) return fallbackPhrase(field, context);
    return trimmed.length > MAX_QUESTION_CHARS ? trimmed.slice(0, MAX_QUESTION_CHARS) : trimmed;
  } catch {
    return fallbackPhrase(field, context);
  }
}

/** Extract the first balanced top-level JSON object, tolerating code fences/prose. */
function extractJsonObject(text: string): string | null {
  let s = text.trim();
  const fence = s.match(new RegExp("```(?:json)?\\s*([\\s\\S]*?)```", "i"));
  if (fence && fence[1]) s = fence[1].trim();
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}
function itinNum(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n) : fallback;
}
function itinStr(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

/** Parse a model itinerary payload into the `Itinerary` shape, or null. */
function parseItinerary(text: string): Itinerary | null {
  if (typeof text !== "string" || text.trim().length === 0) return null;
  const json = extractJsonObject(text);
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.days) || obj.days.length === 0) return null;
  const days = obj.days
    .map((day, idx) => {
      if (typeof day !== "object" || day === null) return null;
      const d = day as Record<string, unknown>;
      const rawActs = Array.isArray(d.activities) ? d.activities : [];
      const activities = rawActs
        .map((a) => {
          if (typeof a !== "object" || a === null) return null;
          const ar = a as Record<string, unknown>;
          const title = itinStr(ar.title ?? ar.name);
          if (!title) return null;
          return {
            time: itinStr(ar.time, "09:00"),
            title,
            description: itinStr(ar.description ?? ar.detail, title),
            cost: itinNum(ar.cost ?? ar.price, 0),
          };
        })
        .filter((a): a is { time: string; title: string; description: string; cost: number } => a !== null);
      if (activities.length === 0) return null;
      const total = activities.reduce((s, a) => s + a.cost, 0);
      return {
        day: itinNum(d.day, idx + 1),
        date: itinStr(d.date, ""),
        title: itinStr(d.title, "Day " + (idx + 1)),
        theme: itinStr(d.theme, ""),
        activities,
        total,
      };
    })
    .filter((d): d is NonNullable<typeof d> => d !== null);
  if (days.length === 0) return null;
  const totalCost = days.reduce((s, d) => s + d.total, 0);
  return { title: itinStr(obj.title, "Your trip"), totalCost, days } as Itinerary;
}

/**
 * Async itinerary generation for a complete context. On ANY error/timeout/
 * malformed output, falls back to the deterministic `buildItinerary` so the
 * planner never breaks (Req 2.8, 10.3). The generated itinerary presents costs
 * as estimates and never marks any flight/stay/car confirmed or available
 * (Req 2.9).
 */
export async function generateItineraryAsync(
  deps: BedrockModelDeps,
  context: TripContext,
): Promise<Itinerary> {
  const now = deps.now ?? (() => Date.now());
  const fallback = (): Itinerary =>
    buildItinerary({
      destination: context.destination ?? "your destination",
      startDate: new Date(now()).toISOString().slice(0, 10),
      days: context.durationDays ?? 4,
      vibes: context.interests,
    });
  try {
    const text = await invokeWithTimeout(deps, buildItineraryPrompt(context));
    return parseItinerary(text) ?? fallback();
  } catch {
    return fallback();
  }
}

/* ===========================================================================
 * 2.4 â€” Synchronous model adapter
 * ======================================================================== */

/**
 * Build a synchronous `ExtractionModel` the pure controller can call directly,
 * closing over values already resolved asynchronously by the route. `extract`
 * returns the pre-resolved `extracted`; `phrase` delegates to `phraseFor`. This
 * lets `advance()`/`runPlanningTurn()` consume pre-resolved async results with
 * NO change to the controller signature (Req 2.1, 2.4; Design: Planning-turn
 * request/response flow â†’ sync adapter).
 */
export function syncModelFrom(
  extracted: Partial<TripContext>,
  phraseFor: (field: RequiredField, context: TripContext) => string,
): ExtractionModel {
  return {
    extract: (_delta: string, _context: TripContext): Partial<TripContext> => extracted,
    phrase: (field: RequiredField, context: TripContext): string => phraseFor(field, context),
  };
}

/* ===========================================================================
 * Real Bedrock invoke wrapper (lazily constructed; never called at module top)
 * ======================================================================== */

/**
 * Construct a real `invokeModel` backed by `@aws-sdk/client-bedrock-runtime`,
 * resolving the model id + region from `awsConfig.bedrock`. The AWS SDK is
 * imported DYNAMICALLY inside the returned function so this module stays
 * unit-testable without the SDK and performs no AWS work at import time (Req
 * 2.7, 3.1). Credentials resolve via the Amplify execution role at runtime â€”
 * no secret is read here (Req 3.2, 3.3). Tests inject a mock instead of calling
 * this.
 */
export function createBedrockInvoke(): BedrockModelDeps["invokeModel"] {
  const { modelId, region } = awsConfig.bedrock;
  return async (prompt: ModelPrompt): Promise<string> => {
    // Dynamic import: no static top-level dependency on the AWS SDK.
    const { BedrockRuntimeClient, ConverseCommand } = await import(
      "@aws-sdk/client-bedrock-runtime"
    );
    const client = new BedrockRuntimeClient({ region });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), prompt.timeoutMs);
    try {
      const command = new ConverseCommand({
        modelId,
        system: [{ text: prompt.system }],
        messages: [{ role: "user", content: [{ text: prompt.user }] }],
        inferenceConfig: { maxTokens: prompt.maxTokens },
      });
      const response = await client.send(command, { abortSignal: controller.signal });
      const blocks = response.output?.message?.content ?? [];
      const textParts = blocks
        .map((block) => (typeof block.text === "string" ? block.text : ""))
        .filter((t) => t.length > 0);
      return textParts.join("\n");
    } finally {
      clearTimeout(timer);
    }
  };
}
/* Field-aware deterministic fallback (realtime-ai follow-up fix). */
function titleCasePlace(v: string): string {
  return v.trim().replace(new RegExp("\\b\\w", "g"), (c) => c.toUpperCase()).slice(0, 100);
}

function parseTravellersText(text: string): { adults: number; children: number } | null {
  const lower = text.toLowerCase();
  const adultsM = lower.match(new RegExp("(\\d{1,2})\\s*adult"));
  const childM = lower.match(new RegExp("(\\d{1,2})\\s*(?:child|children|kid|infant)"));
  let adults = adultsM ? Number(adultsM[1]) : NaN;
  const children = childM ? Number(childM[1]) : 0;
  if (!Number.isFinite(adults)) {
    const bare = lower.match(new RegExp("^\\s*(\\d{1,2})\\s*(?:people|persons|pax|travellers?|travelers?|adults?)?\\s*(?:only)?\\s*$"));
    if (bare) adults = Number(bare[1]);
  }
  if (!Number.isFinite(adults) || adults < 1) return null;
  return { adults: Math.trunc(adults), children: Number.isFinite(children) && children >= 0 ? Math.trunc(children) : 0 };
}

export function fallbackExtractForField(
  delta: string,
  context: TripContext,
  field: RequiredField | undefined,
): Partial<TripContext> {
  const base = fallbackExtract(delta, context);
  if (field === undefined) return base;
  if ((base as Record<string, unknown>)[field] !== undefined) return base;
  const text = typeof delta === "string" ? delta.trim() : "";
  if (text.length === 0) return base;
  const lower = text.toLowerCase();
  const STOP = new Set(["hi","hey","hello","yo","hiya","namaste","ok","okay","yes","no","yeah","yep","nope","sure","thanks","please","help","start","hmm","idk","none","na","test","what","who"]);
  const placeText = text.replace(new RegExp("^\\s*(from|to)\\s+","i"), "").trim();
  const looksLikePlace = !STOP.has(lower) && !STOP.has(placeText.toLowerCase()) && placeText.length >= 3 && new RegExp("^[a-z .'-]{3,45}$","i").test(placeText) && new RegExp("[aeiou]","i").test(placeText);
  switch (field) {
    case "origin":
      if (looksLikePlace) base.origin = titleCasePlace(placeText);
      break;
    case "destination":
      if (looksLikePlace) base.destination = titleCasePlace(placeText);
      break;
    case "durationDays": {
      const bare = text.match(new RegExp("^\\s*(\\d{1,2})\\s*$"));
      if (bare) {
        const n = Number(bare[1]);
        if (n >= MIN_DURATION && n <= MAX_DURATION) base.durationDays = n;
      }
      break;
    }
    case "travellers": {
      const t = parseTravellersText(text);
      if (t) base.travellers = t;
      break;
    }
    case "budgetLevel": {
      if (/budget|cheap|economical/.test(lower)) base.budgetLevel = "budget";
      else if (/lux/.test(lower)) base.budgetLevel = "luxury";
      else if (/mid|moderate|standard/.test(lower)) base.budgetLevel = "mid";
      break;
    }
    case "pace": {
      if (/relax|slow|chill|easy/.test(lower)) base.pace = "relaxed";
      else if (/pack|fast|busy|intense/.test(lower)) base.pace = "packed";
      else if (/balanc|moderate/.test(lower)) base.pace = "balanced";
      break;
    }
    case "diet": {
      if (/^(no|none|any|no preference|anything)/.test(lower)) base.diet = "no preference";
      else base.diet = text.slice(0, 60);
      break;
    }
    case "interests": {
      const parts = text.split(new RegExp("[,&/]|\\band\\b")).map((p) => p.trim()).filter((p) => p.length > 0);
      if (parts.length > 0) base.interests = parts.slice(0, 6);
      break;
    }
  }
  return base;
}

