/**
 * Cost classifier: maps an activity title to exactly one CostClass.
 * Pure and total: no React, Next, AWS or network imports; never throws.
 */
import type { CostBasis, CostClass } from "./cost-caps";
import type { ActivityCategory } from "./types";

export interface ClassifyContext {
  origin?: string;
  destination?: string;
}

const STAY_RE = /\b(check[\s-]?in|stay at|settle into)\b/i;
const STAY_PLACE_RE = /\b(hotel|resort|homestay)\b/i;
const MEAL_RE = /\b(breakfast|brunch|lunch|dinner|meal|cafe|restaurant|street food|snack)\b/i;
const TRANSFER_RE = /\b(transfer|drive|cab|taxi|train|bus|flight|ride)\b/i;
const DIRECTION_RE = /\b(from|to|journey|arrive|depart)\b/i;
const SHOPPING_RE = /\b(shopping|shop|mall|bazaar|souvenir|handicraft|leather)\b/i;
const FREE_SIGHT_RE = /\b(fort|temple|beach|lake|park|viewpoint|ghat|garden|walk|sunset|sunrise)\b/i;
const PAID_SIGHT_RE = /\b(museum|palace|gallery|zoo|safari|cruise|show|tour|tomb|monument|ticket|entry)\b/i;
const GROUP_VEHICLE_RE = /\b(cab|taxi|auto|private car|driver)\b/i;

/** Lower-cased first comma segment of a place string, or "" when unusable. */
function placeName(s: unknown): string {
  if (typeof s !== "string") return "";
  return (s.split(",")[0] ?? "").trim().toLowerCase();
}

function mentions(title: string, place: string): boolean {
  return place.length > 0 && title.toLowerCase().includes(place);
}

export function classifyActivity(
  a: { title: string; category?: ActivityCategory },
  ctx: ClassifyContext,
): CostClass {
  try {
    const title = typeof a?.title === "string" ? a.title : "";
    const origin = placeName(ctx?.origin);
    const dest = placeName(ctx?.destination);
    const hasMeal = MEAL_RE.test(title);

    // 1. stay check-in
    if (STAY_RE.test(title) || (STAY_PLACE_RE.test(title) && !hasMeal)) return "stay-checkin";

    // 2. route transport (origin <-> destination)
    const namesRoute = mentions(title, origin) || mentions(title, dest);
    if (TRANSFER_RE.test(title) && namesRoute && DIRECTION_RE.test(title)) return "route-transport";
    if (a?.category === "transfer" && mentions(title, origin)) return "route-transport";

    // 3. shopping
    if (SHOPPING_RE.test(title)) return "shopping";
    // 4. meal
    if (hasMeal) return "meal";
    // 5. local transfer
    if (TRANSFER_RE.test(title)) return "local-transfer";
    // 6. free sight
    if (FREE_SIGHT_RE.test(title)) return "free-sight";
    // 7. paid sight
    if (PAID_SIGHT_RE.test(title)) return "paid-sight";
    // 8. other
    return "other";
  } catch {
    return "other";
  }
}

/** Group basis only for local transfers that name a hired vehicle. */
export function basisFor(c: CostClass, title: string): CostBasis {
  return c === "local-transfer" && GROUP_VEHICLE_RE.test(typeof title === "string" ? title : "")
    ? "group"
    : "person";
}

/** False for classes already covered by the stay or route line, or optional spend. */
export function isPriceable(c: CostClass): boolean {
  return c !== "stay-checkin" && c !== "route-transport" && c !== "shopping";
}
