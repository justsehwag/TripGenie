import { describe, it, expect } from "vitest";
import {
  listNewest,
  saveTrip,
  updateProfile,
  VersionConflictError,
  type KvStore,
} from "@/lib/dynamo-store";
import type { StoredTrip } from "@/lib/trip-retention";
import type { TravelerProfile } from "@/lib/types";

/** Feature: tripgenie - DynamoDB store integration (409, GSI idempotency, TTL). */

class MemStore implements KvStore {
  trips: StoredTrip[] = [];
  profiles: Map<string, TravelerProfile> = new Map();
  async listTrips(owner: string) { return this.trips.filter((t) => t.owner === owner); }
  async putTrip(trip: StoredTrip) {
    this.trips = this.trips.filter((t) => !(t.owner === trip.owner && t.tripId === trip.tripId));
    this.trips.push(trip);
  }
  async deleteTrips(owner: string, ids: string[]) {
    const set = new Set(ids);
    this.trips = this.trips.filter((t) => !(t.owner === owner && set.has(t.tripId)));
  }
  async getProfile(userId: string) { return this.profiles.get(userId) ?? null; }
  async putProfile(p: TravelerProfile) { this.profiles.set(p.userId, p); }
}

const input = (owner: string, clientDraftId: string) => ({
  owner,
  clientDraftId,
  name: "Trip",
  payload: { city: "Goa" },
});

describe("Feature: tripgenie, DynamoDB store", () => {
  it("repeated draft save is idempotent (no duplicate) - GSI owner-draft", async () => {
    const store = new MemStore();
    await saveTrip(store, input("u1", "d-A"), "new-1");
    await saveTrip(store, input("u1", "d-A"), "new-2");
    await saveTrip(store, input("u1", "d-A"), "new-3");
    expect(store.trips.length).toBe(1);
  });

  it("retains only the newest five trips", async () => {
    const store = new MemStore();
    for (let i = 0; i < 8+ 0; i++) {
      await saveTrip(store, input("u1", `d-${i}`), `new-${i}`, new Date(1700000000000 + i * 1000));
    }
    expect(store.trips.length).toBe(5);
    const newest = await listNewest(store, "u1");
    expect(newest.length).toBe(5);
  });

  it("profile update with a stale version throws 409 and leaves the store unchanged", async () => {
    const store = new MemStore();
    const base: TravelerProfile = {
      userId: "u1", displayName: "Asha", homeCity: "Delhi",
      travelStyle: "Balanced", locale: "en-IN",
      party: { adults: 2, children: 0 }, version: 3,
    };
    await store.putProfile(base);
    await expect(updateProfile(store, base, 2, { homeCity: "Mumbai" })).rejects.toBeInstanceOf(VersionConflictError);
    expect(store.profiles.get("u1")?.homeCity).toBe("Delhi");
    const updated = await updateProfile(store, base, 3, { homeCity: "Mumbai" });
    expect(updated.version).toBe(4);
    expect(updated.homeCity).toBe("Mumbai");
  });

  it("session/draft records carry a TTL that an expiry sweep can remove", async () => {
    const store = new MemStore();
    const ttl = Math.floor(Date.now() / 1000) - 10;
    await saveTrip(store, { ...input("u1", "d-T"), ttl }, "new-T");
    const stored = store.trips[0];
    expect(stored.ttl).toBe(ttl);
    // Simulate DynamoDB native TTL sweep: records past their ttl are removed.
    const nowSec = Math.floor(Date.now() / 1000);
    store.trips = store.trips.filter((t) => t.ttl === undefined || t.ttl > nowSec);
    expect(store.trips.length).toBe(0);
  });
});
