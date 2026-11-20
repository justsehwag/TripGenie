import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { initialIntakeState, step, type ChatEvent, type ChatIntakeState } from "../lib/chat-intake";
import { REQUIRED_FIELDS, type RequiredField } from "../lib/preference-controller";
import type { TripContext } from "../lib/types";

// Feature: chat-images-bedrock-planner, Property 2: Chat never navigates before all required fields are answered or skipped
// **Validates: Requirements 2.5, 2.6, 2.7, 2.8**

const place = fc.oneof(
  fc.constantFrom("Mumbai", "Singapore", "Delhi", "Goa", "Paris"),
  fc.constant(""),
  fc.constant("   "),
);

const ctxArb: fc.Arbitrary<TripContext> = fc.record(
  {
    origin: place,
    destination: place,
    durationDays: fc.integer({ min: 1, max: 14 }),
    travellers: fc.record({ adults: fc.integer({ min: 1, max: 6 }), children: fc.integer({ min: 0, max: 3 }) }),
    budgetLevel: fc.constantFrom("budget", "mid", "luxury"),
    diet: fc.constantFrom("vegetarian", "vegan", "none"),
    pace: fc.constantFrom("relaxed", "balanced", "packed"),
    interests: fc.array(fc.constantFrom("food", "history", "beaches"), { minLength: 0, maxLength: 3 }),
  },
  { requiredKeys: [] },
) as fc.Arbitrary<TripContext>;

const fieldArb = fc.constantFrom<RequiredField>(...REQUIRED_FIELDS);

const eventArb: fc.Arbitrary<ChatEvent> = fc.oneof(
  fc.record({ type: fc.constant("text" as const), text: fc.string(), extracted: ctxArb }),
  fc.constant<ChatEvent>({ type: "skip" }),
  ctxArb.map<ChatEvent>((context) => ({ type: "seed", context })),
  fc.record({
    type: fc.constant("edit" as const),
    field: fieldArb,
    value: fc.oneof(fc.constant(undefined), place, fc.integer({ min: 1, max: 14 })),
  }) as fc.Arbitrary<ChatEvent>,
  fc.constant<ChatEvent>({ type: "keep-carried" }),
  fc.constant<ChatEvent>({ type: "generate" }),
  fc.constant<ChatEvent>({ type: "reset" }),
);

const isSet = (v: unknown) => typeof v === "string" && v.trim().length > 0;

describe("Property 2: chat navigation gate", () => {
  it("navigate is true only on generate, and only with origin and destination set", () => {
    fc.assert(
      fc.property(fc.array(eventArb, { minLength: 1, maxLength: 30 }), (events) => {
        let state: ChatIntakeState = initialIntakeState();
        for (const ev of events) {
          const before = state;
          const r = step(state, ev);
          if (ev.type !== "generate") {
            expect(r.navigate).toBe(false);
          } else {
            const ready = isSet(before.context.origin) && isSet(before.context.destination);
            expect(r.navigate).toBe(ready);
          }
          if (r.navigate) {
            expect(ev.type).toBe("generate");
            expect(isSet(r.state.context.origin)).toBe(true);
            expect(isSet(r.state.context.destination)).toBe(true);
          }
          state = r.state;
        }
      }),
      { numRuns: 200 },
    );
  });

  it("a fully carried seed never navigates until generate", () => {
    fc.assert(
      fc.property(ctxArb, (context) => {
        const r = step(initialIntakeState(), { type: "seed", context });
        expect(r.navigate).toBe(false);
        expect(step(r.state, { type: "keep-carried" }).navigate).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
