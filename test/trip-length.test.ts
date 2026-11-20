import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { resolveTripLength } from "../lib/itinerary/trip-length";
import { dateSpanNotice } from "../lib/itinerary/labels";
import { durationFromText } from "../lib/date-intake";

const MAX = 14;
const DEFAULT = 4;
const DAY_MS = 86_400_000;

const iso = (offsetDays: number): string =>
  new Date(Date.UTC(2026, 0, 1) + offsetDays * DAY_MS).toISOString().slice(0, 10);

// Field text: clean phrases, junk, empty, and phrases with out-of-range counts.
const fieldArb: fc.Arbitrary<string> = fc.oneof(
  fc.integer({ min: 0, max: 99 }).map((n) => `${n} days`),
  fc.integer({ min: 0, max: 99 }).map((n) => `${n} nights`),
  fc
    .tuple(fc.integer({ min: 1, max: 30 }), fc.integer({ min: 1, max: 30 }))
    .map(([n, d]) => `${n} nights ${d} days`),
  fc.integer({ min: 1, max: 40 }).map((n) => `a ${n}-day trip`),
  fc.constantFrom("", "   ", "soon", "a long weekend", "next month", "weekend"),
  fc.string({ maxLength: 20 }),
);

// Context duration: absent, in range, out of range (low and high), fractional.
const contextArb: fc.Arbitrary<number | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.integer({ min: 1, max: MAX }),
  fc.integer({ min: -50, max: 0 }),
  fc.integer({ min: MAX + 1, max: 500 }),
  fc.double({ min: 0, max: 40, noNaN: true }),
);

type Dates = { startDate?: string; endDate?: string };
const datesArb: fc.Arbitrary<Dates> = fc.oneof(
  fc.constant<Dates>({}),
  fc.record({ startDate: fc.integer({ min: 0, max: 400 }).map(iso) }),
  fc.record({ endDate: fc.integer({ min: 0, max: 400 }).map(iso) }),
  // present, in order (span 1..40)
  fc
    .tuple(fc.integer({ min: 0, max: 400 }), fc.integer({ min: 0, max: 39 }))
    .map(([s, len]) => ({ startDate: iso(s), endDate: iso(s + len) })),
  // reversed (end strictly before start)
  fc
    .tuple(fc.integer({ min: 1, max: 400 }), fc.integer({ min: 1, max: 40 }))
    .map(([s, back]) => ({ startDate: iso(s), endDate: iso(s - back) })),
  // invalid strings
  fc.record({
    startDate: fc.constantFrom("2026-02-30", "not-a-date", "", "2026-13-01", "26-1-1"),
    endDate: fc.oneof(
      fc.constantFrom("2026-02-30", "garbage", "", "2026-00-10"),
      fc.integer({ min: 0, max: 400 }).map(iso),
    ),
  }),
  fc.record({
    startDate: fc.integer({ min: 0, max: 400 }).map(iso),
    endDate: fc.constantFrom("2026-02-30", "garbage", "", "2026-00-10"),
  }),
);

// Independent oracle for the inclusive date span; null when absent, invalid or reversed.
function spanOracle(s?: string, e?: string): number | null {
  if (typeof s !== "string" || typeof e !== "string") return null;
  const re = /^(\d{4})-(\d{2})-(\d{2})$/;
  const parse = (v: string): number | null => {
    const m = re.exec(v);
    if (!m) return null;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const t = Date.UTC(y, mo - 1, d);
    const b = new Date(t);
    return b.getUTCFullYear() === y && b.getUTCMonth() === mo - 1 && b.getUTCDate() === d ? t : null;
  };
  const a = parse(s);
  const b = parse(e);
  if (a === null || b === null) return null;
  const span = Math.round((b - a) / DAY_MS) + 1;
  return span >= 1 ? span : null;
}

function daysOracle(field: string, ctx: number | undefined): { days: number; capped: boolean } {
  const n = durationFromText(field);
  if (n !== null && n >= 1) return { days: Math.min(n, MAX), capped: n > MAX };
  const c = typeof ctx === "number" ? ctx : DEFAULT;
  return { days: Math.min(MAX, Math.max(1, Math.trunc(c))), capped: false };
}

describe("trip length", () => {
  // Feature: places-first-itinerary, Property 17: The "How long?" field decides the Trip_Length
  // **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.7**
  it("Property 17: the field decides days; cap, fallbacks, dates and notice behave", () => {
    fc.assert(
      fc.property(fieldArb, contextArb, datesArb, (field, contextDays, dates) => {
        const r = resolveTripLength({ field, contextDays, ...dates });
        const exp = daysOracle(field, contextDays);

        expect(r.days).toBe(exp.days);
        expect(r.capped).toBe(exp.capped);
        expect(r.days).toBeGreaterThanOrEqual(1);
        expect(r.days).toBeLessThanOrEqual(MAX);

        // The field wins whenever it states a count, whatever context and dates say.
        const n = durationFromText(field);
        if (n !== null && n >= 1) {
          expect(r.days).toBe(Math.min(n, MAX));
          expect(r.capped).toBe(n > MAX);
        } else {
          expect(r.capped).toBe(false);
        }

        // Dates never change days, capped, or the fallback.
        const without = resolveTripLength({ field, contextDays });
        expect(r.days).toBe(without.days);
        expect(r.capped).toBe(without.capped);
        expect(without.dateSpanDays).toBeNull();

        // Date span matches the independent oracle.
        const span = spanOracle(dates.startDate, dates.endDate);
        expect(r.dateSpanDays).toBe(span);

        // Notice contents.
        const notice = dateSpanNotice(r.dateSpanDays, r.days);
        if (span === null || span === r.days) {
          expect(notice).toBeNull();
        } else if (span < r.days) {
          expect(notice).toContain(`Your dates cover ${span} ${span === 1 ? "day" : "days"}.`);
          expect(notice).toContain(`Planning ${r.days} days`);
          expect(notice).toContain(`after day ${span}`);
          expect(notice).toContain("after your end date");
        } else {
          expect(notice).toBe(
            `Your dates cover ${span} days. Planning ${r.days} ${r.days === 1 ? "day" : "days"}.`,
          );
        }
      }),
      { numRuns: 300 },
    );
  });

  it("Property 17: context fallback and default of 4 when the field has no count", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("", "soon", "a long weekend", "0 days"),
        contextArb,
        datesArb,
        (field, contextDays, dates) => {
          const r = resolveTripLength({ field, contextDays, ...dates });
          const expected =
            typeof contextDays === "number"
              ? Math.min(MAX, Math.max(1, Math.trunc(contextDays)))
              : DEFAULT;
          expect(r.days).toBe(expected);
          expect(r.capped).toBe(false);
        },
      ),
      { numRuns: 150 },
    );
  });
});
