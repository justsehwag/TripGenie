/**
 * Trip retention + idempotency (pure core) - design section 15.
 * Ported from TripSaathi app/api/trips/route.ts.
 * Requirements: 13.2-13.6, 20.1.
 */

export interface StoredTrip {
  tripId: string;
  owner: string;
  clientDraftId: string;
  name: string;
  status: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  ttl?: number;
}

const MAX_KEPT = 5;
const SENSITIVE = ["payment", "card", "cvv", "passport", "pan", "ssn", "auth", "token", "secret"];

/** Remove sensitive keys from a payload (Req 13.6). */
export function stripSensitive(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    const lower = k.toLowerCase();
    if (SENSITIVE.some((s) => lower.includes(s))) continue;
    out[k] = v;
  }
  return out;
}

export interface SaveInput {
  owner: string;
  clientDraftId: string;
  name: string;
  status?: string;
  payload: Record<string, unknown>;
  ttl?: number;
}

/** Idempotent save keyed on (owner, clientDraftId); updates in place, no duplicate. */
export function applySave(
  existing: StoredTrip[],
  input: SaveInput,
  newId: string,
  now = new Date(),
): { trips: StoredTrip[]; savedId: string } {
  const iso = now.toISOString();
  const prior = existing.find(
    (t) => t.owner === input.owner && t.clientDraftId === input.clientDraftId,
  );
  const tripId = prior?.tripId ?? newId;
  const record: StoredTrip = {
    tripId,
    owner: input.owner,
    clientDraftId: input.clientDraftId,
    name: input.name,
    status: input.status ?? "ready",
    payload: stripSensitive(input.payload),
    createdAt: prior?.createdAt ?? iso,
    updatedAt: iso,
    ttl: input.ttl,
  };
  const others = existing.filter((t) => !(t.owner === input.owner && t.tripId === tripId));
  return { trips: [record, ...others], savedId: tripId };
}

/** Newest-5 retention; returns kept and deleted ids (Req 13.4/13.5). */
export function retainNewest(owner: string, trips: StoredTrip[]): { kept: StoredTrip[]; deleted: string[] } {
  const owned = trips
    .filter((t) => t.owner === owner)
    .slice()
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  const kept = owned.slice(0, MAX_KEPT);
  const deleted = owned.slice(MAX_KEPT).map((t) => t.tripId);
  return { kept, deleted };
}
