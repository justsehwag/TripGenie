import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_TRIP_DAYS } from "../lib/itinerary/constants";
import { endFromDays } from "../lib/itinerary/trip-dates";
import { formatShortDate, formatTripPreview, parseWhereTo } from "../lib/trip-preview";
import {
  DATE_CHIPS,
  decideGenerate,
  keepStoredDates,
  parseStartDateText,
  planStartDateWrite,
  resolveDateChip,
  shouldAskStartDate,
} from "../lib/start-date";

const RUNS = { numRuns: 100 };
const isoRe = /^\d{4}-\d{2}-\d{2}$/;

/** Valid ISO dates 2000-01-01 .. 2099-12-31. */
const isoDate = fc
  .integer({ min: Date.UTC(2000, 0, 1) / 86_400_000, max: Date.UTC(2099, 11, 31) / 86_400_000 })
  .map((d) => new Date(d * 86_400_000).toISOString().slice(0, 10));
const dayCount = fc.integer({ min: 1, max: MAX_TRIP_DAYS });
const word = fc.stringMatching(/^[A-Za-z]{2,10}$/).filter((w) => w.toLowerCase() !== "from");
const plural = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

describe("start-date-live-preview properties", () => {
  it("Property 1: Preview range and day count", () => {
    fc.assert(
      fc.property(isoDate, dayCount, (start, days) => {
        const p = formatTripPreview({ startDate: start, days });
        const end = endFromDays(start, days);
        expect(end).toBe(addDays(start, days - 1));
        expect(p.endDate).toBe(end);
        expect(p.dates).toContain(formatShortDate(start));
        expect(p.dates).toContain(formatShortDate(end));
        expect(p.dates).toContain(plural(days));
      }),
      RUNS,
    );
    // Over the cap shows MAX_TRIP_DAYS days.
    fc.assert(
      fc.property(isoDate, fc.integer({ min: MAX_TRIP_DAYS + 1, max: 500 }), (start, days) => {
        expect(formatTripPreview({ startDate: start, days }).dates).toContain(plural(MAX_TRIP_DAYS));
      }),
      RUNS,
    );
  });

  it("Property 2: Undated preview", () => {
    fc.assert(
      fc.property(dayCount, fc.constantFrom("", "nope", "2026-13-40", "12/12/2026"), (days, start) => {
        expect(formatTripPreview({ startDate: start, days }).dates).toBe(`${plural(days)} · dates not set`);
      }),
      RUNS,
    );
  });

  it("Property 3: Preview omits empty parts", () => {
    const maybe = <T,>(a: fc.Arbitrary<T>) => fc.option(a, { nil: undefined });
    fc.assert(
      fc.property(
        maybe(word),
        maybe(word),
        maybe(isoDate),
        maybe(dayCount),
        maybe(fc.integer({ min: 1, max: 12 })),
        maybe(word),
        (destination, origin, startDate, days, travellers, vibe) => {
          const p = formatTripPreview({ destination, origin, startDate, days, travellers, vibe });
          expect(p.text).not.toMatch(/^ ·|· $|· ·| ·$|^· /);
          expect(p.text.startsWith(" ")).toBe(false);
          expect(p.text.endsWith(" ")).toBe(false);
          if (destination) expect(p.text).toContain(destination);
          if (vibe) expect(p.text).toContain(vibe);
          if (travellers) expect(p.text).toContain(`${travellers} `);
          if (!destination) expect(p.place).toBe("");
          if (!travellers) expect(p.travellers).toBe("");
          if (!vibe) expect(p.vibe).toBe("");
          if (!startDate && days === undefined) expect(p.dates).toBe("");
          if (!destination && !startDate && days === undefined && !travellers && !vibe) {
            expect(p.text).toBe("");
          }
        },
      ),
      RUNS,
    );
  });

  it("Property 4: Where to parsing", () => {
    fc.assert(
      fc.property(word, word, (x, y) => {
        expect(parseWhereTo(`${x} from ${y}`)).toEqual({ destination: x, origin: y });
      }),
      RUNS,
    );
    fc.assert(
      fc.property(word, (x) => {
        expect(parseWhereTo(`  ${x}  `)).toEqual({ destination: x, origin: "" });
      }),
      RUNS,
    );
    fc.assert(
      fc.property(word, word, (x, y) => {
        const p = formatTripPreview({ where: `${x} from ${y}` });
        expect(p.place).toBe(`${x} from ${y}`);
      }),
      RUNS,
    );
  });

  it("Property 5: Date chips resolve to real future dates", () => {
    fc.assert(
      fc.property(isoDate, (today) => {
        for (const { id } of DATE_CHIPS) {
          const d = resolveDateChip(id, today);
          expect(d).toMatch(isoRe);
          expect(new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10)).toBe(d);
          expect(d >= today).toBe(true);
        }
        expect(new Date(`${resolveDateChip("this-weekend", today)}T00:00:00Z`).getUTCDay()).toBe(6);
        const wk = resolveDateChip("next-week", today);
        expect(new Date(`${wk}T00:00:00Z`).getUTCDay()).toBe(1);
        expect(wk > today).toBe(true);
        const nm = resolveDateChip("next-month", today);
        const [ty, tm] = today.split("-").map(Number);
        const [ny, nmo] = nm.split("-").map(Number);
        expect(ny * 12 + nmo).toBe(ty * 12 + tm + 1);
      }),
      RUNS,
    );
  });

  it("Property 6: Typed date parsing", () => {
    fc.assert(
      fc.property(isoDate, isoDate, (a, b) => {
        const [today, later] = a <= b ? [a, b] : [b, a];
        expect(parseStartDateText(later, today)).toBe(later);
        const r = parseStartDateText("12 Dec", today);
        expect(r).not.toBeNull();
        expect(r! >= today).toBe(true);
        expect(r).toMatch(isoRe);
        if (later > today) expect(parseStartDateText(today, later)).toBeNull();
      }),
      RUNS,
    );
    fc.assert(
      fc.property(isoDate, fc.stringMatching(/^[xyz ,.!?0-9]{0,20}$/).filter((s) => !/\d{4}-\d{2}-\d{2}/.test(s)), (today, text) => {
        expect(parseStartDateText(text, today)).toBeNull();
      }),
      RUNS,
    );
    expect(parseStartDateText("4 days", "2026-01-01")).toBeNull();
  });

  it("Property 7: Start date and day count drive the end date", () => {
    fc.assert(
      fc.property(isoDate, dayCount, (start, days) => {
        expect(planStartDateWrite(start, days)).toEqual({
          departDate: start,
          checkIn: start,
          returnDate: endFromDays(start, days),
          checkOut: endFromDays(start, days),
        });
      }),
      RUNS,
    );
    fc.assert(
      fc.property(fc.constantFrom("", "x", "2026-02-30", "2026-13-01"), dayCount, (bad, days) => {
        expect(planStartDateWrite(bad, days)).toBeNull();
      }),
      RUNS,
    );
    fc.assert(
      fc.property(isoDate, fc.constantFrom(undefined, null, 0, -3, Number.NaN), (start, days) => {
        const w = planStartDateWrite(start, days as number | null | undefined)!;
        expect(w.departDate).toBe(start);
        expect(w.checkIn).toBe(start);
        expect(w.returnDate).toBeUndefined();
        expect(w.checkOut).toBeUndefined();
      }),
      RUNS,
    );
  });

  it("Property 8: Generate is never blocked", () => {
    fc.assert(
      fc.property(
        fc.option(word, { nil: undefined }),
        fc.option(fc.oneof(isoDate, fc.constant(""), fc.constant("junk")), { nil: undefined }),
        (destination, startDate) => {
          const r = decideGenerate({ destination, startDate });
          expect(r.proceed).toBe(Boolean(destination));
          const valid = typeof startDate === "string" && isoRe.test(startDate);
          expect(r.dated).toBe(valid);
        },
      ),
      RUNS,
    );
    const src = readFileSync(join(__dirname, "..", "components", "planner.tsx"), "utf8");
    expect(src).not.toContain("startDateAskedRef");
    expect(src).not.toContain("What date do you start");
  });

  it("Property 9: Chat asks once", () => {
    const s = fc.option(fc.oneof(word, fc.constant(""), fc.constant("  ")), { nil: undefined });
    fc.assert(
      fc.property(s, s, fc.option(fc.oneof(isoDate, fc.constant("")), { nil: undefined }), fc.boolean(), fc.boolean(), (origin, destination, departDate, dismissed, asked) => {
        const has = (v?: string) => !!v && v.trim() !== "";
        const expected = has(origin) && has(destination) && !has(departDate) && !dismissed && !asked;
        expect(shouldAskStartDate({ origin, destination, departDate, dismissed, asked })).toBe(expected);
      }),
      RUNS,
    );
  });

  it("Property 10: Stored dates rule", () => {
    fc.assert(
      fc.property(
        fc.option(fc.boolean(), { nil: undefined }),
        fc.boolean(),
        fc.option(fc.oneof(isoDate, fc.constant("bad")), { nil: undefined }),
        isoDate,
        (userInitiated, hasItinerary, departDate, today) => {
          const expected =
            userInitiated === true ||
            hasItinerary ||
            (departDate !== undefined && isoRe.test(departDate) && departDate >= today);
          expect(keepStoredDates({ userInitiated, hasItinerary, departDate, today })).toBe(expected);
        },
      ),
      RUNS,
    );
  });
});
