import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { IST, checkedLabel, dayOffset, istMonthKey, todayIst } from "@/lib/ist-time";

// Feature: live-travel-pricing, Property 10: IST time helpers are fixed and deterministic
// **Validates: Requirements 4.6, 9.2, 2.5, 8.6**

const MIN = 60_000;
const DAY = 86_400_000;
const IST_OFFSET_MS = 330 * MIN; // Asia/Kolkata is a fixed UTC+05:30 (no DST)

/** Independent oracle: Intl formatter in a different locale with Asia/Kolkata. */
const ORACLE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});
const ORACLE_MONTH_SHORT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Kolkata",
  month: "short",
});

function oracleParts(d: Date) {
  const parts: Record<string, string> = {};
  for (const p of ORACLE_FMT.formatToParts(d)) parts[p.type] = p.value;
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: String(Number(parts.hour)),
    minute: parts.minute,
    period: parts.dayPeriod.toLowerCase(),
    monthShort: ORACLE_MONTH_SHORT.format(d),
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Days in a month (1-12) of a year. */
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Instants within ±3h of an IST midnight (18:30 UTC), biased to month ends. */
const arbBoundaryInstant: fc.Arbitrary<Date> = fc
  .record({
    year: fc.integer({ min: 2000, max: 2099 }),
    month: fc.integer({ min: 1, max: 12 }),
    dayPick: fc.oneof(fc.constant("last" as const), fc.constant("first" as const), fc.integer({ min: 1, max: 28 })),
    offsetMin: fc.integer({ min: -180, max: 180 }),
    sec: fc.integer({ min: 0, max: 59 }),
  })
  .map(({ year, month, dayPick, offsetMin, sec }) => {
    const day = dayPick === "last" ? daysIn(year, month) : dayPick === "first" ? 1 : dayPick;
    // IST midnight at the start of (day + 1) == 18:30 UTC on `day`.
    const base = Date.UTC(year, month - 1, day, 18, 30, 0);
    return new Date(base + offsetMin * MIN + sec * 1000);
  });

/** Any instant in a broad range. */
const arbAnyInstant: fc.Arbitrary<Date> = fc
  .integer({ min: Date.UTC(1990, 0, 1), max: Date.UTC(2100, 0, 1) })
  .map((t) => new Date(t));

const arbInstant = fc.oneof(arbBoundaryInstant, arbAnyInstant);

describe("Property 10: IST time helpers are fixed and deterministic", () => {
  it("IST constant is Asia/Kolkata", () => {
    expect(IST).toBe("Asia/Kolkata");
  });

  it("todayIst / istMonthKey equal the Asia/Kolkata calendar date and month", () => {
    fc.assert(
      fc.property(arbInstant, (d) => {
        const o = oracleParts(d);
        // Second independent oracle: fixed +05:30 arithmetic.
        const shifted = new Date(d.getTime() + IST_OFFSET_MS);
        const arith = `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;

        expect(todayIst(d)).toBe(`${o.year}-${o.month}-${o.day}`);
        expect(todayIst(d)).toBe(arith);
        expect(istMonthKey(d)).toBe(`${o.year}-${o.month}`);
        expect(istMonthKey(d)).toBe(arith.slice(0, 7));
        // Deterministic across repeated calls.
        expect(todayIst(new Date(d.getTime()))).toBe(todayIst(d));
        expect(istMonthKey(new Date(d.getTime()))).toBe(istMonthKey(d));
      }),
      { numRuns: 200 },
    );
  });

  it("checkedLabel renders 'd MMM, h:mm am/pm IST' in Asia/Kolkata and is stable", () => {
    fc.assert(
      fc.property(arbInstant, (d) => {
        const iso = d.toISOString();
        const o = oracleParts(d);
        const expected = `${Number(o.day)} ${o.monthShort}, ${o.hour}:${o.minute} ${o.period} IST`;
        const label = checkedLabel(iso);
        // Normalise any ICU narrow/no-break spaces before comparing text.
        const norm = (s: string) => s.replace(/[\u202f\u00a0]/g, " ");
        expect(norm(label)).toBe(expected);
        expect(norm(label)).toMatch(/^\d{1,2} [A-Z][a-z]{2}, \d{1,2}:\d{2} (am|pm) IST$/);
        expect(checkedLabel(iso)).toBe(label);
      }),
      { numRuns: 200 },
    );
  });

  it("checkedLabel returns 'just now' for unparsable input", () => {
    expect(checkedLabel("not-a-date")).toBe("just now");
    expect(checkedLabel("")).toBe("just now");
  });

  it("dayOffset equals the whole-day difference between calendar dates", () => {
    const arbLocal = fc
      .record({
        t: fc.integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2099, 11, 31) }),
        hh: fc.integer({ min: 0, max: 23 }),
        mm: fc.integer({ min: 0, max: 59 }),
      })
      .map(({ t, hh, mm }) => {
        const d = new Date(t);
        const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
        return { date, epochDay: Math.floor(t / DAY), text: `${date} ${pad(hh)}:${pad(mm)}` };
      });

    // Pairs close together (typical flight arrival offsets) and arbitrary pairs.
    const arbPair = fc.oneof(
      fc.tuple(arbLocal, fc.integer({ min: -2, max: 3 }), fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 })).map(
        ([dep, delta, hh, mm]) => {
          const a = new Date((dep.epochDay + delta) * DAY);
          const date = `${a.getUTCFullYear()}-${pad(a.getUTCMonth() + 1)}-${pad(a.getUTCDate())}`;
          return { dep, arr: { date, epochDay: dep.epochDay + delta, text: `${date} ${pad(hh)}:${pad(mm)}` } };
        },
      ),
      fc.tuple(arbLocal, arbLocal).map(([dep, arr]) => ({ dep, arr })),
    );

    fc.assert(
      fc.property(arbPair, ({ dep, arr }) => {
        const expected = arr.epochDay - dep.epochDay;
        expect(dayOffset(dep.text, arr.text)).toBe(expected);
        expect(dayOffset(dep.text, arr.text)).toBe(dayOffset(dep.text, arr.text));
        expect(dayOffset(dep.text, dep.text)).toBe(0);
      }),
      { numRuns: 200 },
    );
  });

  it("dayOffset is 0 when a timestamp has no parsable date", () => {
    expect(dayOffset("garbage", "2026-01-02 10:00")).toBe(0);
    expect(dayOffset("2026-01-02 10:00", "")).toBe(0);
  });
});
