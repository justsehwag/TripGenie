// chat-dates-xp-fixes task 6.1: Properties 1-5 (exact trip dates and day count).
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTripDates, dayDate, endFromDays } from "@/lib/itinerary/trip-dates";
import { MAX_TRIP_DAYS } from "@/lib/itinerary/constants";

const RUNS = { numRuns: 150 };
const BASE = Date.UTC(2020, 0, 1);
const iso = (offsetDays: number) => new Date(BASE + offsetDays * 86_400_000).toISOString().slice(0, 10);
const startOffset = fc.integer({ min: 0, max: 3000 });

describe("Property 1: day count equals the date span", () => {
  it("days = min(MAX_TRIP_DAYS, span), regardless of a supplied days value; capped iff span exceeds the cap", () => {
    fc.assert(
      fc.property(
        startOffset,
        fc.integer({ min: 0, max: 60 }),
        fc.option(fc.integer({ min: 1, max: 40 }), { nil: undefined }),
        (s, extra, supplied) => {
          const span = extra + 1;
          const r = resolveTripDates({ startDate: iso(s), endDate: iso(s + extra), days: supplied });
          expect(r.source).toBe("dates");
          expect(r.days).toBe(Math.min(MAX_TRIP_DAYS, span));
          expect(r.capped).toBe(span > MAX_TRIP_DAYS);
          expect(r.needsStartDate).toBe(false);
        },
      ),
      RUNS,
    );
  });
});

describe("Property 2: chosen dates are never replaced", () => {
  it("resolveTripDates returns the start and end it was given (within the cap)", () => {
    fc.assert(
      fc.property(startOffset, fc.integer({ min: 0, max: MAX_TRIP_DAYS - 1 }), fc.integer({ min: 1, max: 30 }), (s, extra, days) => {
        const r = resolveTripDates({ startDate: iso(s), endDate: iso(s + extra), days });
        expect(r.startDate).toBe(iso(s));
        expect(r.endDate).toBe(iso(s + extra));
      }),
      RUNS,
    );
  });

  it("carryTripDatesToContext only fills empty date fields (source-level check; the closure is not exported)", () => {
    const src = readFileSync(join(__dirname, "..", "components", "planner.tsx"), "utf8");
    const start = src.indexOf("function carryTripDatesToContext");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("function syncReturnToDayCount", start);
    const body = src.slice(start, end > start ? end : start + 2500);
    for (const f of ["departDate", "returnDate", "checkIn", "checkOut"]) {
      expect(body, f).toMatch(new RegExp(`if \\(!has\\(cur\\.${f}\\)\\) next\\.${f} =`));
    }
  });
});

describe("Property 3: day dates follow the start date", () => {
  it("dayDate(start, n) = start + n - 1 days and endFromDays(start, N) = dayDate(start, N)", () => {
    fc.assert(
      fc.property(startOffset, fc.integer({ min: 1, max: MAX_TRIP_DAYS }), (s, n) => {
        expect(dayDate(iso(s), n)).toBe(iso(s + n - 1));
        expect(endFromDays(iso(s), n)).toBe(dayDate(iso(s), n));
      }),
      RUNS,
    );
  });
  it("returns an empty string for an invalid start", () => {
    expect(dayDate("nope", 3)).toBe("");
    expect(endFromDays("", 3)).toBe("");
  });
});

describe("Property 4: days without a start date need one", () => {
  it("needsStartDate is true, no calendar date is returned", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 60 }), (days) => {
        const r = resolveTripDates({ days });
        expect(r.needsStartDate).toBe(true);
        expect(r.startDate).toBeNull();
        expect(r.endDate).toBeNull();
        expect(r.days).toBe(Math.min(MAX_TRIP_DAYS, days));
      }),
      RUNS,
    );
  });
  it("a start date alone, or nothing, resolves to source none", () => {
    expect(resolveTripDates({ startDate: iso(5) }).source).toBe("none");
    expect(resolveTripDates({}).source).toBe("none");
  });
});

describe("Property 5: day count edits round-trip", () => {
  it("resolving { start, endFromDays(start, N) } returns days = N for N <= MAX_TRIP_DAYS", () => {
    fc.assert(
      fc.property(startOffset, fc.integer({ min: 1, max: MAX_TRIP_DAYS }), (s, n) => {
        const r = resolveTripDates({ startDate: iso(s), endDate: endFromDays(iso(s), n) });
        expect(r.days).toBe(n);
        expect(r.startDate).toBe(iso(s));
      }),
      RUNS,
    );
  });
});
