import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildCostBreakdown,
  FORBIDDEN_CERTAINTY_WORDS,
  type CostBreakdownInput,
} from "../lib/cost-breakdown";
import { filterItinerary, normalise, findRanges } from "../lib/itinerary/search";

const RUNS = { numRuns: 150 };

/* ------------------------------ cost arbitraries ------------------------------ */

const amount = fc.integer({ min: 0, max: 500_000 });
const optAmount = fc.option(amount, { nil: null });

const costInput: fc.Arbitrary<CostBreakdownInput> = fc.record({
  travellers: fc.integer({ min: 1, max: 12 }),
  travellersSource: fc.constantFrom("context" as const, "state" as const),
  rooms: fc.integer({ min: 1, max: 6 }),
  roomsDerived: fc.boolean(),
  nights: fc.integer({ min: 1, max: 30 }),
  hasFlights: fc.boolean(),
  flight: fc.option(
    fc.record({
      amountInr: optAmount,
      basis: fc.constantFrom("per-person" as const, "party-total" as const),
      source: fc.constantFrom("Amadeus", "Live flight search", ""),
    }),
    { nil: null },
  ),
  stay: fc.option(
    fc.record({ rateInr: optAmount, source: fc.constantFrom("Hotels API", "") }),
    { nil: null },
  ),
  activities: fc.record({
    amountInr: amount,
    webPricedCount: fc.integer({ min: 0, max: 10 }),
    unpricedStopCount: fc.integer({ min: 0, max: 10 }),
  }),
  routeFare: fc.option(
    fc.record({
      minInr: amount,
      maxInr: amount,
      mode: fc.constantFrom("road", "rail", "bus"),
      source: fc.constantFrom("Listed fare", ""),
      selected: fc.boolean(),
    }),
    { nil: null },
  ),
  misc: fc.option(
    fc.record({ sumInr: amount, source: fc.constantFrom("Web prices", "") }),
    { nil: null },
  ),
  discount: fc.option(
    fc.record({ code: fc.constantFrom("SAVE10", "WELCOME", ""), amountInr: amount }),
    { nil: null },
  ),
});

/** Independent model of the total. */
function modelTotal(i: CostBreakdownInput): number {
  let sum = 0;
  if (i.hasFlights && i.flight && i.flight.amountInr !== null) {
    sum += i.flight.basis === "per-person" ? i.flight.amountInr * i.travellers : i.flight.amountInr;
  }
  if (i.stay && i.stay.rateInr !== null) sum += i.stay.rateInr * i.nights * i.rooms;
  sum += i.activities.amountInr;
  if (i.routeFare && i.routeFare.selected) sum += i.routeFare.minInr;
  const disc = i.discount && i.discount.amountInr > 0 ? i.discount.amountInr : 0;
  return Math.max(0, Math.round(sum - disc));
}

describe("trip-costs-search: cost breakdown properties", () => {
  it("total = max(0, sum of included priced lines - discount)", () => {
    fc.assert(
      fc.property(costInput, (i) => {
        const b = buildCostBreakdown(i);
        const incl = b.lines
          .filter((l) => l.included && l.amountInr !== null)
          .reduce((s, l) => s + (l.amountInr as number), 0);
        const disc = b.lines.find((l) => l.key === "discount")?.amountInr ?? 0;
        expect(b.totalInr).toBe(Math.max(0, Math.round(incl - disc)));
        expect(b.totalInr).toBe(modelTotal(i));
        expect(b.totalInr).toBeGreaterThanOrEqual(0);
      }),
      RUNS,
    );
  });

  it("unpriced or excluded lines never contribute to the total", () => {
    fc.assert(
      fc.property(costInput, amount, amount, (i, a, b2) => {
        const base = buildCostBreakdown(i);
        // Unpriced lines are never included.
        for (const l of base.lines) if (l.amountInr === null) expect(l.included).toBe(false);
        // Changing misc, an unselected route fare, or an unpriced stay/flight changes nothing.
        const changed: CostBreakdownInput = {
          ...i,
          misc: i.misc ? { ...i.misc, sumInr: a } : { sumInr: a, source: "x" },
          routeFare:
            i.routeFare && !i.routeFare.selected
              ? { ...i.routeFare, minInr: b2, maxInr: b2 + 1 }
              : i.routeFare,
          stay: i.stay && i.stay.rateInr === null ? { ...i.stay } : i.stay,
        };
        expect(buildCostBreakdown(changed).totalInr).toBe(base.totalInr);
        const misc = base.lines.find((l) => l.key === "misc");
        if (misc) expect(misc.included).toBe(false);
      }),
      RUNS,
    );
  });

  it("stay = rate x nights x rooms; null rate is unpriced", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 1, max: 8 }),
        (rate, nights, rooms) => {
          const mk = (r: number | null) =>
            buildCostBreakdown({
              travellers: 2,
              travellersSource: "state",
              rooms,
              roomsDerived: false,
              nights,
              hasFlights: false,
              flight: null,
              stay: { rateInr: r, source: "Hotels API" },
              activities: { amountInr: 0, webPricedCount: 0, unpricedStopCount: 0 },
              routeFare: null,
              misc: null,
              discount: null,
            });
          const stay = mk(rate).lines.find((l) => l.key === "stay")!;
          expect(stay.amountInr).toBe(rate * nights * rooms);
          expect(stay.included).toBe(true);
          expect(mk(rate).totalInr).toBe(rate * nights * rooms);
          const none = mk(null).lines.find((l) => l.key === "stay")!;
          expect(none.amountInr).toBeNull();
          expect(none.included).toBe(false);
          expect(mk(null).totalInr).toBe(0);
        },
      ),
      RUNS,
    );
  });

  // NOTE: the rooms derivation (ceil(travellers / 2), minimum 1) lives in planner.tsx and has no
  // exported pure helper, so it is asserted through buildCostBreakdown: given rooms derived by the
  // rule, the breakdown states the assumption text and the stay amount uses that room count.
  it("rooms default ceil(travellers / 2) is stated and used for the stay amount", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 1, max: 14 }),
        (travellers, rate, nights) => {
          const rooms = Math.max(1, Math.ceil(travellers / 2));
          const b = buildCostBreakdown({
            travellers,
            travellersSource: "context",
            rooms,
            roomsDerived: true,
            nights,
            hasFlights: false,
            flight: null,
            stay: { rateInr: rate, source: "Hotels API" },
            activities: { amountInr: 0, webPricedCount: 0, unpricedStopCount: 0 },
            routeFare: null,
            misc: null,
            discount: null,
          });
          expect(b.roomsAssumption).toBe("rooms = ceil(travellers / 2)");
          expect(b.lines.find((l) => l.key === "stay")!.amountInr).toBe(rate * nights * rooms);
          expect(b.lines.find((l) => l.key === "stay")!.formula).toContain(`${rooms} room`);
          const explicit = buildCostBreakdown({
            travellers,
            travellersSource: "context",
            rooms,
            roomsDerived: false,
            nights,
            hasFlights: false,
            flight: null,
            stay: null,
            activities: { amountInr: 0, webPricedCount: 0, unpricedStopCount: 0 },
            routeFare: null,
            misc: null,
            discount: null,
          });
          expect(explicit.roomsAssumption).toBeNull();
        },
      ),
      RUNS,
    );
  });

  it("selected road/rail fare is included at minInr with the lowest-fare text", () => {
    fc.assert(
      fc.property(amount, amount, (min, extra) => {
        const b = buildCostBreakdown({
          travellers: 2,
          travellersSource: "state",
          rooms: 1,
          roomsDerived: false,
          nights: 1,
          hasFlights: false,
          flight: null,
          stay: null,
          activities: { amountInr: 0, webPricedCount: 0, unpricedStopCount: 0 },
          routeFare: { minInr: min, maxInr: min + extra, mode: "rail", source: "Listed fare", selected: true },
          misc: null,
          discount: null,
        });
        const t = b.lines.find((l) => l.key === "transport")!;
        expect(t.included).toBe(true);
        expect(t.amountInr).toBe(min);
        expect(t.formula).toMatch(/^from INR [\d,]+ \(lowest listed fare\)$/);
        expect(t.formula).toContain(`INR ${min.toLocaleString("en-IN")}`);
        expect(b.totalInr).toBe(min);
      }),
      RUNS,
    );
  });

  it("no certainty words in any label, formula, note or total label", () => {
    fc.assert(
      fc.property(costInput, (i) => {
        const b = buildCostBreakdown(i);
        const texts = [b.totalLabel, b.travellersLine, b.roomsAssumption ?? ""];
        for (const l of b.lines) texts.push(l.label, l.formula, l.note ?? "");
        for (const t of texts) {
          for (const w of FORBIDDEN_CERTAINTY_WORDS) {
            expect(t.toLowerCase()).not.toContain(w.toLowerCase());
          }
        }
      }),
      RUNS,
    );
  });
});

/* ------------------------------ search arbitraries ------------------------------ */

const WORDS = [
  "Café", "cafe", "Zürich", "museum", "Temple", "São", "naïve", "beach", "Fort", "market",
  "sunrise", "Éclair", "hotel", "garden", "lake",
];
const text = fc
  .array(fc.constantFrom(...WORDS), { minLength: 0, maxLength: 4 })
  .map((w) => w.join(" "));
const optText = fc.option(text, { nil: undefined });

const activity = fc.record({
  time: fc.constant("09:00"),
  title: text,
  description: optText,
  area: optText,
  category: optText,
  placeName: optText,
  openingHours: optText,
  costNote: optText,
});

const itinerary = fc
  .array(
    fc.record({
      title: text,
      theme: optText,
      date: fc.constantFrom("2025-01-02", "Jan 3", "2025-03-04"),
      activities: fc.array(activity, { minLength: 0, maxLength: 4 }),
    }),
    { minLength: 0, maxLength: 5 },
  )
  .map((days) => ({
    title: "Trip",
    totalCost: 0,
    days: days.map((d, i) => ({ ...d, day: i + 1 })),
  })) as unknown as fc.Arbitrary<any>;

const query = fc
  .array(fc.constantFrom(...WORDS, "cafe", "CAFÉ", "ca", "mus", "ZURICH", "2025"), { minLength: 1, maxLength: 2 })
  .map((w) => w.join(" "))
  .filter((q) => normalise(q).length > 0);

const blank = fc.array(fc.constantFrom(" ", "\t", "\n", "  "), { maxLength: 4 }).map((a) => a.join(""));

const BODY = ["title", "description", "area", "category", "placeName"] as const;
const DETAIL = ["openingHours", "costNote"] as const;
const has = (s: unknown, q: string) => typeof s === "string" && normalise(s).includes(q);

describe("trip-costs-search: itinerary search properties", () => {
  it("empty or whitespace query shows all days and stops", () => {
    fc.assert(
      fc.property(itinerary, blank, (it, q) => {
        const r = filterItinerary(it, q);
        expect(r.active).toBe(false);
        expect(r.count).toBe(0);
        for (const d of it.days) {
          expect(r.visibleDays.has(String(d.day))).toBe(true);
          expect(r.visibleStops.get(String(d.day))!.size).toBe(d.activities.length);
        }
      }),
      RUNS,
    );
  });

  it("every shown stop matches or its day title matches; shown days have title or matching stop", () => {
    fc.assert(
      fc.property(itinerary, query, (it, raw) => {
        const q = normalise(raw);
        const r = filterItinerary(it, raw);
        expect(r.active).toBe(true);
        for (const d of it.days) {
          const id = String(d.day);
          const titleHit = has(d.title, q);
          const shownStops = r.visibleStops.get(id) ?? new Set<string>();
          let anyMatchingStop = false;
          d.activities.forEach((a: any, idx: number) => {
            const sid = `${d.day}-${idx}`;
            const matches = [...BODY, ...DETAIL].some((f) => has(a[f], q));
            if (matches) anyMatchingStop = true;
            if (shownStops.has(sid)) expect(matches || titleHit).toBe(true);
            if (matches) expect(shownStops.has(sid)).toBe(true);
          });
          if (r.visibleDays.has(id)) expect(titleHit || anyMatchingStop).toBe(true);
          else expect(titleHit || anyMatchingStop).toBe(false);
        }
      }),
      RUNS,
    );
  });

  it("is case- and accent-insensitive", () => {
    const strip = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "");
    const sig = (r: ReturnType<typeof filterItinerary>) =>
      JSON.stringify([
        r.count,
        [...r.visibleDays].sort(),
        [...r.visibleStops.entries()].map(([k, v]) => [k, [...v].sort()]).sort(),
      ]);
    fc.assert(
      fc.property(itinerary, query, (it, q) => {
        const base = sig(filterItinerary(it, q));
        expect(sig(filterItinerary(it, q.toUpperCase()))).toBe(base);
        expect(sig(filterItinerary(it, q.toLowerCase()))).toBe(base);
        if (normalise(strip(q)).length > 0) expect(sig(filterItinerary(it, strip(q)))).toBe(base);
      }),
      RUNS,
    );
    const it1: any = {
      title: "t",
      totalCost: 0,
      days: [{ day: 1, date: "d", title: "Day", activities: [{ time: "9", title: "Morning Café" }] }],
    };
    for (const q of ["Café", "cafe", "CAFE", "café", "CAFÉ"]) {
      expect(filterItinerary(it1, q).visibleStops.get("1")!.has("1-0")).toBe(true);
    }
    expect(normalise("  CAFÉ   Zürich ")).toBe("cafe zurich");
  });

  it("count = matching stops + days whose own fields match", () => {
    fc.assert(
      fc.property(itinerary, query, (it, raw) => {
        const q = normalise(raw);
        let expected = 0;
        for (const d of it.days) {
          if (has(d.title, q) || has(d.theme, q) || has(d.date, q)) expected += 1;
          for (const a of d.activities) {
            if ([...BODY, ...DETAIL].some((f) => has((a as any)[f], q))) expected += 1;
          }
        }
        expect(filterItinerary(it, raw).count).toBe(expected);
      }),
      RUNS,
    );
  });

  it("findRanges are in bounds, ordered, non-overlapping and match the query", () => {
    fc.assert(
      fc.property(text, query, (t, raw) => {
        const q = normalise(raw);
        const ranges = findRanges(t, raw);
        let prevEnd = 0;
        for (const [s, e] of ranges) {
          expect(s).toBeGreaterThanOrEqual(prevEnd);
          expect(e).toBeGreaterThan(s);
          expect(e).toBeLessThanOrEqual(t.length);
          prevEnd = e;
          expect(normalise(t.slice(s, e))).toBe(q);
        }
        if (normalise(t).includes(q)) expect(ranges.length).toBeGreaterThan(0);
      }),
      RUNS,
    );
  });
});

/* ------------------------------ CSS ------------------------------ */

describe("trip-costs-search: CSS block", () => {
  const css = readFileSync(resolve(__dirname, "../app/globals.css"), "utf8");
  const mark = css.indexOf("trip-costs-search");
  const compactMark = css.indexOf("summary-compact");
  const block = css.slice(mark);

  it("block follows the summary-compact marker", () => {
    expect(compactMark).toBeGreaterThanOrEqual(0);
    expect(mark).toBeGreaterThan(compactMark);
  });

  it("compact xp panel is a row without min-height; xp-bar is 6px", () => {
    const panel = /\.planner-xp-strip\s+\.xp-panel--compact\s*\{([^}]*)\}/.exec(block);
    expect(panel).not.toBeNull();
    expect(panel![1]).toMatch(/flex-direction:\s*row/);
    expect(panel![1]).not.toMatch(/min-height/);
    const bar = /\.xp-bar\s*\{([^}]*)\}/.exec(block);
    expect(bar).not.toBeNull();
    expect(bar![1]).toMatch(/height:\s*6px/);
  });
});
