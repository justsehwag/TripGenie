/**
 * User-facing strings of the trustworthy itinerary feature.
 *
 * Pure, client-safe and total: nothing here throws. No string claims that a
 * plan, day, stop or price is guaranteed, confirmed, bookable or 100% accurate.
 */
import type { BatchReason } from "@/lib/itinerary/batch-wire";
import { sanitizeDisplayText } from "@/lib/itinerary/text";

export { verifiedLabel, activitiesLabel } from "@/lib/itinerary/completeness";
export { travelLabel } from "@/lib/itinerary/geo";

export const VERIFIED_TEXT = "Verified on Google Maps";
export const TRUST_SENTENCE =
  "Places come from Google Maps. Opening hours, availability and prices can change, so check before you go.";
export const LEGACY_NOTE = "Saved before place verification";
export const LIMIT_NOTE = "Verified plans cover up to 14 days";
export const TOTAL_NOTE = "Total excludes unverified days";
export const failureTitle = "We could not verify a plan for this trip yet";

export const NO_PRICE_TEXT = "No price found online";
export const NO_TIP_TEXT = "No tip found online";
export const NO_BOOKING_TEXT = "No booking information found online";
export const NO_BEST_TIME_TEXT = "No best time found online";
export const NOT_CHECKED_TEXT = "Not checked";
export const NOT_CHECKED_UNAVAILABLE_TEXT = "Not checked (price lookup unavailable)";
export const HOURS_NOT_LISTED = "Hours not listed";
export const TYPICAL_HOURS = "Typical hours";

const PLACE_MAX_CHARS = 120;

function dayNumber(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

/** "Day 4" or "Days 4 to 6". */
function dayRange(from: number, to: number): string {
  const a = dayNumber(from);
  const b = dayNumber(to);
  return b > a ? `Days ${a} to ${b}` : `Day ${a}`;
}

const CERTAINTY_CLAIM = /confirmed|bookable|guaranteed|100% accurate/i;

/** True when the text claims certainty ("confirmed", "bookable", "guaranteed", "100% accurate"). */
export function hasCertaintyClaim(s: unknown): boolean {
  return typeof s === "string" && CERTAINTY_CLAIM.test(s);
}

export function verifiedLinkLabel(place: string): string {
  const cleaned = sanitizeDisplayText(place, PLACE_MAX_CHARS);
  const name = hasCertaintyClaim(cleaned) ? "" : cleaned;
  return name
    ? `${VERIFIED_TEXT}: ${name}, opens in a new tab`
    : `${VERIFIED_TEXT}, opens in a new tab`;
}

/** "Day 4 could not be verified" / "Days 4 to 6 could not be verified". */
export function withheldText(from: number, to: number): string {
  return `${dayRange(from, to)} could not be verified`;
}

/** "Retry day 4" / "Retry days 4 to 6". */
export function retryLabel(from: number, to: number): string {
  const a = dayNumber(from);
  const b = dayNumber(to);
  return b > a ? `Retry days ${a} to ${b}` : `Retry day ${a}`;
}

export function failureReason(reason: BatchReason | string | undefined | null): string {
  if (reason === "not-configured") return "Verification is not configured.";
  if (reason === "unverified") return "We could not verify enough places for the first days.";
  return "Verification is temporarily unavailable.";
}

export type ProgressKind = "verifying" | "added" | "withheld";

/** "Verifying days 4 to 6…", "Added days 4 to 6", "Days 4 to 6 could not be verified". */
export function progressText(kind: ProgressKind, from: number, to: number): string {
  const a = dayNumber(from);
  const b = dayNumber(to);
  const range = b > a ? `days ${a} to ${b}` : `day ${a}`;
  if (kind === "verifying") return `Verifying ${range}\u2026`;
  if (kind === "added") return `Added ${range}`;
  return withheldText(a, b);
}

/** "1 stop" / "3 stops" for the collapsed day summary. */
export function stopsLabel(count: number): string {
  const n = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
  return `${n} ${n === 1 ? "stop" : "stops"}`;
}

/** "0 without a web price", "1 without a web price", "3 without a web price". */
export function unpricedLabel(n: number): string {
  const count = Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  return `${count} without a web price`;
}

/**
 * Badge text for a priced Stop. Places-first Stops (those with webDetails) say
 * "Web estimate"; legacy Stops keep the existing text.
 */
export function priceBadgeText(
  a: { priceSource?: "ai" | "estimated" | "web" | string; webDetails?: unknown } | null | undefined,
): string {
  if (a && a.webDetails !== undefined && a.webDetails !== null) return "Web estimate";
  const source = a?.priceSource;
  if (source === "web") return "Web price";
  if (source === "ai") return "AI estimate";
  return "estimated";
}

/** Notice when the chosen dates cover a different number of days than the trip length. */
export function dateSpanNotice(span: number | null, tripLength: number): string | null {
  if (typeof span !== "number" || !Number.isFinite(span) || typeof tripLength !== "number" || !Number.isFinite(tripLength)) {
    return null;
  }
  if (span === tripLength) return null;
  if (span < tripLength) {
    return `Your dates cover ${span} ${span === 1 ? "day" : "days"}. Planning ${tripLength} days, so days after day ${span} are dated after your end date.`;
  }
  return `Your dates cover ${span} days. Planning ${tripLength} ${tripLength === 1 ? "day" : "days"}.`;
}

export const TIP_LABEL = "Tip";
export const BOOKING_LABEL = "Booking";
export const BEST_TIME_LABEL = "Best time";

/** Summary label for the activities line when any Stop is a places-first Stop. */
export const ACTIVITIES_WEB_ONLY_LABEL = "Activities (web prices only)";
