/**
 * Deterministic text snapshots of the itinerary and profile for the model.
 * Pure. Never throws. Field values are flattened to one line and cannot
 * contain newlines, control characters or the "|" field separator, so a
 * stored value cannot fake extra lines or fields.
 */
import type { ProfileSubset, WireItinerary, WireStop } from "./types";

export const DESCRIPTION_MAX = 160;
export const NO_PROFILE_TEXT = "No saved profile";

const FIELD_MAX = 200;
const NAME_MAX = 60;
const CITY_MAX = 80;
const STYLE_MAX = 60;
const PARTY_MAX = 50;

// C0/C1 controls, DEL, line/paragraph separators, zero-width and bidi marks.
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** One-line, control-free, separator-free text, truncated to `max` characters. */
export function cleanField(value: unknown, max: number = FIELD_MAX): string {
  try {
    if (value === null || value === undefined) return "";
    const raw = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
    const flat = raw.replace(CONTROL_RE, " ").replace(/\|/g, "/").replace(/\s+/g, " ").trim();
    return flat.length > max ? flat.slice(0, max).trimEnd() : flat;
  } catch {
    return "";
  }
}

function truncateDescription(value: unknown): string {
  const flat = cleanField(value, Number.MAX_SAFE_INTEGER);
  if (flat.length <= DESCRIPTION_MAX) return flat;
  return `${flat.slice(0, DESCRIPTION_MAX - 3).trimEnd()}...`;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
}

function stopLine(dayNo: number, index: number, s: WireStop): string {
  const parts: string[] = [];
  parts.push(`  ${dayNo}.${index + 1} ${cleanField(s?.time, 20) || "Flexible"}`);
  parts.push(cleanField(s?.title, 120) || "(untitled)");
  const src = [cleanField(s?.priceSource, 20) || "unknown", cleanField(s?.sourceHost, 80), cleanField(s?.checkedAt, 40)]
    .filter(Boolean)
    .join(", ");
  parts.push(`INR ${num(s?.cost)} (${src})`);
  const placeName = cleanField(s?.placeName, 120);
  const placeId = cleanField(s?.placeId, 200);
  if (placeName || placeId) parts.push(`place: ${placeName || "-"}${placeId ? ` [${placeId}]` : ""}`);
  const area = cleanField(s?.area, 80);
  if (area) parts.push(`area: ${area}`);
  const hours = cleanField(s?.openingHours, 200);
  const label = cleanField(s?.hoursLabel, 40);
  if (hours || label) parts.push(`hours: ${[hours, label ? `(${label})` : ""].filter(Boolean).join(" ")}`);
  if (typeof s?.travelToNextMin === "number" && Number.isFinite(s.travelToNextMin)) {
    parts.push(`next: ${Math.round(s.travelToNextMin)} min`);
  }
  const desc = truncateDescription(s?.description);
  if (desc) parts.push(`desc: ${desc}`);
  return parts.join(" | ");
}

/** Deterministic compact text for a wire itinerary. Returns "" on bad input. */
export function buildSnapshot(it: WireItinerary): string {
  try {
    if (!it || typeof it !== "object" || !Array.isArray(it.days)) return "";
    const lines: string[] = [];
    lines.push(`Trip: ${cleanField(it.title, 120) || "(untitled)"} | total INR ${num(it.totalCost)}`);
    for (const d of it.days) {
      if (!d || typeof d !== "object") continue;
      const dayNo = num(d.day);
      const head = [
        `Day ${dayNo}`,
        cleanField(d.date, 20),
        cleanField(d.title, 120),
        cleanField(d.theme, 120),
        `day total INR ${num(d.total)}`,
      ];
      if (d.dayTrip === true) head.push("day trip");
      lines.push(head.filter((x, i) => i === 0 || x !== "").join(" | "));
      const acts = Array.isArray(d.activities) ? d.activities : [];
      acts.forEach((s, i) => {
        if (s && typeof s === "object") lines.push(stopLine(dayNo, i, s));
      });
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const c = cleanField(value, Number.MAX_SAFE_INTEGER);
  if (!c || c.length > max) return undefined;
  return c;
}

function boundedCount(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return value >= min && value <= max ? value : undefined;
}

/**
 * Keeps only firstName, homeCity, travelStyle and party. Invalid or
 * over-long values are dropped. Everything else (email, phone, userId...)
 * is discarded. Returns undefined when nothing valid remains.
 */
export function toProfileSubset(input: unknown): ProfileSubset | undefined {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
    const src = input as Record<string, unknown>;
    const out: ProfileSubset = {};
    const firstName = boundedString(src.firstName, NAME_MAX);
    if (firstName) out.firstName = firstName;
    const homeCity = boundedString(src.homeCity, CITY_MAX);
    if (homeCity) out.homeCity = homeCity;
    const travelStyle = boundedString(src.travelStyle, STYLE_MAX);
    if (travelStyle) out.travelStyle = travelStyle;
    const p = src.party;
    if (p && typeof p === "object" && !Array.isArray(p)) {
      const pr = p as Record<string, unknown>;
      const adults = boundedCount(pr.adults, 0, PARTY_MAX);
      const children = boundedCount(pr.children, 0, PARTY_MAX);
      if (adults !== undefined && children !== undefined) out.party = { adults, children };
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Fixed-order profile text. "No saved profile" when null or empty. */
export function buildProfileText(subset: ProfileSubset | null | undefined): string {
  try {
    if (!subset || typeof subset !== "object") return NO_PROFILE_TEXT;
    // Re-run the whitelist so a caller cannot pass extra or unsanitised fields.
    const s = toProfileSubset(subset);
    if (!s) return NO_PROFILE_TEXT;
    const lines: string[] = [];
    if (s.firstName) lines.push(`First name: ${s.firstName}`);
    if (s.homeCity) lines.push(`Home city: ${s.homeCity}`);
    if (s.travelStyle) lines.push(`Travel style: ${s.travelStyle}`);
    if (s.party) lines.push(`Party: ${s.party.adults} adults, ${s.party.children} children`);
    return lines.length > 0 ? lines.join("\n") : NO_PROFILE_TEXT;
  } catch {
    return NO_PROFILE_TEXT;
  }
}
