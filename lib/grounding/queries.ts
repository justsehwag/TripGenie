import type { GroundingInput } from "@/lib/grounding/types";

/** Maximum length of one Grounding_Query, in characters. */
export const MAX_QUERY_CHARS = 120;

/** Strip Unicode control characters (Cc) and collapse whitespace runs. Never throws. */
export function cleanText(s: unknown): string {
  if (typeof s !== "string") return "";
  return s
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Clamp a trip duration to a whole number from 1 to 30. */
export function clampDays(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 1;
  const r = Math.round(n);
  if (r < 1) return 1;
  if (r > 30) return 30;
  return r;
}

/** Keep the first `max` code points, then trim. */
function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  return Array.from(s).slice(0, max).join("").trim();
}

function length(s: string): number {
  return Array.from(s).length;
}

/**
 * Build `${prefix}${destination}${vibe ? " " + vibe : ""}${suffix}` within the cap.
 * Vibe is truncated first, then destination. Fixed words are never cut.
 */
function fit(prefix: string, dest: string, vibe: string, suffix: string): string {
  const fixed = length(prefix) + length(suffix);
  let d = dest;
  let v = vibe;
  const total = () => fixed + length(d) + (v ? 1 + length(v) : 0);
  let over = total() - MAX_QUERY_CHARS;
  if (over > 0 && v) {
    // Removing the whole vibe also removes its leading space.
    const target = length(v) - over;
    v = target > 0 ? truncate(v, target) : "";
    over = total() - MAX_QUERY_CHARS;
  }
  if (over > 0) d = truncate(d, length(d) - over);
  return `${prefix}${d}${v ? ` ${v}` : ""}${suffix}`.replace(/\s+/gu, " ").trim();
}

/**
 * Build exactly 3 queries (things to do, N-day itinerary, local food), or [] when the
 * destination is empty after cleaning. Pure and deterministic.
 */
export function buildGroundingQueries(input: GroundingInput): string[] {
  try {
    const dest = cleanText(input?.destination);
    if (!dest) return [];
    const vibe = cleanText(input?.vibe);
    const budget = cleanText(input?.budgetLevel).toLowerCase();
    const budgetWord = budget === "budget" || budget === "luxury" ? budget : "";
    const days = clampDays(input?.durationDays);

    return [
      fit("best things to do in ", dest, vibe, budgetWord ? ` ${budgetWord}` : ""),
      fit(`${days} day itinerary `, dest, "", ""),
      fit("local food ", dest, "", ""),
    ];
  } catch {
    return [];
  }
}
