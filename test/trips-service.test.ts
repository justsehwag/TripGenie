import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  PLANNING_TTL_SECONDS,
  deleteAccountTrip,
  listAccountTrips,
  mergeGuestTrip,
  saveAccountTrip,
} from "@/lib/account/trips-service";
import { tripIdFor } from "@/lib/account/trip-id";
import { validateTripInput, type ValidatedTrip } from "@/lib/account/validate";
import { ACCOUNT_MAX_TRIPS } from "@/lib/trip-retention";
import { MemoryAccountStore } from "./helpers/memory-account-store";

/**
 * Feature: account-sync, trips service against an in-memory account store.
 * Requirements: 3.4, 3.5, 5.2, 5.5, 5.6, 10.3-10.5
 */

const OWNER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const BASE = Date.parse("2024-01-01T00:00:00.000Z");
const NOW = new Date("2025-06-01T00:00:00.000Z");

/** Clock that advances one second per call. */
function ticking(start = BASE) {
  let t = start;
  return () => new Date((t += 1000));
}

function trip(draft: string, extra: Partial<ValidatedTrip> = {}): ValidatedTrip {
  return { clientDraftId: draft, name: `Trip ${draft}`, status: "ready", payload: { n: draft }, mode: "save", ...extra };
}

function mergeInput(body: Record<string, unknown>, now: Date = NOW): ValidatedTrip {
  const r = validateTripInput({ name: "Guest", payload: {}, mode: "merge", ...body }, { now });
  if (!r.ok) throw new Error(`invalid test input: ${r.error}`);
  return r.value;
}

describe("saveAccountTrip", () => {
  it("is idempotent per clientDraftId and keeps createdAt", async () => {
    const store = new MemoryAccountStore();
    const deps = { store, now: ticking() };
    const a = await saveAccountTrip(deps, OWNER, trip("d1"));
    const created = store.all(OWNER)[0].createdAt;
    const b = await saveAccountTrip(deps, OWNER, trip("d1", { name: "Renamed" }));
    expect(b.id).toBe(a.id);
    expect(a.id).toBe(tripIdFor("d1"));
    const rows = store.all(OWNER);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Renamed");
    expect(rows[0].createdAt).toBe(created);
    expect(rows[0].updatedAt).toBe(b.updatedAt);
  });

  it("property: one record per draft, at most 20 per owner, newest kept", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 29 }), { minLength: 1, maxLength: 80 }), async (ids) => {
        const store = new MemoryAccountStore();
        const deps = { store, now: ticking() };
        for (const i of ids) await saveAccountTrip(deps, OWNER, trip(`draft-${i}`));
        const rows = store.all(OWNER);
        const drafts = rows.map((r) => r.clientDraftId);
        expect(new Set(drafts).size).toBe(drafts.length);
        expect(rows.length).toBeLessThanOrEqual(ACCOUNT_MAX_TRIPS);
        // Expected: the 20 most recently saved distinct drafts.
        const expected: string[] = [];
        for (let k = ids.length - 1; k >= 0 && expected.length < ACCOUNT_MAX_TRIPS; k--) {
          const d = `draft-${ids[k]}`;
          if (!expected.includes(d)) expected.push(d);
        }
        expect(new Set(drafts)).toEqual(new Set(expected));
      }),
      { numRuns: 100 },
    );
  });

  it("ignores a client-supplied owner or ttl", async () => {
    const store = new MemoryAccountStore();
    const parsed = validateTripInput(
      { clientDraftId: "x", name: "N", status: "ready", payload: { a: 1 }, owner: OTHER, ttl: 5 },
      { now: NOW },
    );
    if (!parsed.ok) throw new Error("invalid");
    await saveAccountTrip({ store, now: () => NOW }, OWNER, parsed.value);
    expect(store.all(OTHER)).toHaveLength(0);
    const [rec] = store.all(OWNER);
    expect(rec.owner).toBe(OWNER);
    expect(rec.ttl).toBeUndefined();
  });

  it("sets a server ttl for planning drafts only", async () => {
    const store = new MemoryAccountStore();
    const deps = { store, now: () => NOW };
    await saveAccountTrip(deps, OWNER, trip("p", { status: "planning" }));
    for (const s of ["draft", "in-progress", "ready", "confirmed"] as const) {
      await saveAccountTrip(deps, OWNER, trip(`s-${s}`, { status: s }));
    }
    const byDraft = new Map(store.all(OWNER).map((t) => [t.clientDraftId, t]));
    expect(byDraft.get("p")!.ttl).toBe(Math.floor(NOW.getTime() / 1000) + PLANNING_TTL_SECONDS);
    for (const s of ["draft", "in-progress", "ready", "confirmed"]) {
      expect(byDraft.get(`s-${s}`)!.ttl).toBeUndefined();
    }
  });

  it("drops ttl when a planning draft becomes ready", async () => {
    const store = new MemoryAccountStore();
    const deps = { store, now: ticking() };
    await saveAccountTrip(deps, OWNER, trip("p", { status: "planning" }));
    expect(store.all(OWNER)[0].ttl).toBeTypeOf("number");
    await saveAccountTrip(deps, OWNER, trip("p", { status: "ready" }));
    expect(store.all(OWNER)[0].ttl).toBeUndefined();
  });
});

describe("mergeGuestTrip", () => {
  it("creates the record with the guest updatedAt", async () => {
    const store = new MemoryAccountStore();
    const input = mergeInput({ clientDraftId: "g1", updatedAt: "2024-03-03T10:00:00.000Z" });
    const res = await mergeGuestTrip({ store, now: () => NOW }, OWNER, input);
    expect(res).toEqual({ id: tripIdFor("g1"), created: true, pruned: 0 });
    expect(store.all(OWNER)[0].updatedAt).toBe("2024-03-03T10:00:00.000Z");
  });

  it("keeps an existing record unchanged and creates no duplicate", async () => {
    const store = new MemoryAccountStore();
    const deps = { store, now: ticking() };
    await saveAccountTrip(deps, OWNER, trip("same", { name: "Account version", payload: { v: "account" } }));
    const before = store.all(OWNER);
    const res = await mergeGuestTrip(
      deps,
      OWNER,
      mergeInput({ clientDraftId: "same", name: "Guest version", payload: { v: "guest" }, updatedAt: "2024-05-05T00:00:00.000Z" }),
    );
    expect(res.created).toBe(false);
    expect(res.pruned).toBe(0);
    expect(store.all(OWNER)).toEqual(before);
  });

  it("merging the same guest trips twice leaves the same result", async () => {
    const store = new MemoryAccountStore();
    const deps = { store, now: () => NOW };
    const guests = ["a", "b", "c"].map((d, i) =>
      mergeInput({ clientDraftId: d, updatedAt: `2024-02-0${i + 1}T00:00:00.000Z` }),
    );
    for (const g of guests) await mergeGuestTrip(deps, OWNER, g);
    const first = store.all(OWNER).sort((x, y) => x.tripId.localeCompare(y.tripId));
    const second: boolean[] = [];
    for (const g of guests) second.push((await mergeGuestTrip(deps, OWNER, g)).created);
    expect(second).toEqual([false, false, false]);
    expect(store.all(OWNER).sort((x, y) => x.tripId.localeCompare(y.tripId))).toEqual(first);
  });

  it("clamps a future guest updatedAt to now", async () => {
    const store = new MemoryAccountStore();
    const input = mergeInput({ clientDraftId: "fut", updatedAt: "2999-01-01T00:00:00.000Z" });
    await mergeGuestTrip({ store, now: () => NOW }, OWNER, input);
    expect(store.all(OWNER)[0].updatedAt).toBe(NOW.toISOString());
  });

  it("clamps a guest updatedAt before 2020 to 2020-01-01", async () => {
    const store = new MemoryAccountStore();
    const input = mergeInput({ clientDraftId: "old", updatedAt: "1999-12-31T00:00:00.000Z" });
    await mergeGuestTrip({ store, now: () => NOW }, OWNER, input);
    expect(store.all(OWNER)[0].updatedAt).toBe("2020-01-01T00:00:00.000Z");
  });

  it("merging into a full account prunes the oldest by updatedAt and reports it", async () => {
    const store = new MemoryAccountStore();
    const deps = { store, now: ticking() };
    for (let i = 0; i < ACCOUNT_MAX_TRIPS; i++) await saveAccountTrip(deps, OWNER, trip(`acct-${i}`));
    const res = await mergeGuestTrip(
      deps,
      OWNER,
      mergeInput({ clientDraftId: "guest-new", updatedAt: "2025-01-01T00:00:00.000Z" }),
    );
    expect(res.created).toBe(true);
    expect(res.pruned).toBe(1);
    const drafts = store.all(OWNER).map((t) => t.clientDraftId);
    expect(drafts).toHaveLength(ACCOUNT_MAX_TRIPS);
    expect(drafts).toContain("guest-new");
    expect(drafts).not.toContain("acct-0");
  });

  it("an older guest trip merged into a full account is itself the one pruned", async () => {
    const store = new MemoryAccountStore();
    const deps = { store, now: ticking() };
    for (let i = 0; i < ACCOUNT_MAX_TRIPS; i++) await saveAccountTrip(deps, OWNER, trip(`acct-${i}`));
    const res = await mergeGuestTrip(
      deps,
      OWNER,
      mergeInput({ clientDraftId: "guest-old", updatedAt: "2020-02-02T00:00:00.000Z" }),
    );
    expect(res.pruned).toBe(1);
    const drafts = store.all(OWNER).map((t) => t.clientDraftId);
    expect(drafts).toHaveLength(ACCOUNT_MAX_TRIPS);
    expect(drafts).not.toContain("guest-old");
  });

  it("ignores a client ttl and sets one only for planning drafts", async () => {
    const store = new MemoryAccountStore();
    const deps = { store, now: () => NOW };
    await mergeGuestTrip(deps, OWNER, mergeInput({ clientDraftId: "r", status: "ready", ttl: 1, owner: OTHER }));
    await mergeGuestTrip(deps, OWNER, mergeInput({ clientDraftId: "p", status: "planning", ttl: 1 }));
    const byDraft = new Map(store.all(OWNER).map((t) => [t.clientDraftId, t]));
    expect(byDraft.get("r")!.ttl).toBeUndefined();
    expect(byDraft.get("p")!.ttl).toBe(Math.floor(NOW.getTime() / 1000) + PLANNING_TTL_SECONDS);
    expect(store.all(OTHER)).toHaveLength(0);
  });
});

describe("list and delete", () => {
  it("lists newest first, owner-scoped", async () => {
    const store = new MemoryAccountStore();
    const deps = { store, now: ticking() };
    await saveAccountTrip(deps, OWNER, trip("a"));
    await saveAccountTrip(deps, OWNER, trip("b"));
    await saveAccountTrip(deps, OTHER, trip("c"));
    const res = await listAccountTrips(deps, OWNER);
    expect(res.truncated).toBe(false);
    expect(res.trips.map((t) => t.clientDraftId)).toEqual(["b", "a"]);
  });

  it("delete is owner-scoped and always reports success", async () => {
    const store = new MemoryAccountStore();
    const deps = { store, now: ticking() };
    const saved = await saveAccountTrip(deps, OTHER, trip("theirs"));
    expect(await deleteAccountTrip(deps, OWNER, saved.id)).toEqual({ deleted: true });
    expect(store.all(OTHER)).toHaveLength(1);
    expect(await deleteAccountTrip(deps, OTHER, saved.id)).toEqual({ deleted: true });
    expect(store.all(OTHER)).toHaveLength(0);
  });
});
