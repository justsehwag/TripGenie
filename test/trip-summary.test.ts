// @vitest-environment node
// Feature: trip-planning-v2, Property 20: No-flight pricing excludes the flight line
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { computeSummary } from "@/lib/trip-summary";
import { partyFare } from "@/lib/pricing";
import type { Activity, Itinerary, TripDay } from "@/lib/types";

const NUM_RUNS = 100;

const activityArb: fc.Arbitrary<Activity> = fc.record({
  time: fc.constant("09:00"),
  title: fc.constant("a"),
  description: fc.constant("d"),
  cost: fc.integer({ min: 0, max: 50000 }),
  category: fc.constantFrom("transfer", "sight", "meal", "leisure"),
});

const daysArb = fc.array(fc.array(activityArb, { maxLength: 4 }), { minLength: 1, maxLength: 4 });

function build(days: Activity[][]): Itinerary {
  const tripDays: TripDay[] = days.map((acts, i) => ({
    day: i + 1,
    date: "",
    title: `Day ${i + 1}`,
    theme: "t",
    activities: acts,
    total: acts.reduce((s, a) => s + a.cost, 0),
  }));
  return {
    title: "Trip",
    totalCost: tripDays.reduce((s, d) => s + d.total, 0),
    days: tripDays,
    costUnit: "inr",
  };
}

const stayArb = fc.integer({ min: 0, max: 1_000_000 });
const fareArb = fc.integer({ min: 0, max: 200_000 });
const travellersArb = fc.integer({ min: 1, max: 12 });
const couponArb = fc.option(fc.constantFrom("GENIE500", "FREQ750", "PRICE1000", "DELIGHT300", "BOGUS"), {
  nil: undefined,
});

describe("Feature: trip-planning-v2, Property 20: No-flight pricing excludes the flight line", () => {
  it("noFlight gives flight 0 and finalPayable = stay + activities (no coupon)", () => {
    fc.assert(
      fc.property(daysArb, stayArb, fareArb, travellersArb, (days, stay, fare, travellers) => {
        const perPerson = days.flat().reduce((s, a) => s + a.cost, 0);
        const r = computeSummary({
          itinerary: build(days),
          stayInr: stay,
          flightPerPerson: fare,
          travellers,
          noFlight: true,
        });
        expect(r.flight).toBe(0);
        expect(r.finalPayable).toBe(stay + perPerson * travellers);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("noFlight false gives the party fare", () => {
    fc.assert(
      fc.property(daysArb, stayArb, fareArb, travellersArb, (days, stay, fare, travellers) => {
        const r = computeSummary({
          itinerary: build(days),
          stayInr: stay,
          flightPerPerson: fare,
          travellers,
          noFlight: false,
        });
        expect(r.flight).toBe(partyFare(fare, travellers));
        expect(r.flight).toBe(fare * travellers);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("activities = per-person sum x travellers and lines sum to finalPayable", () => {
    fc.assert(
      fc.property(
        daysArb,
        stayArb,
        fareArb,
        travellersArb,
        fc.boolean(),
        couponArb,
        (days, stay, fare, travellers, noFlight, coupon) => {
          const perPerson = days.flat().reduce((s, a) => s + a.cost, 0);
          const r = computeSummary({
            itinerary: build(days),
            stayInr: stay,
            flightPerPerson: fare,
            travellers,
            noFlight,
            coupon,
          });
          expect(r.activities).toBe(perPerson * travellers);
          expect(r.stay).toBe(stay);
          expect(r.flight + r.stay + r.activities - r.discount).toBe(r.finalPayable);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// web-grounded-pricing: Properties 4 and 22
// ---------------------------------------------------------------------------
import { priceSourceCounts, formatSourceCounts } from "@/lib/trip-summary";
import { isPriceable } from "@/lib/cost-classifier";

const wgClassArb = fc.constantFrom(
  "stay-checkin",
  "route-transport",
  "shopping",
  "free-sight",
  "paid-sight",
  "meal",
  "local-transfer",
  "other",
) as fc.Arbitrary<NonNullable<Activity["costClass"]>>;

const wgActivityArb: fc.Arbitrary<Activity> = fc.record({
  time: fc.constant("09:00"),
  title: fc.constant("a"),
  description: fc.constant("d"),
  cost: fc.integer({ min: 0, max: 50000 }),
  category: fc.constantFrom("transfer", "sight", "meal", "leisure"),
  costBasis: fc.constantFrom("person", "group") as fc.Arbitrary<"person" | "group">,
  costClass: wgClassArb,
  priceSource: fc.option(fc.constantFrom("web", "ai", "estimated") as fc.Arbitrary<"web" | "ai" | "estimated">, {
    nil: undefined,
  }),
});

const wgDaysArb = fc.array(fc.array(wgActivityArb, { maxLength: 5 }), { minLength: 1, maxLength: 4 });

function wgBuild(days: Activity[][], routeFare?: unknown): Itinerary {
  const it = build(days);
  return routeFare === undefined ? it : ({ ...it, routeFare } as unknown as Itinerary);
}

const wgRouteFareArb = fc.option(
  fc.record({
    mode: fc.constantFrom("bus", "train"),
    minInr: fc.integer({ min: 0, max: 5000 }),
    maxInr: fc.integer({ min: 0, max: 9000 }),
  }),
  { nil: undefined },
);

describe("Feature: web-grounded-pricing, Property 4: Summary lines sum to the total; the party total follows the cost basis", () => {
  // Feature: web-grounded-pricing, Property 4: Summary lines sum to the total; the party total follows the cost basis
  it("lines sum to the total and activities follow the cost basis; routeFare never changes a line", () => {
    fc.assert(
      fc.property(
        wgDaysArb,
        fc.integer({ min: 1, max: 9 }),
        stayArb,
        fareArb,
        fc.boolean(),
        couponArb,
        wgRouteFareArb,
        (days, travellers, stay, fare, noFlight, coupon, routeFare) => {
          const all = days.flat();
          const person = all.filter((a) => a.costBasis !== "group").reduce((s, a) => s + a.cost, 0);
          const group = all.filter((a) => a.costBasis === "group").reduce((s, a) => s + a.cost, 0);
          const expected = person * travellers + group * Math.ceil(travellers / 4);
          const input = { stayInr: stay, flightPerPerson: fare, travellers, noFlight, coupon };
          const r = computeSummary({ ...input, itinerary: wgBuild(days) });
          const withFare = computeSummary({ ...input, itinerary: wgBuild(days, routeFare) });

          expect(r.activities).toBe(expected);
          expect(r.flight + r.stay + r.activities - r.discount).toBe(r.finalPayable);
          expect(withFare).toEqual(r);
          if (travellers === 1) {
            expect(r.activities).toBe(all.reduce((s, a) => s + a.cost, 0));
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Feature: web-grounded-pricing, Property 22: Source counts partition the priceable activities", () => {
  // Feature: web-grounded-pricing, Property 22: Source counts partition the priceable activities
  it("web + ai + estimated equals the priceable count, the line is empty iff it is 0, and the total is unchanged", () => {
    fc.assert(
      fc.property(wgDaysArb, travellersArb, (days, travellers) => {
        const it = wgBuild(days);
        const before = computeSummary({
          itinerary: it,
          stayInr: 0,
          flightPerPerson: 0,
          travellers,
          noFlight: true,
        });
        const c = priceSourceCounts(it);
        const priceable = days.flat().filter((a) => isPriceable(a.costClass!)).length;
        const after = computeSummary({
          itinerary: it,
          stayInr: 0,
          flightPerPerson: 0,
          travellers,
          noFlight: true,
        });

        expect(c.web + c.ai + c.estimated).toBe(priceable);
        expect(formatSourceCounts(c) === "").toBe(priceable === 0);
        expect(after).toEqual(before);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
