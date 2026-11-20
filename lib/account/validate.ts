/**
 * Pure, total request validators for the account-sync routes (trips, profile,
 * preferences). Validators never throw and never echo input back in errors.
 */
import {
  COUNTRIES,
  DIETS,
  HOME_CITIES,
  INTERESTS,
  PACES,
  TRAVELLER_COUNTS,
  TRAVEL_STYLES,
  TRIP_LENGTHS,
  type Option,
  type TravelPreferences,
} from "../preferences";
import type { TravelerProfile } from "../types";

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; status?: 400 | 413 };

export const MAX_PAYLOAD_BYTES = 350 * 1024;
export const MAX_PREFERENCES_BYTES = 16 * 1024;
export const TRIP_STATUSES = ["draft", "in-progress", "planning", "ready", "confirmed"] as const;
export type TripStatusValue = (typeof TRIP_STATUSES)[number];
export const MIN_UPDATED_AT = "2020-01-01T00:00:00.000Z";

export interface ValidatedTrip {
  clientDraftId: string;
  name: string;
  status: TripStatusValue;
  payload: Record<string, unknown>;
  mode: "save" | "merge";
  /** Present only in merge mode; ISO string clamped to [2020-01-01, now]. */
  updatedAt?: string;
}

export type ProfileChanges = Partial<Omit<TravelerProfile, "userId" | "version">>;

export interface ValidatedProfileRequest {
  expectedVersion: number;
  changes: ProfileChanges;
}

export interface ValidatedPreferencesRequest {
  preferences: TravelPreferences;
  expectedVersion: number;
}

type Now = Date | number;

const bad = (error: string, status: 400 | 413 = 400): { ok: false; error: string; status: 400 | 413 } => ({
  ok: false,
  error,
  status,
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nowMs(now: Now | undefined): number {
  const n = now === undefined ? Date.now() : now instanceof Date ? now.getTime() : now;
  return Number.isFinite(n) ? n : Date.now();
}

/** UTF-8 byte length of the JSON form, or null when it cannot be serialized. */
function jsonBytes(v: unknown): number | null {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? null : Buffer.byteLength(s, "utf8");
  } catch {
    return null;
  }
}

/** Payload size check: rejects if and only if the JSON byte length exceeds 350 KB. */
export function checkPayloadSize(payload: unknown): ValidationResult<true> {
  const n = jsonBytes(payload);
  if (n === null) return bad("Payload is not valid.");
  if (n > MAX_PAYLOAD_BYTES) return bad("Payload is too large.", 413);
  return { ok: true, value: true };
}

/** Clamp an ISO-parsable value to [2020-01-01, now]. Returns null when unparsable. */
export function clampUpdatedAt(value: unknown, now?: Now): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const t = typeof value === "string" ? Date.parse(value) : value;
  if (typeof t !== "number" || !Number.isFinite(t)) return null;
  const lo = Date.parse(MIN_UPDATED_AT);
  const hi = Math.max(lo, nowMs(now));
  return new Date(Math.min(Math.max(t, lo), hi)).toISOString();
}

function trimmedString(v: unknown, min: number, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length >= min && s.length <= max ? s : null;
}

/** Validate a POST /api/trips body. `owner` and `ttl` in the body are ignored. */
export function validateTripInput(body: unknown, opts: { now?: Now } = {}): ValidationResult<ValidatedTrip> {
  if (!isRecord(body)) return bad("Request body is not valid.");

  const clientDraftId = trimmedString(body.clientDraftId, 1, 100);
  if (clientDraftId === null) return bad("clientDraftId is not valid.");

  const name = trimmedString(body.name, 1, 80);
  if (name === null) return bad("name is not valid.");

  let status: TripStatusValue = "ready";
  if (body.status !== undefined) {
    if (typeof body.status !== "string") return bad("status is not valid.");
    const s = body.status.trim().toLowerCase();
    if (!(TRIP_STATUSES as readonly string[]).includes(s)) return bad("status is not valid.");
    status = s as TripStatusValue;
  }

  let mode: "save" | "merge" = "save";
  if (body.mode !== undefined) {
    if (body.mode !== "save" && body.mode !== "merge") return bad("mode is not valid.");
    mode = body.mode;
  }

  if (!isRecord(body.payload)) return bad("payload is not valid.");
  const size = checkPayloadSize(body.payload);
  if (!size.ok) return size;

  const value: ValidatedTrip = { clientDraftId, name, status, payload: body.payload, mode };
  if (mode === "merge" && body.updatedAt !== undefined) {
    const clamped = clampUpdatedAt(body.updatedAt, opts.now);
    if (clamped === null) return bad("updatedAt is not valid.");
    value.updatedAt = clamped;
  }
  return { ok: true, value };
}

function validVersion(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
}

const PROFILE_KEYS = ["displayName", "homeCity", "travelStyle", "locale", "party"] as const;
const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

function validCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 20;
}

/**
 * Validate profile `changes` against the whitelist. Unknown keys are rejected.
 * With `requireAll`, every whitelisted field must be present (first write).
 */
export function validateProfileChanges(
  raw: unknown,
  opts: { requireAll?: boolean } = {},
): ValidationResult<ProfileChanges> {
  if (!isRecord(raw)) return bad("changes is not valid.");
  const keys = Object.keys(raw);
  if (keys.some((k) => !(PROFILE_KEYS as readonly string[]).includes(k))) return bad("changes has unknown fields.");
  if (keys.length === 0) return bad("changes is empty.");

  const out: ProfileChanges = {};
  if (raw.displayName !== undefined) {
    const v = trimmedString(raw.displayName, 1, 80);
    if (v === null) return bad("displayName is not valid.");
    out.displayName = v;
  }
  if (raw.homeCity !== undefined) {
    const v = trimmedString(raw.homeCity, 1, 80);
    if (v === null) return bad("homeCity is not valid.");
    out.homeCity = v;
  }
  if (raw.travelStyle !== undefined) {
    const v = trimmedString(raw.travelStyle, 1, 40);
    if (v === null) return bad("travelStyle is not valid.");
    out.travelStyle = v;
  }
  if (raw.locale !== undefined) {
    if (typeof raw.locale !== "string" || !LOCALE_RE.test(raw.locale)) return bad("locale is not valid.");
    out.locale = raw.locale;
  }
  if (raw.party !== undefined) {
    const p = raw.party;
    if (!isRecord(p)) return bad("party is not valid.");
    if (Object.keys(p).some((k) => k !== "adults" && k !== "children")) return bad("party is not valid.");
    if (!validCount(p.adults) || !validCount(p.children)) return bad("party is not valid.");
    out.party = { adults: p.adults, children: p.children };
  }
  if (opts.requireAll && PROFILE_KEYS.some((k) => out[k] === undefined)) {
    return bad("changes is missing required fields.");
  }
  return { ok: true, value: out };
}

/** Validate a PUT/POST /api/profile body `{ expectedVersion, changes }`. */
export function validateProfileRequest(
  body: unknown,
  opts: { requireAll?: boolean } = {},
): ValidationResult<ValidatedProfileRequest> {
  if (!isRecord(body)) return bad("Request body is not valid.");
  if (!validVersion(body.expectedVersion)) return bad("expectedVersion is not valid.");
  const changes = validateProfileChanges(body.changes, opts);
  if (!changes.ok) return changes;
  return { ok: true, value: { expectedVersion: body.expectedVersion, changes: changes.value } };
}

const PREFERENCE_KEYS = [
  "country",
  "homeCity",
  "travelStyle",
  "pace",
  "diet",
  "tripLength",
  "travellers",
  "interests",
] as const;

function inList(v: unknown, options: readonly Option[]): v is string {
  return typeof v === "string" && options.some((o) => o.value === v);
}

/**
 * Strict preferences validation: exactly the eight known keys, values taken from
 * the option lists, JSON size at most 16 KB. Does not coerce.
 */
export function validatePreferences(raw: unknown): ValidationResult<TravelPreferences> {
  const n = jsonBytes(raw);
  if (n === null) return bad("preferences is not valid.");
  if (n > MAX_PREFERENCES_BYTES) return bad("preferences is too large.", 413);
  if (!isRecord(raw)) return bad("preferences is not valid.");

  const keys = Object.keys(raw);
  if (keys.some((k) => !(PREFERENCE_KEYS as readonly string[]).includes(k))) {
    return bad("preferences has unknown fields.");
  }
  if (PREFERENCE_KEYS.some((k) => !(k in raw))) return bad("preferences is missing fields.");

  if (!inList(raw.country, COUNTRIES)) return bad("country is not valid.");
  if (!inList(raw.homeCity, HOME_CITIES)) return bad("homeCity is not valid.");
  if (!inList(raw.travelStyle, TRAVEL_STYLES)) return bad("travelStyle is not valid.");
  if (!inList(raw.pace, PACES)) return bad("pace is not valid.");
  if (!inList(raw.diet, DIETS)) return bad("diet is not valid.");
  if (!inList(raw.tripLength, TRIP_LENGTHS)) return bad("tripLength is not valid.");
  if (typeof raw.travellers !== "number" || !TRAVELLER_COUNTS.includes(raw.travellers)) {
    return bad("travellers is not valid.");
  }
  if (!Array.isArray(raw.interests) || raw.interests.length < 1 || raw.interests.length > INTERESTS.length) {
    return bad("interests is not valid.");
  }
  const interests: string[] = [];
  for (const i of raw.interests) {
    if (!inList(i, INTERESTS) || interests.includes(i)) return bad("interests is not valid.");
    interests.push(i);
  }

  return {
    ok: true,
    value: {
      country: raw.country,
      homeCity: raw.homeCity,
      travelStyle: raw.travelStyle,
      pace: raw.pace,
      diet: raw.diet,
      tripLength: raw.tripLength,
      travellers: raw.travellers,
      interests,
    },
  };
}

/** Validate a PUT /api/preferences body `{ preferences, expectedVersion }`. */
export function validatePreferencesRequest(body: unknown): ValidationResult<ValidatedPreferencesRequest> {
  if (!isRecord(body)) return bad("Request body is not valid.");
  if (!validVersion(body.expectedVersion)) return bad("expectedVersion is not valid.");
  const prefs = validatePreferences(body.preferences);
  if (!prefs.ok) return prefs;
  return { ok: true, value: { preferences: prefs.value, expectedVersion: body.expectedVersion } };
}
