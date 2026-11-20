import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  batchReducer,
  buildRequest,
  initBatchState,
  nextSlot,
  retryRuns,
  tripKeyOf,
  type BatchEvent,
  type BatchState,
} from "../lib/itinerary/planner-batches";
import { readBatchResponse, unavailable, type BatchReason, type BatchResponse } from "../lib/itinerary/batch-wire";
import { buildMapsUrl } from "../lib/itinerary/maps-link";
import { nameKey } from "../lib/itinerary/place-key";
import { cleanUsedName } from "../lib/itinerary/text";
import { AUTO_RETRY_MAX, BATCH_DAYS, MAX_TRIP_DAYS, MAX_USED_PLACES } from "../lib/itinerary/constants";
import type { Activity, TripContext, TripDay } from "../lib/types";

const NUM_RUNS = 150;
const KEY = "trip-key-a";
const REASONS: BatchReason[] = ["not-configured", "unavailable", "unverified"];

// ---- Builders (test inputs only) ----

let uniq = 0;

function activity(name: string, verified = true): Activity {
  const a: Activity = { time: "09:00", title: name, description: "", cost: 0 };
  if (verified) {
    const placeId = `pid-${nameKey(name) || "x"}`;
    a.placeName = name;
    a.placeId = placeId;
    a.verified = true;
    a.mapsUrl = buildMapsUrl(placeId, name);
  }
  return a;
}

function day(n: number, names: string[], dayTrip = false): TripDay {
  const d: TripDay = {
    day: n,
    date: "",
    title: `Day ${n}`,
    theme: "",
    activities: names.map((x) => activity(x)),
    total: 0,
  };
  if (dayTrip) d.dayTrip = true;
  return d;
}

/** A well-formed "model" response for the given slot window. */
function modelResp(fromDay: number, dayCount: number, verifiedDays: TripDay[]): BatchResponse {
  const nums = verifiedDays.map((d) => d.day);
  const withheld: number[] = [];
  for (let i = 0; i < dayCount; i++) if (!nums.includes(fromDay + i)) withheld.push(fromDay + i);
  const raw = {
    source: "model",
    fromDay,
    dayCount,
    days: verifiedDays,
    verifiedDays: nums,
    withheldDays: withheld,
    truncated: false,
    stats: { proposed: dayCount, verified: nums.length, removed: 0, ms: 1 },
  };
  const r = readBatchResponse(raw);
  if (!r) throw new Error("test builder produced an unreadable response");
  return r;
}

function driveSlot(s: BatchState, resp: (fromDay: number, dayCount: number) => BatchResponse): BatchState {
  const slot = nextSlot(s);
  if (!slot) throw new Error("no next slot");
  const s1 = batchReducer(s, { type: "request", slotId: slot.id });
  return batchReducer(s1, { type: "response", slotId: slot.id, tripKey: s.tripKey, resp: resp(slot.fromDay, slot.dayCount) });
}

function expectedUsed(days: readonly TripDay[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of days) {
    for (const a of d.activities) {
      if (a.verified !== true) continue;
      const name = cleanUsedName(a.placeName && a.placeName.trim() ? a.placeName : a.title);
      const k = nameKey(name);
      if (!name || !k || seen.has(k)) continue;
      seen.add(k);
      out.push(name);
    }
  }
  return out.slice(0, MAX_USED_PLACES);
}

const sortedAsc = (a: number[]) => a.every((v, i) => i === 0 || a[i - 1] < v);

// ---- Invariants checked after every step ----

function checkInvariants(s: BatchState): void {
  const loading = s.slots.filter((x) => x.status === "loading");
  expect(loading.length).toBeLessThanOrEqual(1);
  if (loading.length === 1) expect(s.inFlight).toBe(loading[0].id);
  else expect(s.inFlight).toBeNull();

  expect(sortedAsc(s.verified)).toBe(true);
  expect(sortedAsc(s.withheld)).toBe(true);
  expect(sortedAsc(s.pending)).toBe(true);
  const all = [...s.verified, ...s.withheld, ...s.pending];
  expect(new Set(all).size).toBe(all.length);
  expect([...all].sort((a, b) => a - b)).toEqual(Array.from({ length: s.totalDays }, (_, i) => i + 1));
  expect(s.days.map((d) => d.day)).toEqual(s.verified);

  for (const slot of s.slots) {
    expect(slot.auto).toBeLessThanOrEqual(AUTO_RETRY_MAX);
    expect(slot.dayCount).toBeGreaterThanOrEqual(1);
    expect(slot.dayCount).toBeLessThanOrEqual(BATCH_DAYS);
  }

  expect(s.usedPlaces.length).toBeLessThanOrEqual(MAX_USED_PLACES);
  const keys = s.usedPlaces.map(nameKey);
  expect(new Set(keys).size).toBe(keys.length);
  expect(s.usedPlaces).toEqual(expectedUsed(s.days));
  expect(s.dayTripsUsed).toBe(s.days.filter((d) => d.dayTrip === true).length);

  if (s.phase === "complete") {
    expect(s.pending).toEqual([]);
    expect(s.withheld).toEqual([]);
  }
  if (s.phase === "failed") {
    expect(s.verified).toEqual([]);
    expect(nextSlot(s)).toBeNull();
  }
}

// ---- Action model: plain data resolved against the current state ----

type Action =
  | { k: "start"; total: number }
  | { k: "request" }
  | { k: "request-bad"; slotId: number }
  | { k: "ok"; mask: boolean[]; names: number[][]; trips: boolean[] }
  | { k: "unavailable"; reason: BatchReason }
  | { k: "dup" }
  | { k: "stale-key" }
  | { k: "stale-slot"; delta: number }
  | { k: "net" }
  | { k: "net-stale" }
  | { k: "retry"; a: number; b: number }
  | { k: "cancel" };

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  { weight: 1, arbitrary: fc.record({ k: fc.constant("start" as const), total: fc.integer({ min: 1, max: MAX_TRIP_DAYS }) }) },
  { weight: 8, arbitrary: fc.record({ k: fc.constant("request" as const) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("request-bad" as const), slotId: fc.integer({ min: -2, max: 20 }) }) },
  {
    weight: 8,
    arbitrary: fc.record({
      k: fc.constant("ok" as const),
      mask: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
      names: fc.array(fc.array(fc.integer({ min: 0, max: 14 }), { maxLength: 10 }), { minLength: 3, maxLength: 3 }),
      trips: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
    }),
  },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("unavailable" as const), reason: fc.constantFrom(...REASONS) }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant("dup" as const) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("stale-key" as const) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("stale-slot" as const), delta: fc.integer({ min: 1, max: 5 }) }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant("net" as const) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("net-stale" as const) }) },
  {
    weight: 4,
    arbitrary: fc.record({
      k: fc.constant("retry" as const),
      a: fc.integer({ min: 1, max: MAX_TRIP_DAYS }),
      b: fc.integer({ min: 1, max: MAX_TRIP_DAYS }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("cancel" as const) }) },
);

const NAME_POOL = [
  "Fort", "fort", "Museum", "MUSEUM ", "Lake Palace", "Old Market", "Temple", "Garden", "Beach",
  "Cafe Noir", "Harbour", "Tower", "Bridge", "Zoo", "Library",
];

function respFor(state: BatchState, a: Extract<Action, { k: "ok" }>): BatchResponse | null {
  const slotId = state.inFlight;
  const slot = state.slots.find((x) => x.id === slotId);
  if (!slot) return null;
  const days: TripDay[] = [];
  for (let i = 0; i < slot.dayCount; i++) {
    if (!a.mask[i]) continue;
    const names = a.names[i].map((n, j) => (n < NAME_POOL.length ? NAME_POOL[n] : `Unique ${++uniq}-${j}`));
    days.push(day(slot.fromDay + i, names, a.trips[i]));
  }
  return modelResp(slot.fromDay, slot.dayCount, days);
}

describe("Property 18: Planner state machine", () => {
  // Feature: trustworthy-itinerary, Property 18: Planner state machine
  it("keeps every invariant after every step of any weighted event sequence", () => {
    fc.assert(
      fc.property(fc.array(actionArb, { minLength: 1, maxLength: 80 }), (actions) => {
        let s = initBatchState();
        let key = KEY;
        let lastResp: Extract<BatchEvent, { type: "response" }> | null = null;
        let watermark = 0; // fromDay of the last requested slot since the last retry/start

        for (const a of actions) {
          const prev = s;
          let ev: BatchEvent | null = null;
          let stale = false;

          switch (a.k) {
            case "start":
              key = `${KEY}-${a.total}-${prev.nextSlotId}`;
              ev = { type: "start", tripKey: key, totalDays: a.total };
              break;
            case "request": {
              const n = nextSlot(prev);
              ev = { type: "request", slotId: n ? n.id : 0 };
              break;
            }
            case "request-bad":
              ev = { type: "request", slotId: a.slotId };
              break;
            case "ok": {
              const r = prev.inFlight !== null ? respFor(prev, a) : null;
              if (r) ev = { type: "response", slotId: prev.inFlight as number, tripKey: prev.tripKey, resp: r };
              break;
            }
            case "unavailable": {
              const slot = prev.slots.find((x) => x.id === prev.inFlight);
              if (slot) {
                ev = {
                  type: "response",
                  slotId: slot.id,
                  tripKey: prev.tripKey,
                  resp: unavailable({ fromDay: slot.fromDay, dayCount: slot.dayCount }, a.reason),
                };
              }
              break;
            }
            case "dup":
              if (lastResp) {
                ev = lastResp;
                stale = prev.inFlight !== lastResp.slotId || prev.tripKey !== lastResp.tripKey;
              }
              break;
            case "stale-key": {
              const slot = prev.slots.find((x) => x.id === prev.inFlight);
              if (slot) {
                ev = {
                  type: "response",
                  slotId: slot.id,
                  tripKey: prev.tripKey + "-other",
                  resp: unavailable({ fromDay: slot.fromDay, dayCount: slot.dayCount }, "unverified"),
                };
                stale = true;
              }
              break;
            }
            case "stale-slot": {
              const slot = prev.slots.find((x) => x.id === prev.inFlight);
              const id = (prev.inFlight ?? 0) + a.delta;
              ev = {
                type: "response",
                slotId: id,
                tripKey: prev.tripKey,
                resp: unavailable({ fromDay: slot?.fromDay ?? 1, dayCount: slot?.dayCount ?? 1 }, "unverified"),
              };
              stale = true;
              break;
            }
            case "net":
              if (prev.inFlight !== null) ev = { type: "network-error", slotId: prev.inFlight, tripKey: prev.tripKey };
              break;
            case "net-stale":
              ev = { type: "network-error", slotId: (prev.inFlight ?? 0) + 1, tripKey: prev.tripKey };
              stale = true;
              break;
            case "retry":
              ev = { type: "retry", fromDay: a.a, toDay: a.b };
              break;
            case "cancel":
              ev = { type: "cancel" };
              break;
          }
          if (!ev) continue;

          s = batchReducer(prev, ev); // never throws
          checkInvariants(s);
          if (ev.type === "response") lastResp = ev;

          // Stale and duplicate responses are no-ops (same reference).
          if (stale || (ev.type === "response" && prev.inFlight === null)) expect(s).toBe(prev);
          if (ev.type === "network-error" && (prev.inFlight === null || ev.slotId !== prev.inFlight)) expect(s).toBe(prev);

          if (ev.type === "start") {
            watermark = 0;
            expect(s.pending).toEqual(Array.from({ length: s.totalDays }, (_, i) => i + 1));
            expect(s.phase).toBe("running");
            continue;
          }

          // Verified days never change once verified (same object).
          for (const d of prev.days) expect(s.days.find((x) => x.day === d.day)).toBe(d);
          expect(s.verified).toEqual(expect.arrayContaining(prev.verified));

          if (ev.type === "request") {
            const changed = s !== prev;
            if (changed) {
              const pend = prev.slots.filter((x) => x.status === "pending");
              const minFrom = Math.min(...pend.map((x) => x.fromDay));
              const slot = prev.slots.find((x) => x.id === ev.slotId)!;
              expect(prev.inFlight).toBeNull();
              expect(prev.phase).toBe("running");
              expect(slot.status).toBe("pending");
              expect(slot.fromDay).toBe(minFrom);
              expect(s.inFlight).toBe(ev.slotId);
              expect(slot.fromDay).toBeGreaterThanOrEqual(watermark);
              watermark = slot.fromDay;
            } else {
              expect(s).toBe(prev);
            }
          }

          if (ev.type === "retry") {
            watermark = 0;
            const lo = Math.min(ev.fromDay, ev.toDay);
            const hi = Math.max(ev.fromDay, ev.toDay);
            expect(s.verified).toEqual(prev.verified);
            expect(s.days).toEqual(prev.days);
            for (const w of s.withheld) expect(prev.withheld).toContain(w);
            for (const w of prev.withheld) {
              if (!s.withheld.includes(w)) {
                expect(w).toBeGreaterThanOrEqual(lo);
                expect(w).toBeLessThanOrEqual(hi);
              }
            }
            for (const p of prev.pending) expect(s.pending).toContain(p);
            for (const slot of s.slots) {
              if (!prev.slots.some((x) => x.id === slot.id)) {
                expect(slot.auto).toBe(0);
                expect(slot.status).toBe("pending");
              }
            }
          }

          if (ev.type === "response" && s !== prev) {
            const before = prev.slots.find((x) => x.id === ev.slotId)!;
            const after = s.slots.find((x) => x.id === ev.slotId)!;
            if (ev.resp.source === "unavailable" && ev.resp.reason === "not-configured") {
              expect(after.auto).toBe(before.auto);
              expect(after.status).toBe("failed");
            }
            if (after.status === "failed") {
              for (let i = 0; i < after.dayCount; i++) expect(s.withheld).toContain(after.fromDay + i);
            }
          }
          if (ev.type === "network-error" && s !== prev) {
            const before = prev.slots.find((x) => x.id === ev.slotId)!;
            const after = s.slots.find((x) => x.id === ev.slotId)!;
            if (before.auto < AUTO_RETRY_MAX) {
              expect(after.status).toBe("pending");
              expect(after.auto).toBe(before.auto + 1);
            } else {
              expect(after.status).toBe("failed");
            }
          }
          if (ev.type === "cancel") {
            expect(s.inFlight).toBeNull();
            expect(s.slots.some((x) => x.status === "loading")).toBe(false);
          }

          // No later slot is ever requested once the first slot failed with nothing verified.
          if (s.phase === "failed") {
            const n = Math.max(...s.slots.map((x) => x.id)) + 1;
            expect(batchReducer(s, { type: "request", slotId: n })).toBe(s);
            for (const slot of s.slots) expect(batchReducer(s, { type: "request", slotId: slot.id })).toBe(s);
          }
        }
        return true;
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("garbage events and states never throw", () => {
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (st, ev) => {
        expect(() => batchReducer(st as BatchState, ev as BatchEvent)).not.toThrow();
        return true;
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("a 10-day trip makes four requests in order 1-3, 4-6, 7-9, 10", () => {
    let s = batchReducer(initBatchState(), { type: "start", tripKey: KEY, totalDays: 10 });
    const ctx = { destination: "Jaipur", durationDays: 10 } as TripContext;
    const sent: Array<[number, number]> = [];
    let guard = 0;
    while (nextSlot(s) && guard++ < 20) {
      const slot = nextSlot(s)!;
      sent.push([buildRequest(s, slot, ctx).fromDay, buildRequest(s, slot, ctx).dayCount]);
      s = driveSlot(s, (f, c) =>
        modelResp(f, c, Array.from({ length: c }, (_, i) => day(f + i, [`Stop ${f + i}`]))),
      );
      checkInvariants(s);
    }
    expect(sent).toEqual([[1, 3], [4, 3], [7, 3], [10, 1]]);
    expect(s.phase).toBe("complete");
    expect(s.verified).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("first batch failing with not-configured ends failed without requesting batch 2", () => {
    let s = batchReducer(initBatchState(), { type: "start", tripKey: KEY, totalDays: 10 });
    s = driveSlot(s, (f, c) => unavailable({ fromDay: f, dayCount: c }, "not-configured"));
    expect(s.phase).toBe("failed");
    expect(s.reason).toBe("not-configured");
    expect(s.slots[0].auto).toBe(0);
    expect(s.withheld).toEqual([1, 2, 3]);
    expect(nextSlot(s)).toBeNull();
    const second = s.slots[1];
    expect(second.status).toBe("pending");
    expect(second.attempts).toBe(0);
    expect(batchReducer(s, { type: "request", slotId: second.id })).toBe(s);
  });

  it("a network error is retried once automatically, then the slot is withheld", () => {
    let s = batchReducer(initBatchState(), { type: "start", tripKey: KEY, totalDays: 6 });
    s = driveSlot(s, (f, c) => modelResp(f, c, [day(f, ["A"]), day(f + 1, ["B"]), day(f + 2, ["C"])]));
    s = batchReducer(s, { type: "request", slotId: nextSlot(s)!.id });
    s = batchReducer(s, { type: "network-error", slotId: s.inFlight!, tripKey: KEY });
    expect(s.slots[1].status).toBe("pending");
    expect(s.slots[1].auto).toBe(1);
    expect(s.phase).toBe("running");
    s = batchReducer(s, { type: "request", slotId: nextSlot(s)!.id });
    s = batchReducer(s, { type: "network-error", slotId: s.inFlight!, tripKey: KEY });
    expect(s.slots[1].status).toBe("failed");
    expect(s.withheld).toEqual([4, 5, 6]);
    expect(s.phase).toBe("partial");
    checkInvariants(s);
  });

  it("retrying days 4 to 6 sends the used places of every verified day including 7 to 9", () => {
    let s = batchReducer(initBatchState(), { type: "start", tripKey: KEY, totalDays: 10 });
    const ctx = { destination: "Jaipur", durationDays: 10 } as TripContext;
    const okResp = (f: number, c: number) =>
      modelResp(f, c, Array.from({ length: c }, (_, i) => day(f + i, [`Stop ${f + i}`])));
    s = driveSlot(s, okResp);
    // Batch 2 fails twice (one automatic retry, then withheld).
    for (let i = 0; i < 2; i++) {
      s = batchReducer(s, { type: "request", slotId: nextSlot(s)!.id });
      s = batchReducer(s, {
        type: "response",
        slotId: s.inFlight!,
        tripKey: KEY,
        resp: unavailable({ fromDay: 4, dayCount: 3 }, "unverified"),
      });
    }
    expect(s.withheld).toEqual([4, 5, 6]);
    s = driveSlot(s, okResp); // 7-9
    s = driveSlot(s, okResp); // 10
    expect(s.phase).toBe("partial");

    s = batchReducer(s, { type: "retry", fromDay: 4, toDay: 6 });
    expect(s.phase).toBe("running");
    const slot = nextSlot(s)!;
    expect([slot.fromDay, slot.dayCount, slot.auto]).toEqual([4, 3, 0]);
    const req = buildRequest(s, slot, ctx, "2025-01-10");
    expect(req.fromDay).toBe(4);
    expect(req.usedPlaces).toEqual(["Stop 1", "Stop 2", "Stop 3", "Stop 7", "Stop 8", "Stop 9", "Stop 10"]);
    expect(req.startDate).toBe("2025-01-10");
    expect(req.context.durationDays).toBe(10);
  });

  it("caps usedPlaces at 100 distinct names", () => {
    let s = batchReducer(initBatchState(), { type: "start", tripKey: KEY, totalDays: MAX_TRIP_DAYS });
    let n = 0;
    while (nextSlot(s)) {
      s = driveSlot(s, (f, c) =>
        modelResp(f, c, Array.from({ length: c }, (_, i) => day(f + i, Array.from({ length: 10 }, () => `Spot ${++n}`)))),
      );
      checkInvariants(s);
    }
    expect(s.usedPlaces.length).toBe(MAX_USED_PLACES);
    expect(s.phase).toBe("complete");
  });

  it("retryRuns groups contiguous days and tripKeyOf is stable", () => {
    expect(retryRuns([7, 4, 5, 6, 10])).toEqual([{ from: 4, to: 7 }, { from: 10, to: 10 }]);
    const ctx = { destination: " Goa ", durationDays: 3, interests: ["b", "A"] } as TripContext;
    expect(tripKeyOf(ctx)).toBe(tripKeyOf({ ...ctx, destination: "goa", interests: ["a", "B"] }));
  });
});
