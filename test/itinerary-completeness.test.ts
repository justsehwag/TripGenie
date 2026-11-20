// @vitest-environment node
// Property tests for lib/itinerary/completeness.ts and partial-itinerary pricing.
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  buildTimeline,
  initialCompleteness,
  isComplete,
  mergeBatch,
  settlePending,
  verifiedLabel,
} from "@/lib/itinerary/completeness";
import { computeSummary } from "@/lib/trip-summary";
import { toPricerRequest } from "@/lib/itinerary-inr";
import { MAX_ACTIVITIES } from "@/lib/activity-pricer";
import type { Activity, Itinerary, ItineraryCompleteness, TripDay } from "@/lib/types";

const NUM_RUNS = 100;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const activityArb: fc.Arbitrary<Activity> = fc.record({
  time: fc.constantFrom("09:00", "11:30", "14:00", "18:30"),
  title: fc.string({ minLength: 1, maxLength: 20 }),
  description: fc.string({ maxLength: 30 }),
  cost: fc.integer({ min: 0, max: 20_000 }),
  costBasis: fc.constantFrom<"person" | "group" | undefined>("person", "group", undefined),
}).map((a) => {
  const out: Activity = { time: a.time, title: a.title, description: a.description, cost: a.cost };
  if (a.costBasis) out.costBasis = a.costBasis;
  return out; // batch activities carry no `category`
});

function dayArb(day: number): fc.Arbitrary<TripDay> {
  return fc
    .tuple(fc.array(activityArb, { minLength: 1, maxLength: 6 }), fc.string({ maxLength: 10 }))
    .map(([activities, title]) => ({
      day,
      date: "2030-01-01",
      title,
      theme: "t",
      activities,
      total: activities.reduce((s, a) => s + a.cost, 0),
    }));
}

/** A trip length and an itinerary whose days are a random subset of 1..N. */
const tripArb = fc
  .integer({ min: 1, max: 14 })
  .chain((n) =>
    fc
      .tuple(
        fc.subarray(Array.from({ length: n }, (_, i) => i + 1)),
        fc.subarray(Array.from({ length: n }, (_, i) => i + 1)),
      )
      .chain(([verified, withheldRaw]) =>
        fc.tuple(...verified.map((d) => dayArb(d))).map((days) => {
          const withheld = withheldRaw.filter((d) => !verified.includes(d));
          const pending = Array.from({ length: n }, (_, i) => i + 1).filter(
            (d) => !verified.includes(d) && !withheld.includes(d),
          );
          const completeness: ItineraryCompleteness = {
            requestedDays: n,
            verifiedDays: verified,
            withheldDays: withheld,
            pendingDays: pending,
          };
          const itinerary: Itinerary = {
            title: "Trip",
            totalCost: days.reduce((s, d) => s + d.total, 0),
            days: days as TripDay[],
            costUnit: "inr",
            completeness,
          };
          return { n, itinerary };
        }),
      ),
  );

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let d = from; d <= to; d++) out.push(d);
  return out;
}

function expectPartition(c: ItineraryCompleteness, n: number): void {
  const all = [...c.verifiedDays, ...c.withheldDays, ...(c.pendingDays ?? [])];
  expect(new Set(all).size).toBe(all.length); // pairwise disjoint
  expect([...all].sort((a, b) => a - b)).toEqual(range(1, n)); // exactly 1..N
  for (const list of [c.verifiedDays, c.withheldDays, c.pendingDays ?? []]) {
    expect(list).toEqual([...list].sort((a, b) => a - b));
  }
  expect(c.requestedDays).toBe(n);
}

// ---------------------------------------------------------------------------
// Property 17
// ---------------------------------------------------------------------------

describe("itinerary completeness", () => {
  // Feature: trustworthy-itinerary, Property 17: Completeness merge and partition
  it("Property 17: mergeBatch keeps existing days, stays sorted/unique, recomputes cost and partitions 1..N", () => {
    // **Validates: Requirements 5.7, 5.8, 6.12, 6.13, 6.14, 8.1, 8.6, 10.9, 12.2**
    fc.assert(
      fc.property(
        tripArb,
        fc.array(fc.integer({ min: -2, max: 16 }), { maxLength: 8 }),
        fc.array(fc.integer({ min: -2, max: 16 }), { maxLength: 8 }),
        fc.boolean(),
        fc.integer({ min: 0, max: 2 }),
        (trip, respVerifiedRaw, respWithheldRaw, hasPrior, batchSize) => {
          const { n, itinerary } = trip;
          const prior = hasPrior ? itinerary : null;
          // batch: days from the generated itinerary shifted so some collide with existing days
          const batchDays = itinerary.days.slice(0, batchSize).map((d) => ({ ...d, title: "batch" }));
          const batch: Itinerary = {
            title: "Batch",
            totalCost: 0,
            days: batchDays,
            costUnit: "inr",
          };
          const merged = mergeBatch(prior, batch, { verifiedDays: respVerifiedRaw, withheldDays: respWithheldRaw }, n);

          // days ascending and unique
          const nums = merged.days.map((d) => d.day);
          expect(nums).toEqual([...new Set(nums)].sort((a, b) => a - b));

          // every existing day object kept unchanged (same reference)
          for (const d of prior?.days ?? []) expect(merged.days.find((m) => m.day === d.day)).toBe(d);

          // totalCost is the sum of day totals
          expect(merged.totalCost).toBe(merged.days.reduce((s, d) => s + d.total, 0));

          // partition
          const c = merged.completeness!;
          expectPartition(c, n);
          expect(c.verifiedDays).toEqual(nums);

          // settlePending
          const settled = settlePending(merged);
          const sc = settled.completeness!;
          expect(sc.pendingDays ?? []).toEqual([]);
          expect(sc.verifiedDays).toEqual(c.verifiedDays);
          expect(sc.withheldDays).toEqual([...c.withheldDays, ...(c.pendingDays ?? [])].sort((a, b) => a - b));
          expectPartition({ ...sc, pendingDays: [] }, n);
          expect(settlePending(settled)).toBe(settled);
          expect(settlePending(settled).completeness).toEqual(sc);
          if ((c.pendingDays ?? []).length === 0) expect(settled).toBe(merged);

          // verifiedLabel
          expect(verifiedLabel(c)).toBe(`${c.verifiedDays.length} of ${n} days verified`);

          // buildTimeline covers every day exactly once, in order
          const slots = buildTimeline(merged, new Set());
          const covered: number[] = [];
          for (const s of slots) {
            if (s.kind === "day") covered.push(s.day.day);
            else covered.push(...range(s.from, s.to));
          }
          expect(covered).toEqual(range(1, n));
          const shownDays = slots.filter((s) => s.kind === "day").map((s) => (s.kind === "day" ? s.day.day : 0));
          expect(shownDays).toEqual(nums);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: trustworthy-itinerary, Property 17: Completeness merge and partition
  it("Property 17: sequential batches from initialCompleteness always partition 1..N", () => {
    // **Validates: Requirements 5.7, 5.8, 6.12, 6.13, 6.14, 8.1, 8.6, 10.9, 12.2**
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 14 }),
        fc.array(fc.boolean(), { minLength: 14, maxLength: 14 }),
        (n, okFlags) => {
          expectPartition(initialCompleteness(n), n);
          let acc: Itinerary | null = null;
          const doneDays: number[] = [];
          for (let from = 1; from <= n; from += 3) {
            const to = Math.min(n, from + 2);
            const verified = range(from, to).filter((d) => okFlags[d - 1]);
            const withheld = range(from, to).filter((d) => !okFlags[d - 1]);
            const days = verified.map((d) => ({
              day: d, date: "", title: `d${d}`, theme: "", total: d * 10,
              activities: [{ time: "09:00", title: `a${d}`, description: "", cost: d * 10 }],
            }));
            acc = mergeBatch(
              acc,
              { title: "T", totalCost: 0, days, costUnit: "inr", completeness: initialCompleteness(n) },
              { verifiedDays: verified, withheldDays: withheld },
              n,
            );
            doneDays.push(...range(from, to));
            const c = acc.completeness!;
            expectPartition(c, n);
            // days beyond the processed batches are still pending
            expect(c.pendingDays).toEqual(range(to + 1, n));
          }
          const c = acc!.completeness!;
          expect(c.pendingDays).toEqual([]);
          expect(isComplete(acc!)).toBe(c.withheldDays.length === 0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // Property 26
  // -------------------------------------------------------------------------

  // Feature: trustworthy-itinerary, Property 26: Partial itineraries are never saved or priced as complete
  it("Property 26: isComplete holds exactly when nothing is withheld or pending", () => {
    // **Validates: Requirements 5.7, 5.8, 6.12, 6.13, 6.14, 8.1, 8.6, 10.9, 12.2**
    fc.assert(
      fc.property(tripArb, ({ itinerary }) => {
        const c = itinerary.completeness!;
        const expected = c.withheldDays.length === 0 && (c.pendingDays ?? []).length === 0;
        expect(isComplete(itinerary)).toBe(expected);
        // a settled partial itinerary is still not complete when it has withheld days
        const settled = settlePending(itinerary);
        expect(isComplete(settled)).toBe(settled.completeness!.withheldDays.length === 0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: trustworthy-itinerary, Property 26: Partial itineraries are never saved or priced as complete
  it("Property 26: activities amount is the party total over verified days; stay and transport ignore withheld count", () => {
    // **Validates: Requirements 5.7, 5.8, 6.12, 6.13, 6.14, 8.1, 8.6, 10.9, 12.2**
    fc.assert(
      fc.property(
        tripArb,
        fc.integer({ min: 1, max: 9 }),
        fc.integer({ min: 0, max: 200_000 }),
        fc.integer({ min: 0, max: 80_000 }),
        fc.boolean(),
        (trip, travellers, stayInr, flightPerPerson, noFlight) => {
          const { n, itinerary } = trip;
          const vehicles = Math.ceil(travellers / 4);
          const expectedActivities = itinerary.days.reduce(
            (s, d) =>
              s + d.activities.reduce((t, a) => t + a.cost * (a.costBasis === "group" ? vehicles : travellers), 0),
            0,
          );
          const input = { itinerary, stayInr, flightPerPerson, travellers, noFlight };
          const summary = computeSummary(input);
          expect(summary.activities).toBe(expectedActivities);
          expect(summary.stay).toBe(stayInr);
          expect(summary.flight).toBe(noFlight ? 0 : flightPerPerson * travellers);

          // the same verified days with a different withheld/pending split price identically
          const verified = itinerary.completeness!.verifiedDays;
          const rest = range(1, n).filter((d) => !verified.includes(d));
          const variants: ItineraryCompleteness[] = [
            { requestedDays: n, verifiedDays: verified, withheldDays: rest, pendingDays: [] },
            { requestedDays: n, verifiedDays: verified, withheldDays: [], pendingDays: rest },
          ];
          for (const completeness of variants) {
            const other = computeSummary({ ...input, itinerary: { ...itinerary, completeness } });
            expect(other).toEqual(summary);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: trustworthy-itinerary, Property 26: Partial itineraries are never saved or priced as complete
  it("Property 26: a batch's Pricer request holds only that batch's activities, at most MAX_ACTIVITIES", () => {
    // **Validates: Requirements 5.7, 5.8, 6.12, 6.13, 6.14, 8.1, 8.6, 10.9, 12.2**
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 3 }),
        fc.array(fc.array(activityArb, { minLength: 1, maxLength: 8 }), { minLength: 15, maxLength: 15 }),
        (batchIndex, batchLen, perDay) => {
          const mk = (d: number): TripDay => ({
            day: d, date: "", title: `d${d}`, theme: "", activities: perDay[d - 1],
            total: perDay[d - 1].reduce((s, a) => s + a.cost, 0),
          });
          const from = (batchIndex - 1) * 3 + 1;
          const batchDayNos = range(from, Math.min(14, from + batchLen - 1));
          const batchDays = batchDayNos.map(mk);
          const batchIt: Itinerary = { title: "B", totalCost: 0, days: batchDays, costUnit: "inr" };
          const req = toPricerRequest("Bali", batchIt);

          const batchActivityCount = batchDays.reduce((s, d) => s + d.activities.length, 0);
          expect(req.activities.length).toBe(batchActivityCount);
          expect(req.activities.length).toBeLessThanOrEqual(MAX_ACTIVITIES);
          for (const a of req.activities) {
            const m = /^d(\d+)-/.exec(a.id);
            expect(m).not.toBeNull();
            expect(batchDayNos).toContain(Number(m![1]));
          }

          // merging more days in does not change what the batch request contains
          const all = mergeBatch(
            null,
            { title: "All", totalCost: 0, days: range(1, 14).map(mk) },
            { verifiedDays: range(1, 14), withheldDays: [] },
            14,
          );
          expect(all.days.length).toBe(14);
          const batchIds = new Set(req.activities.map((a) => a.id));
          const fullIds = new Set(toPricerRequest("Bali", all).activities.map((a) => a.id));
          for (const id of batchIds) expect(fullIds.has(id)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
