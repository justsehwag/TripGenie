// Feature: account-sync, guest merge logic (Requirements 5.1-5.4)
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { StoredTrip } from "@/lib/trip-retention";
import {
  planMerge,
  applyMergeResults,
  droppedCount,
  type MergeResult,
} from "@/lib/account/merge";

function trip(id: string, n = 0): StoredTrip {
  return {
    tripId: `t_${id}_${n}`,
    owner: "guest",
    clientDraftId: id,
    name: `Trip ${id}`,
    status: "planning",
    payload: { n },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: `2024-02-0${(n % 9) + 1}T00:00:00.000Z`,
  };
}

const tripsArb = fc
  .array(fc.tuple(fc.constantFrom("a", "b", "c", "d", "e", "f"), fc.nat(50)), { maxLength: 12 })
  .map((xs) => xs.map(([id, n]) => trip(id, n)));

describe("planMerge", () => {
  it("uploads each distinct clientDraftId once, first wins", () => {
    const uploads = planMerge([trip("a", 1), trip("b", 2), trip("a", 3)]);
    expect(uploads.map((u) => u.clientDraftId)).toEqual(["a", "b"]);
    expect(uploads[0].payload).toEqual({ n: 1 });
  });

  it("keeps original order, guest updatedAt and merge mode", () => {
    const guest = [trip("c", 1), trip("a", 2), trip("b", 3)];
    const uploads = planMerge(guest);
    expect(uploads.map((u) => u.clientDraftId)).toEqual(["c", "a", "b"]);
    uploads.forEach((u, i) => {
      expect(u.updatedAt).toBe(guest[i].updatedAt);
      expect(u.mode).toBe("merge");
    });
  });

  it("returns nothing for empty history", () => {
    expect(planMerge([])).toEqual([]);
  });

  it("property: no duplicate uploads", () => {
    fc.assert(
      fc.property(tripsArb, (guest) => {
        const ids = planMerge(guest).map((u) => u.clientDraftId);
        expect(new Set(ids).size).toBe(ids.length);
        expect(new Set(ids)).toEqual(new Set(guest.map((t) => t.clientDraftId)));
      }),
      { numRuns: 100 },
    );
  });
});

describe("applyMergeResults", () => {
  const five = ["1", "2", "3", "4", "5"].map((id) => trip(id));

  it("keeps only failed trips, in original order", () => {
    const results: MergeResult[] = [
      { clientDraftId: "1", ok: true },
      { clientDraftId: "2", ok: false },
      { clientDraftId: "3", ok: true },
      { clientDraftId: "4", ok: false },
      { clientDraftId: "5", ok: true },
    ];
    expect(applyMergeResults(five, results).map((t) => t.clientDraftId)).toEqual(["2", "4"]);
  });

  it("a crash after trip 2 leaves trips 3 to 5", () => {
    const results: MergeResult[] = [
      { clientDraftId: "1", ok: true },
      { clientDraftId: "2", ok: true },
    ];
    expect(applyMergeResults(five, results).map((t) => t.clientDraftId)).toEqual(["3", "4", "5"]);
  });

  it("keeps everything when there are no results", () => {
    expect(applyMergeResults(five, [])).toEqual(five);
  });

  it("property: keeps exactly the trips without a confirmed result", () => {
    fc.assert(
      fc.property(
        tripsArb,
        fc.array(fc.tuple(fc.constantFrom("a", "b", "c", "d", "e", "f"), fc.boolean()), {
          maxLength: 12,
        }),
        (guest, raw) => {
          const results: MergeResult[] = raw.map(([clientDraftId, ok]) => ({ clientDraftId, ok }));
          const okIds = new Set(results.filter((r) => r.ok).map((r) => r.clientDraftId));
          const kept = applyMergeResults(guest, results);
          expect(kept).toEqual(guest.filter((t) => !okIds.has(t.clientDraftId)));
          for (const t of kept) expect(okIds.has(t.clientDraftId)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("droppedCount", () => {
  it("sums pruned values", () => {
    expect(
      droppedCount([
        { clientDraftId: "a", ok: true, pruned: 2 },
        { clientDraftId: "b", ok: true, pruned: 3 },
        { clientDraftId: "c", ok: false },
      ]),
    ).toBe(5);
  });

  it("ignores invalid, negative and non-finite values", () => {
    const results = [
      { clientDraftId: "a", ok: true, pruned: NaN },
      { clientDraftId: "b", ok: true, pruned: Infinity },
      { clientDraftId: "c", ok: true, pruned: -4 },
      { clientDraftId: "d", ok: true, pruned: "7" as unknown as number },
      { clientDraftId: "e", ok: true, pruned: 1 },
    ];
    expect(droppedCount(results)).toBe(1);
  });

  it("is 0 for no results", () => {
    expect(droppedCount([])).toBe(0);
  });
});
