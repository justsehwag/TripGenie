import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  isValidWebFields,
  parseRouteFare,
  sanitizeItineraryWebPrices,
  sanitizeStoredItinerary,
} from "@/lib/web-price-sources";

const GOOD = {
  sourceUrl: "https://asi.example.org/fort",
  sourceHost: "asi.example.org",
  checkedAt: "2025-03-12T09:00:00.000Z",
};

const webFields = fc.oneof(
  fc.constant({ ...GOOD }),
  fc.constant({ ...GOOD, sourceUrl: "http://asi.example.org/fort" }),
  fc.constant({ ...GOOD, sourceUrl: "javascript:alert(1)" }),
  fc.constant({ ...GOOD, sourceHost: "other.example.org" }),
  fc.constant({ ...GOOD, checkedAt: "not a date" }),
  fc.constant({ sourceUrl: GOOD.sourceUrl }),
  fc.constant({}),
  fc.constant({ ...GOOD, sourceUrl: 42 }),
);

const activity = fc
  .tuple(
    fc.constantFrom("web", "ai", "estimated"),
    fc.integer({ min: 0, max: 5000 }),
    webFields,
  )
  .map(([priceSource, cost, w]) => ({
    id: "a",
    title: "Fort",
    cost,
    priceSource,
    priceBasis: "basis",
    ...w,
  }));

const validRoute = {
  mode: "bus",
  minInr: 120,
  maxInr: 350,
  ...GOOD,
};
const routeFare = fc.oneof(
  fc.constant(undefined),
  fc.constant({ ...validRoute }),
  fc.constant({ ...validRoute, mode: "plane" }),
  fc.constant({ ...validRoute, minInr: 0 }),
  fc.constant({ ...validRoute, maxInr: 999999 }),
  fc.constant({ ...validRoute, sourceUrl: "http://x.example.org" }),
  fc.constant("junk"),
  fc.constant(null),
);

describe("web-grounded-pricing persistence", () => {
  // Feature: web-grounded-pricing, Property 21: Stored web fields are re-validated without changing the cost
  it("Property 21: re-validates stored web fields, keeps cost", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(activity, { maxLength: 4 }), { maxLength: 3 }),
        routeFare,
        (dayActs, rf) => {
          const it: Record<string, unknown> = {
            sources: [{ title: "s", url: "https://s.example.org" }],
            days: dayActs.map((activities, d) => ({ day: d + 1, activities })),
          };
          if (rf !== undefined) it.routeFare = rf;
          const out = sanitizeItineraryWebPrices(it) as typeof it;

          let changed = false;
          const outDays = out.days as { activities: Record<string, unknown>[] }[];
          dayActs.forEach((acts, d) =>
            acts.forEach((a, i) => {
              const o = outDays[d].activities[i];
              expect(o.cost).toBe(a.cost);
              if (a.priceSource === "web" && !isValidWebFields(a as Record<string, unknown>)) {
                changed = true;
                expect(o.priceSource).toBe("estimated");
                expect("sourceUrl" in o).toBe(false);
                expect("sourceHost" in o).toBe(false);
                expect("checkedAt" in o).toBe(false);
                expect("priceBasis" in o).toBe(false);
              } else {
                expect(o).toEqual(a);
              }
            }),
          );
          if (rf !== undefined) {
            const parsed = parseRouteFare(rf);
            if (parsed) expect(out.routeFare).toEqual(parsed);
            else {
              changed = true;
              expect("routeFare" in out).toBe(false);
            }
          }
          expect(out.sources).toBe(it.sources);
          if (!changed) expect(out).toBe(it);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("leaves a payload with no new fields as the same object", () => {
    const plain = { days: [{ day: 1, activities: [{ id: "a", cost: 10, priceSource: "ai" }] }] };
    expect(sanitizeStoredItinerary(plain)).toBe(plain);
  });

  it("removes an invalid routeFare and keeps a valid one", () => {
    const bad = { days: [], routeFare: { ...validRoute, mode: "plane" } };
    expect("routeFare" in sanitizeItineraryWebPrices(bad)).toBe(false);
    const good = { days: [], routeFare: { ...validRoute } };
    expect(sanitizeItineraryWebPrices(good)).toBe(good);
  });

  it("does not touch sources", () => {
    const sources = [{ title: "s", url: "https://s.example.org" }];
    const it = {
      sources,
      days: [{ day: 1, activities: [{ id: "a", cost: 5, priceSource: "web", sourceUrl: "http://x" }] }],
    };
    const out = sanitizeItineraryWebPrices(it);
    expect(out.sources).toBe(sources);
    expect(out.days[0].activities[0].priceSource).toBe("estimated");
    expect(out.days[0].activities[0].cost).toBe(5);
  });
});
