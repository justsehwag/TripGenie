// Feature: realtime-ai-integration — Itinerary generation & day-edit isolation.
//
// Property-based coverage for the pure itinerary engine in
// `lib/itinerary-engine.ts` (spec tasks 11.3 and 11.4). Runs in the project's
// `node` vitest environment with `fast-check`; each property runs >= 100
// iterations. These tests are PURE / mocked — no live Bedrock, no network.
//
//   Property 7 (task 11.3, Req 2.8/8.1/8.2): the generated itinerary (or the
//     deterministic fallback) spans the CLAMPED captured duration, every day
//     has >= 1 activity, and each day's `total` equals the sum of that day's
//     activity `cost` values. The deterministic path (`buildItinerary`) is the
//     documented fallback used by `generateItineraryAsync` on any model
//     error/timeout, so we also exercise the AI-shaped path with a MOCKED
//     `invokeModel` that throws.
//
//   Property 8 (task 11.4, Req 8.3): `refineItinerary(itinerary, dayNumber,
//     budgetDelta)` leaves every OTHER day byte-identical, sets `totalCost` to
//     the sum of day totals, and marks the itinerary revised (`revised: true`).

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { TripContext, Itinerary } from "@/lib/types";
import { buildItinerary, refineItinerary } from "@/lib/itinerary-engine";
import { generateItineraryAsync, type BedrockModelDeps } from "@/lib/bedrock-model";

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

/** Mirror the engine's private `clampDays` (1..14, truncated). */
const clampDays = (n: number): number => Math.min(14, Math.max(1, Math.trunc(n)));

/** A deps object whose model always throws — forces the buildItinerary fallback. */
const depsThrowing = (): BedrockModelDeps => ({
  invokeModel: async () => {
    throw new Error("bedrock unavailable");
  },
});

/** Assert the three structural invariants of a generated itinerary. */
function assertSpansDuration(it: Itinerary, expectedDays: number): void {
  expect(it.days.length).toBe(expectedDays);
  for (const day of it.days) {
    // Each day has at least one activity.
    expect(day.activities.length).toBeGreaterThanOrEqual(1);
    // Each day's total equals the sum of its activity costs.
    const sum = day.activities.reduce((s, a) => s + a.cost, 0);
    expect(day.total).toBe(sum);
  }
  // Trip total equals the sum of day totals.
  expect(it.totalCost).toBe(it.days.reduce((s, d) => s + d.total, 0));
}

// ---------------------------------------------------------------------------
// Arbitraries — a COMPLETE TripContext. `durationDays` spans both below and
// above the 1..14 clamp so the clamp is genuinely exercised in both directions.
// ---------------------------------------------------------------------------

/** A non-empty, non-blank destination string. */
const destinationArb = fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0);

/** A duration spanning below the floor and above the ceiling of the clamp. */
const durationArb = fc.integer({ min: -3, max: 30 });

/** A complete TripContext with a non-empty interests array. */
const contextArb: fc.Arbitrary<TripContext> = fc.record({
  destination: destinationArb,
  durationDays: durationArb,
  travellers: fc.record({
    adults: fc.integer({ min: 1, max: 6 }),
    children: fc.integer({ min: 0, max: 4 }),
  }),
  budgetLevel: fc.constantFrom("budget", "mid", "luxury"),
  pace: fc.constantFrom("relaxed", "balanced", "packed"),
  interests: fc.array(fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0), {
    minLength: 1,
    maxLength: 5,
  }),
});

// ---------------------------------------------------------------------------
// Property 7 — itinerary spans the clamped captured duration with per-day
// estimates (deterministic path + mocked AI-shaped fallback path).
// ---------------------------------------------------------------------------

describe("Feature: realtime-ai-integration, Property 7 — itinerary spans the captured duration with per-day estimates", () => {
  it("buildItinerary (deterministic path) spans the clamped duration with valid per-day totals", () => {
    fc.assert(
      fc.property(contextArb, (ctx) => {
        const expectedDays = clampDays(ctx.durationDays as number);
        const it = buildItinerary({
          destination: ctx.destination as string,
          startDate: "2025-01-01",
          days: ctx.durationDays as number,
          vibes: ctx.interests,
        });
        assertSpansDuration(it, expectedDays);
      }),
      { numRuns: 200 },
    );
  });

  it("generateItineraryAsync (mocked model throws) falls back to a correctly-spanned itinerary", async () => {
    await fc.assert(
      fc.asyncProperty(contextArb, async (ctx) => {
        // The fallback uses `context.durationDays ?? 4`, then buildItinerary
        // clamps it. Our context always supplies durationDays.
        const expectedDays = clampDays(ctx.durationDays as number);
        const it = await generateItineraryAsync(depsThrowing(), ctx);
        assertSpansDuration(it, expectedDays);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 8 — day edit isolation. Build a base itinerary from an arbitrary
// context, pick an arbitrary day number (in and out of range) and budget
// delta, and assert only the targeted day changes.
// ---------------------------------------------------------------------------

describe("Feature: realtime-ai-integration, Property 8 — day edit isolation", () => {
  it("refineItinerary revises only the targeted day, recomputes totalCost, and marks revised", () => {
    fc.assert(
      fc.property(
        contextArb,
        // dayNumber ranges beyond the itinerary length to exercise no-op edits.
        fc.integer({ min: -2, max: 16 }),
        // budgetDelta spans negative (clamped to >= 0), zero, and positive.
        fc.integer({ min: -100000, max: 100000 }),
        (ctx, dayNumber, budgetDelta) => {
          const base = buildItinerary({
            destination: ctx.destination as string,
            startDate: "2025-01-01",
            days: ctx.durationDays as number,
            vibes: ctx.interests,
          });

          const revised = refineItinerary(base, dayNumber, budgetDelta);

          // Marks the itinerary revised.
          expect(revised.revised).toBe(true);

          // totalCost equals the sum of day totals.
          expect(revised.totalCost).toBe(revised.days.reduce((s, d) => s + d.total, 0));

          // Same number of days; same ordering.
          expect(revised.days.length).toBe(base.days.length);

          for (let i = 0; i < base.days.length; i++) {
            const before = base.days[i];
            const after = revised.days[i];
            if (before.day === dayNumber) {
              // Targeted day: total is the clamped (>= 0) adjusted value.
              expect(after.total).toBe(Math.max(0, before.total + Math.round(budgetDelta)));
              // Non-total fields are untouched (structurally identical).
              expect(after.day).toBe(before.day);
              expect(after.date).toBe(before.date);
              expect(after.title).toBe(before.title);
              expect(after.theme).toBe(before.theme);
              expect(after.activities).toEqual(before.activities);
            } else {
              // Every OTHER day is byte-identical (deep-equal, same reference).
              expect(after).toEqual(before);
              expect(after).toBe(before);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("refineItinerary with an out-of-range day leaves all day totals unchanged (only metadata changes)", () => {
    fc.assert(
      fc.property(contextArb, fc.integer({ min: -100000, max: 100000 }), (ctx, budgetDelta) => {
        const base = buildItinerary({
          destination: ctx.destination as string,
          startDate: "2025-01-01",
          days: ctx.durationDays as number,
          vibes: ctx.interests,
        });
        // Day number guaranteed out of range (base has 1..clampDays days).
        const outOfRange = base.days.length + 5;
        const revised = refineItinerary(base, outOfRange, budgetDelta);

        expect(revised.revised).toBe(true);
        expect(revised.totalCost).toBe(base.totalCost);
        for (let i = 0; i < base.days.length; i++) {
          expect(revised.days[i]).toBe(base.days[i]);
        }
      }),
      { numRuns: 100 },
    );
  });
});
