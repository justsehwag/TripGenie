/**
 * Honesty screen for Trip Assistant output (Requirements 12.1, 12.2).
 *
 * Pure and total: nothing here throws. A reply or proposal summary that
 * claims certainty ("confirmed", "bookable", "guaranteed", "100% accurate")
 * is replaced by fixed neutral wording.
 *
 * Matching is case-insensitive and also catches the phrases inside longer
 * words (for example "unconfirmed"), so it is a superset of word-boundary
 * matching and of `hasCertaintyClaim` in lib/itinerary/labels.ts. That keeps
 * the guarantee that screened text never contains a banned phrase.
 */
import { hasCertaintyClaim } from "@/lib/itinerary/labels";

export const BANNED_PHRASES = ["confirmed", "bookable", "guaranteed", "100% accurate"] as const;

export const NEUTRAL_REPLY =
  "I can't verify that. Please check prices, hours and availability with the venue before you travel.";

export const NEUTRAL_SUMMARY = "Edit to your plan";

/** Matches each banned phrase; "100%" may be followed by optional whitespace before "accurate". */
const BANNED_PATTERN = /confirmed|bookable|guaranteed|100\s*%\s*accurate/i;

/** True when the text contains a banned phrase in any letter case. */
export function containsBannedPhrase(text: unknown): boolean {
  if (typeof text !== "string") return false;
  return BANNED_PATTERN.test(text) || hasCertaintyClaim(text);
}

export interface ScreenResult {
  text: string;
  replaced: boolean;
}

/** Returns the text unchanged, or the neutral reply when it holds a banned phrase. */
export function screenReply(text: string): ScreenResult {
  const value = typeof text === "string" ? text : "";
  if (containsBannedPhrase(value)) return { text: NEUTRAL_REPLY, replaced: true };
  return { text: value, replaced: false };
}

/**
 * Screens a proposal summary. When it matches, `fallback` (a neutral summary
 * built from the operation, such as "Replace stop 2 on day 3") is used instead.
 * The fallback is itself screened, so the result never holds a banned phrase.
 */
export function screenSummary(summary: string, fallback: string): ScreenResult {
  const value = typeof summary === "string" ? summary : "";
  if (!containsBannedPhrase(value)) return { text: value, replaced: false };
  const safe = typeof fallback === "string" && fallback.trim() && !containsBannedPhrase(fallback)
    ? fallback
    : NEUTRAL_SUMMARY;
  return { text: safe, replaced: true };
}
