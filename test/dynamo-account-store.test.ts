import { describe, it, expect } from "vitest";
import { DynamoAccountStore } from "@/lib/account/dynamo-account-store";
import { VersionConflictError } from "@/lib/dynamo-store";
import { retainNewest, type StoredTrip } from "@/lib/trip-retention";
import type { TravelerProfile } from "@/lib/types";

/**
 * Feature: account-sync, DynamoAccountStore against an in-memory table model.
 * Requirements: 3.1, 3.4-3.7, 9.3, 10.2-10.5
 */

type Rec = Record<string, any>;
type Cmd = { constructor: { name: string }; input: Rec };

class CondFail extends Error {
  name = "ConditionalCheckFailedException";
  constructor(readonly Item?: Rec) {
    super("condition failed");
  }
}

class FakeDoc {
  commands: Cmd[] = [];
  trips = new Map<string, Rec>(); // key: owner|tripId
  profiles = new Map<string, Rec>(); // key: userId|recordType
  /** Scripted UnprocessedItems responses for BatchWrite; consumed in order, then all processed. */
  unprocessedScript: ((req: Rec[]) => Rec[])[] = [];
  /** When true, ConditionalCheckFailed errors carry no Item (forces the follow-up Get). */
  omitOldItem = false;

  send = async (cmd: Cmd): Promise<Rec> => {
    this.commands.push(cmd);
    const name = cmd.constructor.name;
    const i = cmd.input;
    switch (name) {
      case "UpdateCommand": {
        const key = `${i.Key.owner}|${i.Key.tripId}`;
        const v = i.ExpressionAttributeValues;
        const prev = this.trips.get(key);
        const item: Rec = {
          ...(prev ?? {}),
          owner: i.Key.owner,
          tripId: i.Key.tripId,
          name: v[":n"],
          status: v[":s"],
          clientDraftId: v[":d"],
          payload: v[":p"],
          updatedAt: v[":u"],
          createdAt: prev?.createdAt ?? v[":c"],
        };
        if (":t" in v) item.ttl = v[":t"];
        else delete item.ttl;
        this.trips.set(key, item);
        return {};
      }
      case "PutCommand": {
        if (i.TableName.includes("trips")) {
          const key = `${i.Item.owner}|${i.Item.tripId}`;
          if (i.ConditionExpression && this.trips.has(key)) throw new CondFail();
          this.trips.set(key, { ...i.Item });
          return {};
        }
        const key = `${i.Item.userId}|${i.Item.recordType}`;
        const old = this.profiles.get(key);
        if (old && old.version !== i.ExpressionAttributeValues[":prev"]) {
          throw new CondFail(this.omitOldItem ? undefined : { ...old });
        }
        this.profiles.set(key, { ...i.Item });
        return {};
      }
      case "GetCommand": {
        const item = this.profiles.get(`${i.Key.userId}|${i.Key.recordType}`);
        return { Item: item ? { ...item } : undefined };
      }
      case "QueryCommand": {
        const owner = i.ExpressionAttributeValues[":o"];
        let items = [...this.trips.values()].filter((t) => t.owner === owner);
        if (i.IndexName) {
          items.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0));
          if (i.ScanIndexForward === false) items.reverse();
        }
        return { Items: items.map((t) => ({ ...t })) };
      }
      case "BatchWriteCommand": {
        const [table, reqs] = Object.entries(i.RequestItems)[0] as [string, Rec[]];
        const script = this.unprocessedScript.shift();
        const left = script ? script(reqs) : [];
        const leftKeys = new Set(left.map((r) => `${r.DeleteRequest.Key.owner}|${r.DeleteRequest.Key.tripId}`));
        for (const r of reqs) {
          const k = `${r.DeleteRequest.Key.owner}|${r.DeleteRequest.Key.tripId}`;
          if (!leftKeys.has(k)) this.trips.delete(k);
        }
        return { UnprocessedItems: left.length ? { [table]: left } : {} };
      }
      default:
        throw new Error(`unexpected command ${name}`);
    }
  };
}

const make = () => {
  const doc = new FakeDoc();
  const sleeps: number[] = [];
  const store = new DynamoAccountStore({
    doc: doc as never,
    tripsTable: "trips-table",
    profilesTable: "profiles-table",
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { doc, store, sleeps };
};

const trip = (owner: string, tripId: string, updatedAt: string, extra: Partial<StoredTrip> = {}): StoredTrip => ({
  tripId,
  owner,
  clientDraftId: `draft-${tripId}`,
  name: `Trip ${tripId}`,
  status: "ready",
  payload: { city: "Goa" },
  createdAt: updatedAt,
  updatedAt,
  ...extra,
});

const profile = (userId: string, version: number) =>
  ({ userId, version, name: "Asha" }) as unknown as TravelerProfile;

describe("Feature: account-sync, DynamoAccountStore", () => {
  it("round trip: save then list returns the sanitized payload without sensitive keys", async () => {
    const { store } = make();
    await store.putTrip(
      trip("u1", "t1", "2025-01-01T00:00:00.000Z", {
        payload: { city: "Goa", cardNumber: "4111", passportNo: "X1", authToken: "abc", days: 3 },
      }),
    );
    const list = await store.listTrips("u1");
    expect(list).toHaveLength(1);
    expect(list[0].payload).toEqual({ city: "Goa", days: 3 });
    expect(JSON.stringify(list)).not.toMatch(/4111|passport|authToken/i);
  });

  it("putTripIfAbsent strips sensitive keys and reports false on an existing key", async () => {
    const { store } = make();
    const t = trip("u1", "t1", "2025-01-01T00:00:00.000Z", { payload: { city: "Goa", secretKey: "s" } });
    expect(await store.putTripIfAbsent(t)).toBe(true);
    expect(await store.putTripIfAbsent(t)).toBe(false);
    const list = await store.listTrips("u1");
    expect(list).toHaveLength(1);
    expect(list[0].payload).toEqual({ city: "Goa" });
  });

  it("idempotent save: same tripId twice writes the same key, one record, createdAt kept", async () => {
    const { doc, store } = make();
    await store.upsertTrip(trip("u1", "t1", "2025-01-01T00:00:00.000Z"));
    await store.upsertTrip(trip("u1", "t1", "2025-02-01T00:00:00.000Z", { name: "Renamed" }));
    const updates = doc.commands.filter((c) => c.constructor.name === "UpdateCommand");
    expect(updates).toHaveLength(2);
    expect(updates[0].input.Key).toEqual(updates[1].input.Key);
    const list = await store.listTrips("u1");
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Renamed");
    expect(list[0].createdAt).toBe("2025-01-01T00:00:00.000Z");
    expect(list[0].updatedAt).toBe("2025-02-01T00:00:00.000Z");
  });

  it("upsertTrip sets ttl when given and removes it when absent", async () => {
    const { doc, store } = make();
    await store.upsertTrip(trip("u1", "t1", "2025-01-01T00:00:00.000Z", { ttl: 123 }));
    expect((await store.listTrips("u1"))[0].ttl).toBe(123);
    await store.upsertTrip(trip("u1", "t1", "2025-01-02T00:00:00.000Z"));
    expect((await store.listTrips("u1"))[0].ttl).toBeUndefined();
    const updates = doc.commands.filter((c) => c.constructor.name === "UpdateCommand");
    expect(updates[updates.length - 1].input.UpdateExpression).toContain("REMOVE #ttl");
  });

  it("listTripKeys returns newest first via the owner-updated index", async () => {
    const { doc, store } = make();
    await store.putTrip(trip("u1", "old", "2025-01-01T00:00:00.000Z"));
    await store.putTrip(trip("u1", "new", "2025-03-01T00:00:00.000Z"));
    await store.putTrip(trip("u1", "mid", "2025-02-01T00:00:00.000Z"));
    const keys = await store.listTripKeys("u1");
    expect(keys.map((k) => k.tripId)).toEqual(["new", "mid", "old"]);
    const q = doc.commands.find((c) => c.constructor.name === "QueryCommand")!;
    expect(q.input.IndexName).toBe("owner-updated");
    expect(q.input.ScanIndexForward).toBe(false);
  });

  it("retention: retainNewest + deleteTrips on 25 trips leaves the 20 newest", async () => {
    const { store } = make();
    for (let n = 1; n <= 25; n++) {
      await store.putTrip(trip("u1", `t${n}`, `2025-01-${String(n).padStart(2, "0")}T00:00:00.000Z`));
    }
    const keys = await store.listTripKeys("u1");
    const asTrips = keys.map((k) => trip("u1", k.tripId, k.updatedAt));
    const { kept, deleted } = retainNewest("u1", asTrips, 20);
    expect(deleted).toHaveLength(5);
    await store.deleteTrips("u1", deleted);
    const left = (await store.listTrips("u1")).map((t) => t.tripId).sort();
    expect(left).toEqual(kept.map((t) => t.tripId).sort());
    expect(left).toHaveLength(20);
    expect(left).not.toContain("t1");
    expect(left).toContain("t25");
  });

  it("owner isolation: deleting A's id leaves B untouched; lists never mix; keys carry the owner; no Scan", async () => {
    const { doc, store } = make();
    await store.putTrip(trip("A", "same", "2025-01-01T00:00:00.000Z"));
    await store.putTrip(trip("B", "same", "2025-01-01T00:00:00.000Z"));
    await store.putTrip(trip("B", "b2", "2025-01-02T00:00:00.000Z"));
    const beforeB = JSON.stringify(await store.listTrips("B"));

    await store.deleteTrips("A", ["same"]);

    expect(await store.listTrips("A")).toEqual([]);
    expect(JSON.stringify(await store.listTrips("B"))).toBe(beforeB);
    expect((await store.listTripKeys("A")).length).toBe(0);
    expect((await store.listTripKeys("B")).map((k) => k.tripId).sort()).toEqual(["b2", "same"]);

    for (const c of doc.commands) {
      expect(c.constructor.name).not.toBe("ScanCommand");
      const n = c.constructor.name;
      if (n === "UpdateCommand" || n === "GetCommand") expect(c.input.Key.owner ?? c.input.Key.userId).toBeTruthy();
      if (n === "PutCommand") expect(c.input.Item.owner ?? c.input.Item.userId).toBeTruthy();
      if (n === "QueryCommand") expect(c.input.ExpressionAttributeValues[":o"]).toMatch(/^[AB]$/);
      if (n === "BatchWriteCommand") {
        const reqs = Object.values(c.input.RequestItems)[0] as Rec[];
        for (const r of reqs) expect(r.DeleteRequest.Key.owner).toBe("A");
      }
    }
  });

  it("deleteTrips batches in groups of 25 and dedupes ids", async () => {
    const { doc, store } = make();
    const ids = Array.from({ length: 60 }, (_, n) => `t${n}`);
    await store.deleteTrips("u1", [...ids, "t0"]);
    const batches = doc.commands.filter((c) => c.constructor.name === "BatchWriteCommand");
    expect(batches.map((b) => (Object.values(b.input.RequestItems)[0] as Rec[]).length)).toEqual([25, 25, 10]);
  });

  it("stale profile version maps to VersionConflictError with the current version", async () => {
    const { store } = make();
    await store.putProfile(profile("u1", 1));
    await store.putProfile(profile("u1", 2));
    const err = await store.putProfile(profile("u1", 2)).catch((e) => e);
    expect(err).toBeInstanceOf(VersionConflictError);
    expect((err as VersionConflictError).currentVersion).toBe(2);
    expect(((await store.getProfile("u1")) as unknown as Rec).version).toBe(2);
  });

  it("stale preferences version maps to VersionConflictError (via returned old item)", async () => {
    const { store } = make();
    expect(await store.getPreferences("u1")).toBeNull();
    expect(await store.putPreferences("u1", { a: 1 }, 0)).toEqual({ version: 1 });
    expect(await store.putPreferences("u1", { a: 2 }, 1)).toEqual({ version: 2 });
    const err = await store.putPreferences("u1", { a: 3 }, 1).catch((e) => e);
    expect(err).toBeInstanceOf(VersionConflictError);
    expect((err as VersionConflictError).currentVersion).toBe(2);
    expect(await store.getPreferences("u1")).toEqual({ data: { a: 2 }, version: 2 });
  });

  it("conflict falls back to a consistent Get when the old item is not returned", async () => {
    const { doc, store } = make();
    doc.omitOldItem = true;
    await store.putPreferences("u1", { a: 1 }, 0);
    await store.putPreferences("u1", { a: 2 }, 1);
    const err = await store.putPreferences("u1", { a: 3 }, 0).catch((e) => e);
    expect(err).toBeInstanceOf(VersionConflictError);
    expect((err as VersionConflictError).currentVersion).toBe(2);
  });

  it("non-conditional errors are not mapped to VersionConflictError", async () => {
    const { doc, store } = make();
    const boom = Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" });
    doc.send = async () => {
      throw boom;
    };
    await expect(store.putPreferences("u1", {}, 0)).rejects.toBe(boom);
  });

  it("batch delete retries UnprocessedItems and succeeds", async () => {
    const { doc, store, sleeps } = make();
    await store.putTrip(trip("u1", "a", "2025-01-01T00:00:00.000Z"));
    await store.putTrip(trip("u1", "b", "2025-01-02T00:00:00.000Z"));
    doc.unprocessedScript = [(reqs) => [reqs[0]], (reqs) => [reqs[0]]];
    await store.deleteTrips("u1", ["a", "b"]);
    expect(await store.listTrips("u1")).toEqual([]);
    const batches = doc.commands.filter((c) => c.constructor.name === "BatchWriteCommand");
    expect(batches).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
  });

  it("batch delete throws after 3 retries of UnprocessedItems", async () => {
    const { doc, store, sleeps } = make();
    await store.putTrip(trip("u1", "a", "2025-01-01T00:00:00.000Z"));
    doc.unprocessedScript = Array.from({ length: 10 }, () => (reqs: Rec[]) => reqs);
    await expect(store.deleteTrips("u1", ["a"])).rejects.toThrow(/unprocessed/i);
    const batches = doc.commands.filter((c) => c.constructor.name === "BatchWriteCommand");
    expect(batches).toHaveLength(4); // first attempt + 3 retries
    expect(sleeps).toHaveLength(3);
    expect((await store.listTrips("u1")).length).toBe(1);
  });
});
