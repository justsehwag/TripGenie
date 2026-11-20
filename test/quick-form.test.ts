// Feature: trip-planning-v2 — Quick_Form pure logic (lib/quick-form.ts).
// One describe block per correctness property; later tasks append more blocks.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { TripContext } from "@/lib/types";
import {
  BUDGET_LEVELS,
  VIBE_CHIPS,
  canGenerate,
  contextToQuickForm,
  durationDaysFor,
  missingRequired,
  validateQuickForm,
  normalizePlace,
  quickFormToWrite,
  samePlace,
  type QuickFormValues,
} from "@/lib/quick-form";
import {
  fromCriteria,
  toFlightsCriteria,
  toStaysCriteria,
  type DateHints,
} from "@/lib/trip-context-map";

const NUM_RUNS = 100;
const TODAY = "2030-01-01";
const BASE_MS = Date.UTC(2030, 0, 1);

function isoFromOffset(days: number): string {
  return new Date(BASE_MS + days * 86_400_000).toISOString().slice(0, 10);
}

// Place text with messy whitespace and mixed case, never blank.
const placeArb = fc
  .array(fc.constantFrom("Paris", "new", "DELHI", "goa", "São", "Rio", "x", "Los", "Angeles"), {
    minLength: 1,
    maxLength: 3,
  })
  .chain((words) =>
    fc
      .array(fc.constantFrom(" ", "  ", "\t"), { minLength: words.length + 1, maxLength: words.length + 1 })
      .map((seps) => seps[0] + words.map((w, i) => w + seps[i + 1]).join("")),
  );

// Valid Quick_Form values: all required fields present, dates real, depart >= today,
// return >= depart, origin != destination, travellers within limits.
const validValuesArb: fc.Arbitrary<QuickFormValues> = fc
  .record({
    origin: placeArb,
    destination: placeArb,
    depOffset: fc.integer({ min: 0, max: 400 }),
    span: fc.integer({ min: 0, max: 45 }),
    adults: fc.integer({ min: 1, max: 9 }),
    children: fc.integer({ min: 0, max: 8 }),
    budgetLevel: fc.constantFrom(...BUDGET_LEVELS, "" as const),
    vibes: fc.subarray([...VIBE_CHIPS]),
  })
  .filter((r) => !samePlace(r.origin, r.destination) && r.adults + r.children <= 9)
  .map((r) => ({
    origin: r.origin,
    destination: r.destination,
    departDate: isoFromOffset(r.depOffset),
    returnDate: isoFromOffset(r.depOffset + r.span),
    adults: r.adults,
    children: r.children,
    budgetLevel: r.budgetLevel,
    vibes: r.vibes,
  }));

describe("Feature: trip-planning-v2, Property 2: Quick form mapping round trip", () => {
  // **Validates: Requirements 2.4, 3.1, 3.3, 3.4, 4.2**
  it("quickFormToWrite -> contextToQuickForm preserves every field", () => {
    fc.assert(
      fc.property(validValuesArb, (v) => {
        expect(canGenerate(v, TODAY)).toBe(true);
        const w = quickFormToWrite(v);
        const back = contextToQuickForm(w.context as TripContext, w.dates);

        expect(back.origin).toBe(normalizePlace(v.origin));
        expect(back.destination).toBe(normalizePlace(v.destination));
        expect(back.departDate).toBe(v.departDate);
        expect(back.returnDate).toBe(v.returnDate);
        expect(back.adults).toBe(v.adults);
        expect(back.children).toBe(v.children);
        expect(back.budgetLevel).toBe(v.budgetLevel);
        expect(back.vibes).toEqual(v.vibes);
        expect(w.context.travellers).toEqual({ adults: v.adults, children: v.children });
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Feature: trip-planning-v2, Property 3: Quick form criteria equivalence", () => {
  // **Validates: Requirements 3.1, 3.3, 3.4, 3.5, 3.8, 4.2**
  it("flights/stays criteria equal those built from carryTripDatesToContext-style keys", () => {
    fc.assert(
      fc.property(validValuesArb, (v) => {
        const w = quickFormToWrite(v);

        // Independent reference: same values, carryTripDatesToContext keys.
        const refCtx: TripContext = {
          origin: normalizePlace(v.origin),
          destination: normalizePlace(v.destination),
          travellers: { adults: v.adults, children: v.children },
        };
        const refHints: DateHints = {
          checkIn: v.departDate,
          checkOut: v.returnDate,
          departDate: v.departDate,
          returnDate: v.returnDate,
        };

        const ctx = w.context as TripContext;
        expect(toFlightsCriteria(ctx, w.dates)).toEqual(toFlightsCriteria(refCtx, refHints));
        expect(toStaysCriteria(ctx, w.dates)).toEqual(toStaysCriteria(refCtx, refHints));

        const flights = toFlightsCriteria(ctx, w.dates);
        expect(flights.travellers).toBe(v.adults + v.children);
        const back = fromCriteria(flights);
        expect(back.origin).toBe(normalizePlace(v.origin));
        expect(back.destination).toBe(normalizePlace(v.destination));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Feature: trip-planning-v2, Property 4: Duration is the clamped inclusive day count", () => {
  // **Validates: Requirements 3.2**
  it("durationDaysFor equals min(30, max(1, daysBetween + 1))", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -400, max: 400 }),
        fc.integer({ min: 0, max: 120 }),
        (depOffset, span) => {
          const dep = isoFromOffset(depOffset);
          const ret = isoFromOffset(depOffset + span);
          expect(durationDaysFor(dep, ret)).toBe(Math.min(30, Math.max(1, span + 1)));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Feature: trip-planning-v2, Property 5: Quick form validation matches the rules", () => {
  // **Validates: Requirements 2.3, 2.5, 2.6, 2.7, 2.8**
  const poolPlace = fc.constantFrom("Paris", " paris ", "PARIS", "Goa", "goa  ", "Delhi", "New  York", "new york", "");
  const dateOrBlank = (offset: fc.Arbitrary<number>) =>
    fc.oneof({ weight: 6, arbitrary: offset.map(isoFromOffset) }, { weight: 1, arbitrary: fc.constant("") });

  const valuesArb: fc.Arbitrary<QuickFormValues> = fc.record({
    origin: poolPlace,
    destination: poolPlace,
    departDate: dateOrBlank(fc.integer({ min: -20, max: 20 })),
    returnDate: dateOrBlank(fc.integer({ min: -20, max: 20 })),
    adults: fc.integer({ min: -2, max: 12 }),
    children: fc.integer({ min: -2, max: 11 }),
    budgetLevel: fc.constantFrom(...BUDGET_LEVELS, "" as const),
    vibes: fc.subarray([...VIBE_CHIPS]),
  });

  const fold = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

  it("errors appear exactly when the rules are broken", () => {
    fc.assert(
      fc.property(valuesArb, fc.integer({ min: -10, max: 10 }), (v, todayOffset) => {
        const today = isoFromOffset(todayOffset);
        const errors = validateQuickForm(v, today);

        const bothDates = v.departDate !== "" && v.returnDate !== "";
        expect("returnDate" in errors).toBe(bothDates && v.returnDate < v.departDate);
        expect("departDate" in errors).toBe(v.departDate !== "" && v.departDate < today);
        expect("destination" in errors).toBe(fold(v.origin) !== "" && fold(v.origin) === fold(v.destination));
        expect("travellers" in errors).toBe(
          v.adults < 1 || v.adults > 9 || v.children < 0 || v.children > 8 || v.adults + v.children > 9,
        );
        // Blank required fields are never reported by validateQuickForm.
        expect("origin" in errors).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejects a travellers total above 9 even when each count is in range", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 9 }), fc.integer({ min: 1, max: 8 }), (adults, children) => {
        fc.pre(adults + children > 9);
        const v: QuickFormValues = {
          origin: "Delhi",
          destination: "Goa",
          departDate: isoFromOffset(1),
          returnDate: isoFromOffset(3),
          adults,
          children,
          budgetLevel: "",
          vibes: [],
        };
        expect(validateQuickForm(v, TODAY).travellers).toBeDefined();
        expect(canGenerate(v, TODAY)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("canGenerate is false when a required field is blank or any error exists, true otherwise", () => {
    fc.assert(
      fc.property(valuesArb, fc.integer({ min: -10, max: 10 }), (v, todayOffset) => {
        const today = isoFromOffset(todayOffset);
        const errors = validateQuickForm(v, today);
        const blanks = [v.origin, v.destination, v.departDate, v.returnDate].some((s) => s.trim() === "");

        expect(missingRequired(v).length > 0).toBe(blanks);
        const expected = !blanks && Object.keys(errors).length === 0;
        expect(canGenerate(v, today)).toBe(expected);
        if (blanks || Object.keys(errors).length > 0) expect(canGenerate(v, today)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("accepts a fully valid form", () => {
    fc.assert(
      fc.property(validValuesArb, (v) => {
        expect(validateQuickForm(v, TODAY)).toEqual({});
        expect(missingRequired(v)).toEqual([]);
        expect(canGenerate(v, TODAY)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Feature: trip-planning-v2, Property 6: Place normalisation is idempotent and trimmed", () => {
  // **Validates: Requirements 3.4**
  const messyArb = fc.array(fc.constantFrom("a", "Z", "é", "7", "-", " ", "  ", "\t", "\n", "\u00a0"), {
    maxLength: 20,
  }).map((parts) => parts.join(""));

  it("normalizePlace(normalizePlace(x)) equals normalizePlace(x)", () => {
    fc.assert(
      fc.property(fc.oneof(messyArb, fc.string(), placeArb), (x) => {
        const once = normalizePlace(x);
        expect(normalizePlace(once)).toBe(once);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("result has no leading/trailing whitespace and no runs of whitespace", () => {
    fc.assert(
      fc.property(fc.oneof(messyArb, fc.string(), placeArb), (x) => {
        const n = normalizePlace(x);
        expect(n).toBe(n.trim());
        expect(/\s{2,}/.test(n)).toBe(false);
        expect(/[\t\n\r]/.test(n)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("quickFormToWrite stores origin and destination in normalised form", () => {
    fc.assert(
      fc.property(validValuesArb, (v) => {
        const w = quickFormToWrite(v);
        expect(w.context.origin).toBe(normalizePlace(v.origin));
        expect(w.context.destination).toBe(normalizePlace(v.destination));
        expect(normalizePlace(w.context.origin as string)).toBe(w.context.origin);
        expect(normalizePlace(w.context.destination as string)).toBe(w.context.destination);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Feature: trip-planning-v2, Property 7: Quick form writes only chosen fields", () => {
  // **Validates: Requirements 3.7**
  it("never writes diet or pace, and omits budgetLevel/interests when unchosen", () => {
    fc.assert(
      fc.property(validValuesArb, (v) => {
        const { context } = quickFormToWrite(v);
        expect("diet" in context).toBe(false);
        expect("pace" in context).toBe(false);

        expect("budgetLevel" in context).toBe(v.budgetLevel !== "");
        if (v.budgetLevel !== "") expect(context.budgetLevel).toBe(v.budgetLevel);

        expect("interests" in context).toBe(v.vibes.length > 0);
        if (v.vibes.length > 0) expect(context.interests).toEqual(v.vibes);

        const allowed = new Set(["origin", "destination", "durationDays", "travellers", "budgetLevel", "interests"]);
        for (const k of Object.keys(context)) expect(allowed.has(k)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("writes dates under exactly checkIn, checkOut, departDate, returnDate", () => {
    fc.assert(
      fc.property(validValuesArb, (v) => {
        const { dates } = quickFormToWrite(v);
        expect(Object.keys(dates).sort()).toEqual(["checkIn", "checkOut", "departDate", "returnDate"]);
        expect(dates.checkIn).toBe(v.departDate);
        expect(dates.departDate).toBe(v.departDate);
        expect(dates.checkOut).toBe(v.returnDate);
        expect(dates.returnDate).toBe(v.returnDate);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
