/**
 * Cost caps: indicative INR planning ceilings per cost class, budget level and
 * city tier, plus the looser Web_Sanity_Bound used for verified web prices.
 * Pure: no React, Next, AWS or network imports.
 */

export type BudgetLevel = "budget" | "mid" | "luxury";
export type CityTier = "metro" | "tier2" | "small";
export type CostClass =
  | "stay-checkin"
  | "route-transport"
  | "shopping"
  | "free-sight"
  | "paid-sight"
  | "meal"
  | "local-transfer"
  | "other";
export type CostBasis = "person" | "group";

export const CAPPED_BASIS = "Adjusted to a typical range for this city and budget";

/** Web_Sanity_Bound multiplier over the cap. */
export const WEB_BOUND_MULTIPLIER = 2;
/** Vehicle seat count used to scale a per-person quote to a group price. */
export const VEHICLE_SEATS = 4;

const BUDGET_LEVELS: readonly BudgetLevel[] = ["budget", "mid", "luxury"];

// Each row: [small, tier2, metro] per budget level (budget, mid, luxury).
type Row = readonly [number, number, number];
type ClassCaps = readonly [Row, Row, Row];

const ZERO: ClassCaps = [
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
];

const CAPS: Record<CostClass, ClassCaps> = {
  "stay-checkin": ZERO,
  "route-transport": ZERO,
  shopping: ZERO,
  "free-sight": [
    [50, 100, 150],
    [50, 100, 150],
    [100, 150, 250],
  ],
  "paid-sight": [
    [100, 250, 500],
    [250, 600, 1200],
    [600, 1500, 3000],
  ],
  meal: [
    [150, 250, 400],
    [350, 600, 1000],
    [900, 1800, 3500],
  ],
  "local-transfer": [
    [400, 600, 900],
    [800, 1200, 2000],
    [2000, 3000, 5000],
  ],
  other: [
    [200, 400, 800],
    [500, 1000, 2000],
    [1500, 3000, 6000],
  ],
};

const TIER_INDEX: Record<CityTier, 0 | 1 | 2> = { small: 0, tier2: 1, metro: 2 };

const METROS = [
  "delhi", "new delhi", "mumbai", "bengaluru", "bangalore", "chennai",
  "kolkata", "hyderabad", "pune", "ahmedabad",
];
const SMALL_TOWNS = [
  "vaniyambadi", "yelagiri", "ooty", "udhagamandalam", "munnar", "hampi",
  "coorg", "kodaikanal", "yercaud", "valparai", "wayanad", "tawang",
  "spiti", "kasol", "mcleodganj", "auli", "lansdowne", "chikmagalur",
];
// Foreign destinations use metro caps (known limit).
const FOREIGN = [
  "singapore", "dubai", "bangkok", "london", "paris", "new york", "tokyo",
  "bali", "kuala lumpur", "hong kong", "sydney", "colombo", "kathmandu",
];

export function resolveBudgetLevel(raw: unknown): BudgetLevel {
  if (typeof raw !== "string") return "mid";
  const v = raw.trim().toLowerCase();
  return (BUDGET_LEVELS as readonly string[]).includes(v) ? (v as BudgetLevel) : "mid";
}

function hasWord(text: string, word: string): boolean {
  const i = text.indexOf(word);
  if (i < 0) return false;
  const before = i === 0 ? " " : text[i - 1];
  const after = i + word.length >= text.length ? " " : text[i + word.length];
  return !/[a-z]/.test(before) && !/[a-z]/.test(after);
}

export function resolveCityTier(destination: unknown): CityTier {
  if (typeof destination !== "string") return "tier2";
  const d = destination.toLowerCase();
  if (SMALL_TOWNS.some((w) => hasWord(d, w))) return "small";
  if (METROS.some((w) => hasWord(d, w)) || FOREIGN.some((w) => hasWord(d, w))) return "metro";
  return "tier2";
}

export function capFor(c: CostClass, b: BudgetLevel, t: CityTier): number {
  const row = CAPS[c]?.[BUDGET_LEVELS.indexOf(b)] ?? CAPS.other[1];
  return row[TIER_INDEX[t] ?? 1];
}

export function estimateFor(c: CostClass, b: BudgetLevel, t: CityTier): number {
  return Math.round(capFor(c, b, t) / 2);
}

export function clampToCap(
  inr: number,
  c: CostClass,
  b: BudgetLevel,
  t: CityTier,
): { inr: number; capped: boolean } {
  const safe = Number.isFinite(inr) && inr > 0 ? inr : 0;
  const cap = capFor(c, b, t);
  return safe > cap ? { inr: cap, capped: true } : { inr: safe, capped: false };
}

/** Maximum INR the server accepts for a verified web price. */
export function webBoundFor(c: CostClass, b: BudgetLevel, t: CityTier): number {
  const base = c === "free-sight" ? capFor("paid-sight", b, t) : capFor(c, b, t);
  return Math.round(base * WEB_BOUND_MULTIPLIER);
}
