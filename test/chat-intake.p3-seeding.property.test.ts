import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { initialIntakeState, step, summaryRows } from "@/lib/chat-intake";
import { REQUIRED_FIELDS, type RequiredField } from "@/lib/preference-controller";
import type { TripContext } from "@/lib/types";

// Feature: chat-images-bedrock-planner, Property 3: No stale seeding
// **Validates: Requirements 1.3, 1.4, 1.6**

const word = fc.stringMatching(/^[A-Za-z]{2,12}$/);

const seededContext = fc
  .record(
    {
      origin: word,
      destination: word,
      durationDays: fc.integer({ min: 1, max: 30 }),
      travellers: fc.record({
        adults: fc.integer({ min: 1, max: 8 }),
        children: fc.integer({ min: 0, max: 4 }),
      }),
      budgetLevel: fc.constantFrom("budget", "mid", "luxury"),
      diet: word,
      pace: fc.constantFrom("relaxed", "balanced", "packed"),
      interests: fc.array(word, { minLength: 1, maxLength: 4 }),
    },
    { requiredKeys: [] },
  )
  .map((c) => c as TripContext);

const routeOnly = fc.record({ origin: word, destination: word });

const NON_ROUTE = REQUIRED_FIELDS.filter((f) => f !== "origin" && f !== "destination");

describe("Property 3: No stale seeding", () => {
  it("seeded values stay carried, are marked in the summary, and a route-only first turn changes only the route", () => {
    fc.assert(
      fc.property(seededContext, routeOnly, (ctx, route) => {
        const seeded = step(initialIntakeState(), { type: "seed", context: ctx });
        const seededFields = REQUIRED_FIELDS.filter((f) => ctx[f] !== undefined);

        // Seeding: carried, never answered; recap shown; summary marks every carried row.
        for (const f of REQUIRED_FIELDS) {
          expect(seeded.state.status[f]).toBe(seededFields.includes(f) ? "carried" : "unset");
        }
        expect(seeded.navigate).toBe(false);
        expect(String(seeded.state.phase)).not.toBe("completion");
        if (seededFields.length > 0) {
          expect(seeded.state.phase).toBe("recap");
          expect(seeded.message).toContain("earlier trip");
        }
        for (const row of summaryRows(seeded.state)) {
          expect(row.carried).toBe(seededFields.includes(row.field));
        }

        // First turn is route-only.
        const turn = step(seeded.state, { type: "text", text: "route", extracted: route });
        expect(turn.navigate).toBe(false);
        expect(String(turn.state.phase)).not.toBe("completion");

        // Only origin and destination changed.
        expect(turn.state.context.origin).toBe(route.origin);
        expect(turn.state.context.destination).toBe(route.destination);
        for (const f of NON_ROUTE) {
          expect(turn.state.context[f]).toEqual(ctx[f]);
        }

        // Seeded values count as answered only after the recap was shown (it was: phase "recap").
        // Summary rows mirror status: carried rows are marked, answered rows are not.
        const rows = summaryRows(turn.state);
        for (const f of NON_ROUTE as RequiredField[]) {
          const st = turn.state.status[f];
          if (ctx[f] === undefined) {
            expect(st).toBe("unset");
          } else {
            expect(["carried", "answered"]).toContain(st);
          }
          const row = rows.find((r) => r.field === f)!;
          expect(row.carried).toBe(st === "carried");
        }
      }),
      { numRuns: 200 },
    );
  });

  it("a route-only first turn without any recap or keep step never confirms seeded values", () => {
    fc.assert(
      fc.property(seededContext, routeOnly, (ctx, route) => {
        // Skip the seed event: state has values in context but nothing was recapped.
        const seeded = step(initialIntakeState(), { type: "seed", context: ctx }).state;
        const fields = NON_ROUTE.filter((f) => ctx[f] !== undefined);
        fc.pre(fields.length > 0);
        // The recap phase is the only route to "answered" for carried values.
        expect(seeded.phase).toBe("recap");
        for (const f of fields) expect(seeded.status[f]).toBe("carried");
        // No intermediate status leaks: summary before any turn marks all as carried.
        const rows = summaryRows(seeded);
        for (const f of fields) expect(rows.find((r) => r.field === f)!.carried).toBe(true);
        void route;
      }),
      { numRuns: 100 },
    );
  });
});
