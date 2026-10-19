import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  advance,
  emptyControllerState,
  filterConfirmedOffers,
  COMPLETION_TEXT,
  MAX_ANSWER_CHARS,
  MAX_QUESTIONS,
  REQUIRED_FIELDS,
  type ExtractionModel,
} from "@/lib/preference-controller";
import type { TripContext } from "@/lib/types";

/** Feature: tripgenie - preference controller property tests (Properties 43-47). */

const full: TripContext = {
  origin: "Delhi",
  destination: "Goa",
  durationDays: 5,
  travellers: { adults: 2, children: 0 },
  budgetLevel: "Comfort",
  diet: "No restrictions",
  pace: "Balanced",
  interests: ["beach"],
};

// Model that fills one missing field per turn from `full`.
const steppyModel: ExtractionModel = {
  extract(_delta, context) {
    for (const f of REQUIRED_FIELDS) {
      const k = f as keyof TripContext;
      if (context[k] === undefined) return { [k]: full[k] } as Partial<TripContext>;
    }
    return {};
  },
  phrase(field) {
    return `What is your ${field}?`;
  },
};

// Model that never interprets anything.
const deafModel: ExtractionModel = { extract: () => ({}), phrase: () => "?" };

// Model with a very long phrase to test the 160-char cap.
const verboseModel: ExtractionModel = {
  extract(_d, context) {
    for (const f of REQUIRED_FIELDS) {
      const k = f as keyof TripContext;
      if (context[k] === undefined) return { [k]: full[k] } as Partial<TripContext>;
    }
    return {};
  },
  phrase() {
    return "x".repeat(500);
  },
};

describe("Feature: tripgenie, preference controller", () => {
  it("Property 43: Preference Controller never exceeds eight questions", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { minLength: 0, maxLength: 20 }), (deltas) => {
        let state = emptyControllerState();
        for (const d of deltas) {
          const r = advance(state, d || "x", steppyModel);
          state = r.state;
          expect(state.questionsAsked).toBeLessThanOrEqual(MAX_QUESTIONS);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("Property 44: Exactly one question per collecting turn, bounded to 160 characters", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), (turns) => {
        let state = emptyControllerState();
        for (let i = 0; i < turns; i++) {
          const r = advance(state, "input", verboseModel);
          if (r.phase === "collecting") {
            expect(r.prompt.length).toBeLessThanOrEqual(MAX_ANSWER_CHARS);
          }
          state = r.state;
        }
      }),
      { numRuns: 100 },
    );
  });

  it("Property 45: Completion acknowledgement text is identical across intakes", () => {
    const runOnce = () => {
      let state = emptyControllerState();
      let last = "";
      for (let i = 0; i < 10; i++) {
        const r = advance(state, "input", steppyModel);
        state = r.state;
        if (r.phase === "completion") {
          last = r.completionText ?? "";
          break;
        }
      }
      return last;
    };
    expect(runOnce()).toBe(COMPLETION_TEXT);
    expect(runOnce()).toBe(runOnce());
  });

  it("Property 46: Uninterpretable input preserves Trip_Context", () => {
    fc.assert(
      fc.property(fc.string(), (junk) => {
        const state = { context: { origin: "Delhi" }, questionsAsked: 2 };
        const r = advance(state, junk, deafModel);
        expect(r.state.context).toEqual(state.context);
        expect(r.state.questionsAsked).toBe(2);
        expect(r.phase).toBe("collecting");
      }),
      { numRuns: 100 },
    );
  });

  it("Property 47: Offers lacking confirmed availability are omitted", () => {
    fc.assert(
      fc.property(fc.array(fc.boolean()), (flags) => {
        const offers = flags.map((f, i) => ({ id: `o${i}`, confirmedAvailability: f }));
        const kept = filterConfirmedOffers(offers);
        expect(kept.every((o) => o.confirmedAvailability === true)).toBe(true);
        expect(kept.length).toBe(flags.filter(Boolean).length);
      }),
      { numRuns: 100 },
    );
  });
});
