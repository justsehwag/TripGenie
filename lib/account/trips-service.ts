// SERVER-ONLY (uses node:crypto through trip-id). Account trips service:
// save, guest merge, list and delete. The owner is always the verified Cognito
// `sub` passed by the caller and is never read from request input.
import { ACCOUNT_MAX_TRIPS, retainNewest, stripSensitive, type StoredTrip } from "../trip-retention";
import type { AccountStore } from "./dynamo-account-store";
import { tripIdFor } from "./trip-id";
import { checkPayloadSize, type ValidatedTrip } from "./validate";

export const LIST_BUDGET_BYTES = 4 * 1024 * 1024;
export const PLANNING_TTL_SECONDS = 30 * 24 * 60 * 60;

type Now = () => Date;

export interface TripsServiceDeps {
  store: Pick<AccountStore, "upsertTrip" | "putTripIfAbsent" | "listTripKeys" | "deleteTrips" | "listTrips">;
  /** Injectable clock; defaults to `() => new Date()`. */
  now?: Now;
}

export class TripPayloadTooLargeError extends Error {
  readonly status = 413 as const;
  constructor() {
    super("Payload is too large.");
    this.name = "TripPayloadTooLargeError";
  }
}

export interface SaveTripResult {
  id: string;
  saved: true;
  updatedAt: string;
  pruned: number;
}

export interface MergeTripResult {
  id: string;
  created: boolean;
  pruned: number;
}

export interface ListTripsResult {
  trips: StoredTrip[];
  truncated: boolean;
}

/** Server-side ttl: updatedAt + 30 days for "planning" drafts, otherwise none. */
function ttlFor(status: string, updatedAt: string): number | undefined {
  if (status !== "planning") return undefined;
  const ms = Date.parse(updatedAt);
  if (!Number.isFinite(ms)) return undefined;
  return Math.floor(ms / 1000) + PLANNING_TTL_SECONDS;
}

function buildRecord(owner: string, input: ValidatedTrip, updatedAt: string): StoredTrip {
  const payload = stripSensitive(input.payload);
  if (!checkPayloadSize(payload).ok) throw new TripPayloadTooLargeError();
  const record: StoredTrip = {
    tripId: tripIdFor(input.clientDraftId),
    owner,
    clientDraftId: input.clientDraftId,
    name: input.name,
    status: input.status,
    payload,
    createdAt: updatedAt,
    updatedAt,
  };
  const ttl = ttlFor(input.status, updatedAt);
  if (ttl !== undefined) record.ttl = ttl;
  return record;
}

/** Newest-20 retention over the index keys; returns how many trips were deleted. */
async function prune(store: TripsServiceDeps["store"], owner: string, written: StoredTrip): Promise<number> {
  const keys = await store.listTripKeys(owner);
  // The index is eventually consistent: make sure the record just written is present with its real timestamp.
  const asTrips: StoredTrip[] = keys
    .filter((k) => k.tripId !== written.tripId)
    .map((k) => ({ tripId: k.tripId, updatedAt: k.updatedAt, owner }) as StoredTrip);
  asTrips.push({ tripId: written.tripId, updatedAt: written.updatedAt, owner } as StoredTrip);
  const { deleted } = retainNewest(owner, asTrips, ACCOUNT_MAX_TRIPS);
  if (deleted.length > 0) await store.deleteTrips(owner, deleted);
  return deleted.length;
}

/** Idempotent upsert by deterministic key, then retention. `input.ttl`/owner from the client are never used. */
export async function saveAccountTrip(
  deps: TripsServiceDeps,
  owner: string,
  input: ValidatedTrip,
): Promise<SaveTripResult> {
  const updatedAt = (deps.now ?? (() => new Date()))().toISOString();
  const record = buildRecord(owner, input, updatedAt);
  await deps.store.upsertTrip(record);
  const pruned = await prune(deps.store, owner, record);
  return { id: record.tripId, saved: true, updatedAt, pruned };
}

/**
 * Guest merge: conditional put that keeps an existing record. Uses the clamped
 * guest `updatedAt` (falls back to now). When the record already exists nothing
 * changes and `pruned` is 0.
 */
export async function mergeGuestTrip(
  deps: TripsServiceDeps,
  owner: string,
  input: ValidatedTrip,
): Promise<MergeTripResult> {
  const updatedAt = input.updatedAt ?? (deps.now ?? (() => new Date()))().toISOString();
  const record = buildRecord(owner, input, updatedAt);
  const created = await deps.store.putTripIfAbsent(record);
  if (!created) return { id: record.tripId, created: false, pruned: 0 };
  const pruned = await prune(deps.store, owner, record);
  return { id: record.tripId, created: true, pruned };
}

/** Newest 20 trips (consistent read) within a 4 MB JSON budget; `truncated` when the budget cut the list. */
export async function listAccountTrips(
  deps: TripsServiceDeps,
  owner: string,
  budgetBytes: number = LIST_BUDGET_BYTES,
): Promise<ListTripsResult> {
  const all = await deps.store.listTrips(owner);
  const { kept } = retainNewest(owner, all, ACCOUNT_MAX_TRIPS);
  const trips: StoredTrip[] = [];
  let used = 2;
  for (const t of kept) {
    const size = Buffer.byteLength(JSON.stringify(t), "utf8") + 1;
    if (trips.length > 0 && used + size > budgetBytes) return { trips, truncated: true };
    trips.push(t);
    used += size;
  }
  return { trips, truncated: false };
}

/** Deletes `(owner, tripId)`. Always reports success so existence cannot be probed. */
export async function deleteAccountTrip(
  deps: TripsServiceDeps,
  owner: string,
  tripId: string,
): Promise<{ deleted: true }> {
  await deps.store.deleteTrips(owner, [tripId]);
  return { deleted: true };
}
