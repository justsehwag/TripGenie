import type { TravelerProfile } from "./types";

/**
 * Profile compare-and-swap (pure core) - design section 8.
 * Version-based CAS; stale version is rejected (surfaced as HTTP 409 at the edge).
 * Requirements: 7.1, 7.2, 7.4, 7.5.
 */

export type CasResult =
  | { ok: true; profile: TravelerProfile }
  | { ok: false; conflict: true; currentVersion: number };

/**
 * Apply a version-checked update. When `expectedVersion` matches the stored
 * version, the write succeeds and the version increments; otherwise it is
 * rejected and the stored profile is left unchanged.
 */
export function applyProfileUpdate(
  current: TravelerProfile,
  expectedVersion: number,
  changes: Partial<Omit<TravelerProfile, "userId" | "version">>,
): CasResult {
  if (expectedVersion !== current.version) {
    return { ok: false, conflict: true, currentVersion: current.version };
  }
  return {
    ok: true,
    profile: { ...current, ...changes, version: current.version + 1 },
  };
}

export interface FareBasis {
  perPerson: number;
  party: number;
  hotelNights: number;
}

/** Derive per-person/party fares and hotel nights from the profile (Req 7.2). */
export function deriveFareBasis(
  profile: TravelerProfile,
  perPersonFare: number,
  nights: number,
): FareBasis {
  const people = Math.max(1, profile.party.adults + profile.party.children);
  const per = Math.max(0, Math.round(perPersonFare));
  return {
    perPerson: per,
    party: per * people,
    hotelNights: Math.max(1, Math.trunc(nights)),
  };
}
