import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { BATCH_DAYS, RANGE_RETRY_MAX } from "../lib/itinerary/constants";
import type { BatchResponse } from "../lib/itinerary/batch-wire";
import {
  batchReducer,
  initBatchState,
  nextSlot,
  type BatchEvent,
  type BatchState,
} from "../lib/itinerary/planner-batches";
import type { TripDay } from "../lib/types";

// Unit and property tests for the automatic range retry (planner-missing-days, task 3.1).
const KEY = "k-auto-retry";

function day(n: number): TripDay {
  return {
    day: n,
    title: `Day ${n} plan`,
    activities: [{ id: `a${n}`, title: `Place ${n}`, placeName: `Place ${n}`, verified: true }],
  } as unknown as TripDay;
}

function modelResp(fromDay: number, dayCount: number, verified: number[]): BatchResponse {
  const withheld: number[] = [];
  for (let i = 0; i < dayCount; i++) if (!verified.includes(fromDay + i)) withheld.push(fromDay + i);
  return {
    source: "model",
    fromDay,
    dayCount,
    days: verified.map(day),
    verifiedDays: verified,
    withheldDays: withheld,
  } as unknown as BatchResponse;
}

function unavailableResp(fromDay: number, dayCount: number, reason: string): BatchResponse {
  return { source: "unavailable", fromDay, dayCount, reason } as unknown as BatchResponse;
}

/** Runs the next pending slot with the given verified days, then auto-retry. */
function runNext(s: BatchState, verified: (from: number, count: number) => number[], auto = true): BatchState {
  const slot = nextSlot(s);
  if (!slot) throw new Error("no slot");
  let t = batchReducer(s, { type: "request", slotId: slot.id });
  t = batchReducer(t, {
    type: "response",
    slotId: slot.id,
    tripKey: KEY,
    resp: modelResp(slot.fromDay, slot.dayCount, verified(slot.fromDay, slot.dayCount)),
  });
  return auto ? batchReducer(t, { type: "auto-retry" }) : t;
}

function started(total: number): BatchState {
  return batchReducer(initBatchState(), { type: "start", tripKey: KEY, totalDays: total });
}

describe("auto-retry reducer event", () => {
  it("turns withheld days into pending retry slots with rangeAuto 1", () => {
    let s = started(4);
    s = runNext(s, (f, c) => (f === 1 ? [1, 3] : [f]));
    expect(s.withheld).toEqual([]);
    expect(s.pending).toContain(2);
    const retry = s.slots.find((x) => x.status === "pending" && x.fromDay === 2);
    expect(retry).toMatchObject({ fromDay: 2, dayCount: 1, auto: 0, attempts: 0, rangeAuto: 1 });
    expect(s.phase).toBe("running");
    expect(nextSlot(s)?.fromDay).toBe(2);
  });

  it("groups contiguous withheld days into one run and splits at BATCH_DAYS", () => {
    const total = BATCH_DAYS * 2 + 1;
    let s = started(total);
    // Verify nothing in the first batch, so the whole first range is withheld.
    const first = nextSlot(s)!;
    s = runNext(s, () => []);
    const retries = s.slots.filter((x) => x.status === "pending" && x.rangeAuto === 1);
    expect(retries.length).toBe(1);
    expect(retries[0]).toMatchObject({ fromDay: first.fromDay, dayCount: first.dayCount });
    for (const r of retries) expect(r.dayCount).toBeLessThanOrEqual(BATCH_DAYS);
  });

  it("splits a long withheld run into slots of at most BATCH_DAYS", () => {
    // Several done slots that each withhold everything, merged into one contiguous run.
    let s = started(BATCH_DAYS * 2);
    s = runNext(s, () => [], false);
    s = runNext(s, () => [], false);
    expect(s.withheld.length).toBe(BATCH_DAYS * 2);
    s = batchReducer(s, { type: "auto-retry" });
    const retries = s.slots.filter((x) => x.status === "pending");
    expect(retries.length).toBe(2);
    for (const r of retries) expect(r.dayCount).toBeLessThanOrEqual(BATCH_DAYS);
    expect(retries.reduce((n, r) => n + r.dayCount, 0)).toBe(BATCH_DAYS * 2);
  });

  it("stops after RANGE_RETRY_MAX automatic retries per range", () => {
    let s = started(2);
    s = runNext(s, (f) => (f === 1 ? [1] : []));
    for (let i = 1; i <= RANGE_RETRY_MAX; i++) {
      expect(s.pending).toEqual([2]);
      s = runNext(s, () => []);
    }
    expect(s.pending).toEqual([]);
    expect(s.withheld).toEqual([2]);
    expect(s.phase).toBe("partial");
    expect(Math.max(...s.slots.map((x) => x.rangeAuto ?? 0))).toBe(RANGE_RETRY_MAX);
    // Further auto-retry is a no-op.
    expect(batchReducer(s, { type: "auto-retry" })).toBe(s);
  });

  it("is a no-op when everything verified", () => {
    const s = runNext(started(3), (f, c) => Array.from({ length: c }, (_, i) => f + i));
    expect(s.phase).toBe("complete");
    expect(batchReducer(s, { type: "auto-retry" })).toBe(s);
  });

  it("skips not-configured", () => {
    let s = started(3);
    const slot = nextSlot(s)!;
    s = batchReducer(s, { type: "request", slotId: slot.id });
    s = batchReducer(s, { type: "response", slotId: slot.id, tripKey: KEY, resp: unavailableResp(1, 3, "not-configured") });
    expect(s.withheld.length).toBeGreaterThan(0);
    expect(batchReducer(s, { type: "auto-retry" })).toBe(s);
  });

  it("skips withheld days whose slot failed (no done parent)", () => {
    let s = started(3);
    const slot = nextSlot(s)!;
    s = batchReducer(s, { type: "request", slotId: slot.id });
    s = batchReducer(s, { type: "response", slotId: slot.id, tripKey: KEY, resp: unavailableResp(1, 3, "unverified") });
    s = batchReducer(s, { type: "auto-retry" });
    expect(s.slots.every((x) => x.rangeAuto === undefined)).toBe(true);
  });

  it("skips while a request is in flight", () => {
    let s = started(6);
    s = runNext(s, (f) => (f === 1 ? [1] : [f]), false);
    expect(s.withheld.length).toBeGreaterThan(0);
    const slot = nextSlot(s)!;
    const inflight = batchReducer(s, { type: "request", slotId: slot.id });
    expect(inflight.inFlight).not.toBeNull();
    expect(batchReducer(inflight, { type: "auto-retry" })).toBe(inflight);
  });

  it("manual retry slots carry RANGE_RETRY_MAX and never trigger an auto retry", () => {
    let s = started(2);
    s = runNext(s, (f) => (f === 1 ? [1] : []), false);
    s = batchReducer(s, { type: "retry", fromDay: 2, toDay: 2 });
    const manual = s.slots.find((x) => x.status === "pending" && x.fromDay === 2)!;
    expect(manual.rangeAuto).toBe(RANGE_RETRY_MAX);
    s = runNext(s, () => [], true);
    expect(s.withheld).toEqual([2]);
    expect(s.pending).toEqual([]);
    expect(s.slots.filter((x) => x.status === "pending")).toEqual([]);
  });
});

describe("auto-retry invariants", () => {
  it("keeps verified, withheld and pending sorted, disjoint and covering 1..N", () => {
    const sorted = (a: number[]) => a.every((v, i) => i === 0 || a[i - 1] < v);
    const ev = fc.oneof(
      fc.constant<"request">("request"),
      fc.constant<"auto">("auto"),
      fc.constant<"net">("net"),
      fc.constant<"retry">("retry"),
      fc.constant<"cancel">("cancel"),
      fc.constant<"nc">("nc"),
      fc.array(fc.boolean(), { minLength: 0, maxLength: 8 }).map((mask) => ({ mask })),
    );
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9 }), fc.array(ev, { maxLength: 40 }), (total, events) => {
        let s = started(total);
        for (const e of events) {
          let event: BatchEvent;
          const slotId = s.inFlight ?? nextSlot(s)?.id ?? 0;
          const slot = s.slots.find((x) => x.id === slotId);
          if (e === "request") event = { type: "request", slotId };
          else if (e === "auto") event = { type: "auto-retry" };
          else if (e === "net") event = { type: "network-error", slotId, tripKey: KEY };
          else if (e === "retry") event = { type: "retry", fromDay: 1, toDay: total };
          else if (e === "cancel") event = { type: "cancel" };
          else if (e === "nc") event = { type: "response", slotId, tripKey: KEY, resp: unavailableResp(slot?.fromDay ?? 1, slot?.dayCount ?? 1, "not-configured") };
          else {
            const from = slot?.fromDay ?? 1;
            const count = slot?.dayCount ?? 1;
            const verified = e.mask.slice(0, count).map((b, i) => (b ? from + i : 0)).filter((d) => d > 0);
            event = { type: "response", slotId, tripKey: KEY, resp: modelResp(from, count, verified) };
          }
          s = batchReducer(s, event);
          expect(sorted(s.verified) && sorted(s.withheld) && sorted(s.pending)).toBe(true);
          const all = [...s.verified, ...s.withheld, ...s.pending].sort((a, b) => a - b);
          expect(all).toEqual(Array.from({ length: total }, (_, i) => i + 1));
          for (const x of s.slots) expect(x.rangeAuto ?? 0).toBeLessThanOrEqual(RANGE_RETRY_MAX);
        }
      }),
      { numRuns: 200 },
    );
  });
});
