// Feature: account-history-and-drafts, Property 5: Draft-capture and planner-decision gating
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  plannerDecision,
  shouldGenerate,
  shouldCaptureDraft,
  type PlanSignal,
  type PlannerDecision,
} from "@/lib/history/draft-gating";

/**
 * Reference decision table, mirroring the documented precedence rules in
 * lib/history/draft-gating.ts (design section 4, R6.1-R6.6) exactly:
 *   1. "/itinerary" + stored itinerary            -> "show-stored"
 *   2. "/itinerary" + no stored + no userInitiated -> "empty-start"
 *   3. "/trip" + hasContextDestination + userInitiated -> "generate"
 *   4. "/trip" + NOT(hasContextDestination && userInitiated) -> "empty-start"
 *   5. userInitiated && !hasStoredItinerary        -> "generate"
 *   6. otherwise                                   -> "empty-start"
 */
function expectedDecision(s: PlanSignal): PlannerDecision {
  if (s.route === "/itinerary" && s.hasStoredItinerary) return "show-stored";
  if (s.route === "/itinerary" && !s.hasStoredItinerary && !s.userInitiated) return "empty-start";
  if (s.route === "/trip" && s.hasContextDestination && s.userInitiated) return "generate";
  if (s.route === "/trip" && !(s.hasContextDestination && s.userInitiated)) return "empty-start";
  if (s.userInitiated && !s.hasStoredItinerary) return "generate";
  return "empty-start";
}

const planSignal: fc.Arbitrary<PlanSignal> = fc.record({
  route: fc.oneof(
    fc.constant("/plan"),
    fc.constant("/trip"),
    fc.constant("/itinerary"),
    fc.string(),
  ),
  userInitiated: fc.boolean(),
  hasStoredItinerary: fc.boolean(),
  hasContextDestination: fc.boolean(),
});

describe("Feature: account-history-and-drafts, draft gating", () => {
  it("Property 5: Draft-capture and planner-decision gating", () => {
    fc.assert(
      fc.property(planSignal, (s) => {
        const decision = plannerDecision(s);

        // Global coupling invariants hold for every input.
        expect(shouldGenerate(s)).toBe(decision === "generate");
        expect(shouldCaptureDraft(s)).toBe(s.userInitiated);

        // No user-initiated plan and no stored itinerary => empty start, nothing happens.
        if (!s.userInitiated && !s.hasStoredItinerary) {
          expect(shouldCaptureDraft(s)).toBe(false);
          expect(shouldGenerate(s)).toBe(false);
          expect(decision).toBe("empty-start");
        }

        // A stored itinerary on /itinerary always wins: show-stored, never generate.
        if (s.route === "/itinerary" && s.hasStoredItinerary) {
          expect(decision).toBe("show-stored");
          expect(shouldGenerate(s)).toBe(false);
        }

        // User-initiated always captures a draft.
        if (s.userInitiated) {
          expect(shouldCaptureDraft(s)).toBe(true);
        }

        // The decision matches the documented table exactly for every input.
        expect(decision).toBe(expectedDecision(s));
      }),
      { numRuns: 200 },
    );
  });
});
