// @vitest-environment node
// Feature: account-history-and-drafts, Property 4: Record round-trip and totality
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  fromSharedContext,
  toSharedContext,
  type CapturedPlan,
} from "@/lib/history/record-codec";
import type { Itinerary } from "@/lib/types";

/**
 * Property 4: Record round-trip and totality.
 *
 * (a) Round-trip: for any well-formed CapturedPlan,
 *     toSharedContext(fromSharedContext(plan)) deep-equals the NORMALIZED plan.
 *     fromSharedContext normalizes a missing/undefined itinerary to null, so we
 *     assert against { ...plan, itinerary: plan.itinerary ?? null }.
 *
 * (b) Totality: for arbitrary input (fc.anything(), including malformed /
 *     partial / non-object values), toSharedContext never throws and always
 *     returns a value whose context is an object, dates is an object, and
 *     itinerary is an object-or-null, falling back to the safe default
 *     { context: {}, dates: {}, itinerary: null } on non-object input.
 *
 * Node env, no DOM. One property, >=100 runs.
 *
 * Validates: Requirements 3.8, 4.6, 4.7, 5.6, 5.7
 */

const NUM_RUNS = { numRuns: 100 } as const;

/** True for a non-null, non-array plain object (matches the codec's own guard). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * JSON-safe plain object generator. Keeping values JSON-safe guarantees the
 * codec's by-reference pass-through round-trips to a deep-equal value.
 */
const jsonObjectArb: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  fc.string(),
  fc.oneof(
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.array(fc.oneof(fc.string(), fc.integer(), fc.boolean())),
  ),
);

/** A minimal, valid Itinerary-shaped object (plain-object so the codec keeps it). */
const itineraryArb: fc.Arbitrary<Itinerary> = fc.record({
  title: fc.string(),
  totalCost: fc.integer({ min: 0, max: 1_000_000 }),
  days: fc.constant([]),
});

/** A well-formed CapturedPlan: object context/dates, itinerary null or object. */
const capturedPlanArb: fc.Arbitrary<CapturedPlan> = fc.record({
  context: jsonObjectArb,
  dates: jsonObjectArb,
  itinerary: fc.option(itineraryArb, { nil: null }),
});

describe("Feature: account-history-and-drafts, record codec", () => {
  it("Property 4: round-trip equality for well-formed plans AND totality on arbitrary input", () => {
    // (a) Round-trip equality for every well-formed CapturedPlan.
    fc.assert(
      fc.property(capturedPlanArb, (plan) => {
        const normalized: CapturedPlan = {
          context: plan.context,
          dates: plan.dates,
          itinerary: plan.itinerary ?? null,
        };
        const roundTripped = toSharedContext(fromSharedContext(plan));
        expect(roundTripped).toEqual(normalized);
      }),
      NUM_RUNS,
    );

    // (b) Totality: toSharedContext never throws and always yields a
    //     well-shaped value on arbitrary (incl. malformed/non-object) input.
    fc.assert(
      fc.property(fc.anything(), (input) => {
        let result: CapturedPlan | undefined;
        expect(() => {
          result = toSharedContext(input);
        }).not.toThrow();

        const plan = result as CapturedPlan;
        expect(isPlainObject(plan.context)).toBe(true);
        expect(isPlainObject(plan.dates)).toBe(true);
        expect(plan.itinerary === null || isPlainObject(plan.itinerary)).toBe(true);

        // Non-object input must fall back to the exact safe default.
        if (!isPlainObject(input)) {
          expect(plan).toEqual({ context: {}, dates: {}, itinerary: null });
        }
      }),
      NUM_RUNS,
    );
  });
});
