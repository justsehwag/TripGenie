import {
  applySave,
  stripSensitive,
  type SaveInput,
  type StoredTrip,
} from "@/lib/trip-retention";
import { LOCAL_OWNER } from "@/lib/history/scope";

/**
 * Local_Store (design section 2): a device-only, localStorage-backed history/drafts
 * store for guests. Pure cores operate on arrays and are node-testable; thin IO
 * wrappers are SSR-guarded and never throw.
 *
 * Device-only guarantee: every record's `owner` is forced to the `LOCAL_OWNER`
 * sentinel ("@local"), never a real userId. This module NEVER calls `/api/trips`
 * or `fetch`, and imports no server-only secret.
 *
 * Requirements: 2.2, 3.2, 3.4, 3.5, 5.3, 5.5, 7.1, 7.4.
 */

/** Versioned localStorage key for the guest device-only history store. */
export const LOCAL_HISTORY_KEY = "tripgenie.history.guest.v1" as const;

/** Newest-N retention budget, mirroring `retainNewest` in trip-retention. */
const MAX_KEPT = 5;

/* -------------------------------------------------------------------------- */
/* Pure cores (no window)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Idempotent save for the guest store. Delegates to `applySave` (idempotent by
 * owner+clientDraftId, with `stripSensitive` applied) and then forces every
 * resulting record's `owner` to the `LOCAL_OWNER` sentinel so a Local_Store
 * record is never attributable to a signed-in user (Property 1).
 */
export function localApplySave(
  existing: StoredTrip[],
  input: SaveInput,
  newId: string,
  now?: Date,
): { trips: StoredTrip[]; savedId: string } {
  // Force the input owner to the sentinel so idempotency keys on the local owner.
  const localInput: SaveInput = { ...input, owner: LOCAL_OWNER };
  const { trips, savedId } = applySave(existing, localInput, newId, now ?? new Date());
  // Defensively force the sentinel owner on every resulting record.
  const forced = trips.map((t) => (t.owner === LOCAL_OWNER ? t : { ...t, owner: LOCAL_OWNER }));
  return { trips: forced, savedId };
}

/**
 * Keep the newest 5 records by `updatedAt` descending (mirrors `retainNewest`
 * ordering). Returns the kept array.
 */
export function localRetainNewest(trips: StoredTrip[]): StoredTrip[] {
  return trips
    .slice()
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .slice(0, MAX_KEPT);
}

/** Remove the record with the given `tripId`; other records are kept. */
export function localRemove(trips: StoredTrip[], tripId: string): StoredTrip[] {
  return trips.filter((t) => t.tripId !== tripId);
}

/**
 * Parse persisted history from a raw string. TOTAL: never throws. Returns `[]`
 * on null/corrupt/non-array JSON, and keeps only array elements that look like
 * a StoredTrip (object with a string `tripId`).
 */
export function parseLocalHistory(raw: string | null): StoredTrip[] {
  if (raw == null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (el): el is StoredTrip =>
      typeof el === "object" &&
      el !== null &&
      typeof (el as { tripId?: unknown }).tripId === "string",
  );
}

/* -------------------------------------------------------------------------- */
/* Thin IO wrappers (SSR-guarded, never throw)                                */
/* -------------------------------------------------------------------------- */

/** Read the guest history from localStorage. Returns `[]` on SSR or any error. */
export function readLocalHistory(): StoredTrip[] {
  if (typeof window === "undefined") return [];
  try {
    return parseLocalHistory(window.localStorage.getItem(LOCAL_HISTORY_KEY));
  } catch {
    return [];
  }
}

/** Write the guest history to localStorage. No-op on SSR or any error. */
export function writeLocalHistory(trips: StoredTrip[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(trips));
  } catch {
    // Device store degrades silently; never throw.
  }
}

/** Generate an id for a new record, preferring crypto.randomUUID when available. */
function newLocalId(): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c && typeof c.randomUUID === "function") {
      return c.randomUUID();
    }
  } catch {
    // fall through to fallback
  }
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Save a draft/plan to the guest device store. Reads current history, applies an
 * idempotent save with the owner forced to the sentinel, retains the newest 5,
 * writes back, and returns the saved record. `stripSensitive` runs via `applySave`.
 */
export function saveLocal(input: SaveInput): StoredTrip {
  const existing = readLocalHistory();
  const { trips, savedId } = localApplySave(existing, input, newLocalId());
  const kept = localRetainNewest(trips);
  writeLocalHistory(kept);
  const saved =
    kept.find((t) => t.tripId === savedId) ??
    trips.find((t) => t.tripId === savedId);
  if (saved) return saved;
  // Should not happen; synthesize a safe record so callers get a value.
  const iso = new Date().toISOString();
  return {
    tripId: savedId,
    owner: LOCAL_OWNER,
    clientDraftId: input.clientDraftId,
    name: input.name,
    status: input.status ?? "ready",
    payload: stripSensitive(input.payload),
    createdAt: iso,
    updatedAt: iso,
    ttl: input.ttl,
  };
}

/** Remove a record from the guest device store by `tripId`. */
export function removeLocal(tripId: string): void {
  const existing = readLocalHistory();
  writeLocalHistory(localRemove(existing, tripId));
}
