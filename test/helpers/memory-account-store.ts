import { stripSensitive, type StoredTrip } from "@/lib/trip-retention";
import type { AccountStore } from "@/lib/account/dynamo-account-store";
import { VersionConflictError } from "@/lib/dynamo-store";
import type { TravelerProfile } from "@/lib/types";

/**
 * In-memory AccountStore with the same conditional semantics as the Dynamo
 * store: putTripIfAbsent is false when the key exists, upsertTrip keeps the
 * original createdAt (and removes ttl when the new record has none),
 * listTripKeys is newest first, deleteTrips is owner-scoped.
 */
export class MemoryAccountStore implements AccountStore {
  readonly trips = new Map<string, StoredTrip>();
  private readonly profiles = new Map<string, TravelerProfile>();
  private readonly prefs = new Map<string, { data: unknown; version: number }>();

  private readonly xp = new Map<string, { data: unknown; version: number }>();

  private static key(owner: string, tripId: string): string {
    return `${owner}\u0000${tripId}`;
  }

  private static copy(t: StoredTrip): StoredTrip {
    return JSON.parse(JSON.stringify(t)) as StoredTrip;
  }

  all(owner?: string): StoredTrip[] {
    return [...this.trips.values()].filter((t) => owner === undefined || t.owner === owner).map(MemoryAccountStore.copy);
  }

  async listTrips(owner: string): Promise<StoredTrip[]> {
    return this.all(owner);
  }

  async putTrip(trip: StoredTrip): Promise<void> {
    await this.upsertTrip(trip);
  }

  async upsertTrip(trip: StoredTrip): Promise<void> {
    const k = MemoryAccountStore.key(trip.owner, trip.tripId);
    const prior = this.trips.get(k);
    const next: StoredTrip = MemoryAccountStore.copy({ ...trip, payload: stripSensitive(trip.payload) });
    if (prior) next.createdAt = prior.createdAt;
    if (typeof trip.ttl !== "number") delete next.ttl;
    this.trips.set(k, next);
  }

  async putTripIfAbsent(trip: StoredTrip): Promise<boolean> {
    const k = MemoryAccountStore.key(trip.owner, trip.tripId);
    if (this.trips.has(k)) return false;
    const next: StoredTrip = MemoryAccountStore.copy({ ...trip, payload: stripSensitive(trip.payload) });
    if (typeof trip.ttl !== "number") delete next.ttl;
    this.trips.set(k, next);
    return true;
  }

  async listTripKeys(owner: string): Promise<{ tripId: string; updatedAt: string }[]> {
    return this.all(owner)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .map((t) => ({ tripId: t.tripId, updatedAt: t.updatedAt }));
  }

  async deleteTrips(owner: string, tripIds: string[]): Promise<void> {
    for (const id of tripIds) this.trips.delete(MemoryAccountStore.key(owner, id));
  }

  async getProfile(userId: string): Promise<TravelerProfile | null> {
    return this.profiles.get(userId) ?? null;
  }

  async putProfile(profile: TravelerProfile): Promise<void> {
    this.profiles.set(profile.userId, profile);
  }

  async getPreferences(userId: string): Promise<{ data: unknown; version: number } | null> {
    return this.prefs.get(userId) ?? null;
  }

  async putPreferences(userId: string, data: unknown, expectedVersion: number): Promise<{ version: number }> {
    const current = this.prefs.get(userId)?.version ?? 0;
    if (current !== expectedVersion) throw new VersionConflictError(current);
    const version = expectedVersion + 1;
    this.prefs.set(userId, { data, version });
    return { version };
  }

  async getXp(userId: string): Promise<{ data: unknown; version: number } | null> {
    return this.xp.get(userId) ?? null;
  }

  async putXp(userId: string, data: unknown, expectedVersion: number): Promise<{ version: number }> {
    const current = this.xp.get(userId)?.version ?? 0;
    if (current !== expectedVersion) throw new VersionConflictError(current);
    const version = expectedVersion + 1;
    this.xp.set(userId, { data, version });
    return { version };
  }
}
