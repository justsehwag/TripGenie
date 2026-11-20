/**
 * Quick_Form pure logic (trip-planning-v2, task 2.1).
 *
 * Framework-free: no React, Next, network or clock access. "Today" is injected
 * by the caller (use `todayIst()` from `lib/ist-time.ts` at the call site).
 *
 * Conflicts applied: C2 (inclusive day count), C3 (adults + children <= 9),
 * C4 (duration capped at 30 days).
 */

import type { TripContext } from "./types";
import type { DateHints } from "./trip-context-map";

export type BudgetLevel = "budget" | "mid" | "luxury";
export const BUDGET_LEVELS: readonly BudgetLevel[] = ["budget", "mid", "luxury"];

/** Vibe chips map 1:1 to TripContext.interests strings. */
export const VIBE_CHIPS: readonly string[] = [
  "Culture",
  "Food",
  "Adventure",
  "Nature",
  "Beaches",
  "Nightlife",
  "Shopping",
  "History",
];

export const MIN_ADULTS = 1;
export const MAX_ADULTS = 9;
export const MIN_CHILDREN = 0;
export const MAX_CHILDREN = 8;
/** C3: /api/trip-live and validateFlightQuery accept 1-9 travellers in total. */
export const MAX_TOTAL_TRAVELLERS = 9;
export const MIN_DAYS = 1;
export const MAX_DAYS = 30;

export interface QuickFormValues {
  origin: string;
  destination: string;
  /** YYYY-MM-DD or "" */
  departDate: string;
  /** YYYY-MM-DD or "" */
  returnDate: string;
  adults: number;
  children: number;
  budgetLevel: BudgetLevel | "";
  vibes: string[];
}

export type QuickFormField =
  | "origin"
  | "destination"
  | "departDate"
  | "returnDate"
  | "travellers";
export type QuickFormErrors = Partial<Record<QuickFormField, string>>;

export const REQUIRED_FIELDS = ["origin", "destination", "departDate", "returnDate"] as const;

export const QUICK_FORM_MESSAGES = {
  required: "This field is required.",
  returnBeforeDepart: "Return date must be on or after the departure date.",
  departInPast: "Departure date cannot be in the past.",
  samePlace: "Destination must be different from the origin.",
  travellers: "Choose 1 to 9 adults, 0 to 8 children, and at most 9 travellers in total.",
  longTrip: "The itinerary covers the first 30 days.",
} as const;

/* -------------------------------------------------------------------------- */
/* Places                                                                      */
/* -------------------------------------------------------------------------- */

/** Trim and collapse inner whitespace. Idempotent. */
export function normalizePlace(input: string): string {
  return typeof input === "string" ? input.trim().replace(/\s+/g, " ") : "";
}

/** Trim, collapse whitespace and case-fold comparison. Blank never equals blank. */
export function samePlace(a: string, b: string): boolean {
  const x = normalizePlace(a).toLowerCase();
  const y = normalizePlace(b).toLowerCase();
  return x !== "" && x === y;
}

/* -------------------------------------------------------------------------- */
/* Dates                                                                       */
/* -------------------------------------------------------------------------- */

const MS_PER_DAY = 86_400_000;

/** Parse a real calendar date `YYYY-MM-DD` to a UTC day number, else NaN. */
function isoToUtcMs(iso: unknown): number {
  if (typeof iso !== "string") return Number.NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return Number.NaN;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== mo - 1 ||
    back.getUTCDate() !== d
  ) {
    return Number.NaN;
  }
  return t;
}

/** True for a real `YYYY-MM-DD` calendar date. */
export function isIsoDate(value: unknown): value is string {
  return !Number.isNaN(isoToUtcMs(value));
}

/**
 * Whole inclusive days between two ISO dates: (ret - dep) + 1 (C2).
 * Returns 0 for a bad date.
 */
export function inclusiveDays(dep: string, ret: string): number {
  const a = isoToUtcMs(dep);
  const b = isoToUtcMs(ret);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / MS_PER_DAY) + 1;
}

/** clamp(inclusiveDays, MIN_DAYS, MAX_DAYS). */
export function durationDaysFor(dep: string, ret: string): number {
  const n = inclusiveDays(dep, ret);
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, n));
}

/** C4: true when the date span is longer than the 30-day itinerary cap. */
export function exceedsMaxDays(dep: string, ret: string): boolean {
  return inclusiveDays(dep, ret) > MAX_DAYS;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

function isCount(n: unknown, min: number, max: number): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;
}

/** Fields that are empty after trimming (blank-on-blur "required" errors). */
export function missingRequired(v: QuickFormValues): QuickFormField[] {
  return REQUIRED_FIELDS.filter((f) => String(v[f] ?? "").trim() === "");
}

/**
 * Rule order (one message per field):
 *  1. required fields are NOT reported here (UI shows them on blur;
 *     `canGenerate` still requires them),
 *  2. return < depart -> returnDate,
 *  3. depart < today -> departDate,
 *  4. samePlace(origin, destination) -> destination,
 *  5. adults/children out of range or adults + children > 9 -> travellers.
 */
export function validateQuickForm(v: QuickFormValues, todayIstDate: string): QuickFormErrors {
  const errors: QuickFormErrors = {};

  const dep = isoToUtcMs(v.departDate);
  const ret = isoToUtcMs(v.returnDate);
  if (!Number.isNaN(dep) && !Number.isNaN(ret) && ret < dep) {
    errors.returnDate = QUICK_FORM_MESSAGES.returnBeforeDepart;
  }

  const today = isoToUtcMs(todayIstDate);
  if (!Number.isNaN(dep) && !Number.isNaN(today) && dep < today) {
    errors.departDate = QUICK_FORM_MESSAGES.departInPast;
  }

  if (samePlace(v.origin, v.destination)) {
    errors.destination = QUICK_FORM_MESSAGES.samePlace;
  }

  if (
    !isCount(v.adults, MIN_ADULTS, MAX_ADULTS) ||
    !isCount(v.children, MIN_CHILDREN, MAX_CHILDREN) ||
    v.adults + v.children > MAX_TOTAL_TRAVELLERS
  ) {
    errors.travellers = QUICK_FORM_MESSAGES.travellers;
  }

  return errors;
}

/** No validation errors, all four required fields present, and both dates real. */
export function canGenerate(v: QuickFormValues, todayIstDate: string): boolean {
  if (missingRequired(v).length > 0) return false;
  if (!isIsoDate(v.departDate) || !isIsoDate(v.returnDate)) return false;
  return Object.keys(validateQuickForm(v, todayIstDate)).length === 0;
}

/* -------------------------------------------------------------------------- */
/* Context mapping                                                             */
/* -------------------------------------------------------------------------- */

export interface QuickFormWrite {
  context: Pick<
    TripContext,
    "origin" | "destination" | "durationDays" | "travellers" | "budgetLevel" | "interests"
  >;
  dates: Required<Pick<DateHints, "checkIn" | "checkOut" | "departDate" | "returnDate">>;
}

/**
 * Req 3.1-3.5, 3.7. Never sets `diet` or `pace`; omits `budgetLevel` and
 * `interests` when the traveller did not choose them.
 */
export function quickFormToWrite(v: QuickFormValues): QuickFormWrite {
  const context: QuickFormWrite["context"] = {
    origin: normalizePlace(v.origin),
    destination: normalizePlace(v.destination),
    durationDays: durationDaysFor(v.departDate, v.returnDate),
    travellers: { adults: v.adults, children: v.children },
  };
  if (v.budgetLevel !== "") context.budgetLevel = v.budgetLevel;
  if (v.vibes.length > 0) context.interests = [...v.vibes];

  return {
    context,
    dates: {
      checkIn: v.departDate,
      checkOut: v.returnDate,
      departDate: v.departDate,
      returnDate: v.returnDate,
    },
  };
}

function asCount(n: unknown, fallback: number, min: number, max: number): number {
  return typeof n === "number" && Number.isFinite(n)
    ? Math.min(max, Math.max(min, Math.trunc(n)))
    : fallback;
}

function asDate(...candidates: unknown[]): string {
  for (const c of candidates) if (isIsoDate(c)) return c;
  return "";
}

/** Req 2.4, 4.2. Total: tolerates missing and malformed context/dates. */
export function contextToQuickForm(ctx: TripContext, dates: DateHints): QuickFormValues {
  const c: Partial<TripContext> =
    ctx && typeof ctx === "object" ? ctx : {};
  const d: Partial<DateHints> = dates && typeof dates === "object" ? dates : {};

  const party =
    c.travellers && typeof c.travellers === "object" ? c.travellers : undefined;
  const budget = (BUDGET_LEVELS as readonly unknown[]).includes(c.budgetLevel)
    ? (c.budgetLevel as BudgetLevel)
    : "";
  const vibes = Array.isArray(c.interests)
    ? c.interests.filter((x): x is string => typeof x === "string")
    : [];

  return {
    origin: typeof c.origin === "string" ? normalizePlace(c.origin) : "",
    destination: typeof c.destination === "string" ? normalizePlace(c.destination) : "",
    departDate: asDate(d.departDate, d.checkIn),
    returnDate: asDate(d.returnDate, d.checkOut),
    adults: asCount(party?.adults, 1, MIN_ADULTS, MAX_ADULTS),
    children: asCount(party?.children, 0, MIN_CHILDREN, MAX_CHILDREN),
    budgetLevel: budget,
    vibes,
  };
}
