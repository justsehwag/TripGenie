/**
 * Draft gating + planner decision (pure core) - design section 4.
 * Encodes the no-phantom-auto-load bug fix (R6) and the draft-capture rule (R5)
 * as pure, framework-free, node-testable predicates. No window, no server-only
 * secret import.
 * Requirements: 5.1, 5.2, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 8.1.
 */

export interface PlanSignal {
  /** The planning surface being opened. */
  route: "/plan" | "/trip" | "/itinerary" | string;
  /** User submitted intake/form, or resumed a real record. */
  userInitiated: boolean;
  /** Shared_Trip_Context holds an itinerary with >= 1 day. */
  hasStoredItinerary: boolean;
  /** Shared_Trip_Context.context.destination is non-empty. */
  hasContextDestination: boolean;
}

/** The on-mount decision for a planning surface. */
export type PlannerDecision = "show-stored" | "generate" | "empty-start";

/**
 * The on-mount decision for a planning surface (design section 4, R6.1-R6.6).
 * Rules applied in strict precedence order:
 *   1. "/itinerary" with a stored itinerary -> "show-stored" (always wins; never generate).
 *   2. "/itinerary" with no stored itinerary and no userInitiated -> "empty-start".
 *   3. "/trip" with a context destination and userInitiated -> "generate".
 *   4. "/trip" with no user-initiated destination -> "empty-start".
 *   5. Any surface with userInitiated and no stored itinerary -> "generate".
 *   6. Otherwise -> "empty-start".
 */
export function plannerDecision(s: PlanSignal): PlannerDecision {
  // 1. A stored itinerary on /itinerary always wins.
  if (s.route === "/itinerary" && s.hasStoredItinerary) {
    return "show-stored";
  }

  // 2. /itinerary with no stored itinerary and no user-initiated plan.
  if (s.route === "/itinerary" && !s.hasStoredItinerary && !s.userInitiated) {
    return "empty-start";
  }

  // 3. /trip with a context destination started by the user.
  if (s.route === "/trip" && s.hasContextDestination && s.userInitiated) {
    return "generate";
  }

  // 4. /trip with no user-initiated destination.
  if (s.route === "/trip" && !(s.hasContextDestination && s.userInitiated)) {
    return "empty-start";
  }

  // 5. Any surface with a user-initiated start and no stored itinerary.
  if (s.userInitiated && !s.hasStoredItinerary) {
    return "generate";
  }

  // 6. Otherwise (empty /plan, etc.).
  return "empty-start";
}

/** Should the Planner generate on mount? (R6) */
export function shouldGenerate(s: PlanSignal): boolean {
  return plannerDecision(s) === "generate";
}

/**
 * Should a Draft be captured now? (R5.1/R5.2)
 * A plan becomes a Draft only when the user actively starts (or resumes) it.
 */
export function shouldCaptureDraft(s: PlanSignal): boolean {
  return s.userInitiated;
}
