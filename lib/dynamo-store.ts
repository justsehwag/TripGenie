/**
 * DynamoDB Trip & Profile stores (edge integration) - design section 15.
 * Wires the pure retention/CAS cores to a DynamoDB-like client injected behind
 * an interface, so the conditional-write 409 mapping, idempotency, and TTL
 * behaviour are unit-testable without live AWS.
 * Requirements: 7.3-7.5, 13.1-13.7, 20.1-20.2.
 */
import type { TravelerProfile } from "./types";
import { applyProfileUpdate } from "./profile";
import { applySave, retainNewest, type SaveInput, type StoredTrip } from "./trip-retention";

/** A minimal key-value port modelling the DynamoDB operations we need. */
export interface KvStore {
  listTrips(owner: string): Promise<StoredTrip[]>;
  putTrip(trip: StoredTrip): Promise<void>;
  deleteTrips(owner: string, tripIds: string[]): Promise<void>;
  getProfile(userId: string): Promise<TravelerProfile | null>;
  putProfile(profile: TravelerProfile): Promise<void>;
}

export interface SaveResult { id: string; saved: boolean; updatedAt: string }

/**
 * Idempotent save + newest-5 retention against the store. Anonymous callers
 * (no owner) never reach DynamoDB — their drafts stay browser-local (Req 13.1).
 */
export async function saveTrip(
  store: KvStore,
  input: SaveInput,
  newId: string,
  now = new Date(),
): Promise<SaveResult> {
  const existing = await store.listTrips(input.owner);
  const { trips, savedId } = applySave(existing, input, newId, now);
  const record = trips.find((t) => t.tripId === savedId)!;
  await store.putTrip(record);
  const { deleted } = retainNewest(input.owner, trips);
  if (deleted.length) await store.deleteTrips(input.owner, deleted);
  return { id: savedId, saved: true, updatedAt: record.updatedAt };
}

/** Return the newest five trips for an owner (Req 13.5). */
export async function listNewest(store: KvStore, owner: string): Promise<StoredTrip[]> {
  const { kept } = retainNewest(owner, await store.listTrips(owner));
  return kept;
}

export class VersionConflictError extends Error {
  readonly status = 409;
  constructor(readonly currentVersion: number) {
    super(`Profile version conflict; current is ${currentVersion}`);
    this.name = "VersionConflictError";
  }
}

/**
 * Version-checked profile update. A stale version throws VersionConflictError
 * (which the API edge surfaces as HTTP 409) and leaves the store unchanged.
 */
export async function updateProfile(
  store: KvStore,
  current: TravelerProfile,
  expectedVersion: number,
  changes: Partial<Omit<TravelerProfile, "userId" | "version">>,
): Promise<TravelerProfile> {
  const result = applyProfileUpdate(current, expectedVersion, changes);
  if (!result.ok) throw new VersionConflictError(result.currentVersion);
  await store.putProfile(result.profile);
  return result.profile;
}
