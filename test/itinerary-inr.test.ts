// @vitest-environment node
// Feature: trip-planning-v2, Property 13: INR normalisation happens exactly once
// Feature: trip-planning-v2, Property 14: Rate resolution never yields a bad rate
// Feature: trip-planning-v2, Property 15: Totals are always the sum of the displayed lines
// Feature: trip-planning-v2, Property 15: Totals are always the sum of the displayed lines
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  activitiesTotalInr,
  activityId,
  applyPriceResults,
  normalizeItineraryToInr,
  formatInr,
  priceLabel,
  recomputeTotals,
  resolveUsdInr,
  restampItineraryDates,
  withEstimatedActivity,
} from "@/lib/itinerary-inr";
import { USD_INR_FALLBACK, type PriceResult } from "@/lib/activity-pricer";
import { fromSharedContext, toSharedContext } from "@/lib/history/record-codec";
import type { Activity, ActivityCategory, Itinerary, TripDay } from "@/lib/types";

const NUM_RUNS = 100;

const categoryArb: fc.Arbitrary<ActivityCategory> = fc.constantFrom("transfer", "sight", "meal", "leisure");
const rateArb = fc.double({ min: 0.01, max: 500, noNaN: true, noDefaultInfinity: true });
const textArb = fc.string({ maxLength: 12 });

function buildItinerary(days: Activity[][], costUnit?: "inr"): Itinerary {
  const tripDays: TripDay[] = days.map((acts, i) => ({
    day: i + 1,
    date: "",
    title: `Day ${i + 1}`,
    theme: "t",
    activities: acts,
    total: acts.reduce((s, a) => s + a.cost, 0),
  }));
  const it: Itinerary = {
    title: "Trip",
    totalCost: tripDays.reduce((s, d) => s + d.total, 0),
    days: tripDays,
  };
  if (costUnit) it.costUnit = costUnit;
  return it;
}

const usdActivityArb: fc.Arbitrary<Activity> = fc.record({
  time: textArb,
  title: textArb,
  description: textArb,
  cost: fc.double({ min: 0, max: 5000, noNaN: true, noDefaultInfinity: true }),
  category: categoryArb,
});

/** Model-generated: integer INR costs, at least one activity lacks a category. */
const modelActivityArb: fc.Arbitrary<Activity> = fc.record(
  {
    time: textArb,
    title: textArb,
    description: textArb,
    cost: fc.integer({ min: 0, max: 500000 }),
    category: categoryArb,
  },
  { requiredKeys: ["time", "title", "description", "cost"] },
);

const daysOf = <T>(a: fc.Arbitrary<T>) =>
  fc.array(fc.array(a, { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 4 });

const usdItineraryArb = daysOf(usdActivityArb).map((d) => buildItinerary(d));

const modelItineraryArb = fc
  .tuple(daysOf(modelActivityArb), fc.nat({ max: 20 }))
  .map(([days, pick]) => {
    const flat = days.flat();
    const idx = pick % flat.length;
    const target = flat[idx];
    delete target.category; // guarantee at least one uncategorised activity
    return buildItinerary(days);
  });

const allActivities = (it: Itinerary) => it.days.flatMap((d) => d.activities);

describe("Feature: trip-planning-v2, Property 13: INR normalisation happens exactly once", () => {
  it("converts USD-anchored costs to round(usd x rate), labels them estimated, and is idempotent", () => {
    fc.assert(
      fc.property(usdItineraryArb, rateArb, (it, rate) => {
        const before = allActivities(it).map((a) => a.cost);
        const out = normalizeItineraryToInr(it, rate);
        const acts = allActivities(out);
        expect(out.costUnit).toBe("inr");
        expect(out.currency).toBe("INR");
        acts.forEach((a, i) => {
          expect(a.cost).toBe(Math.round(before[i] * rate));
          expect(a.priceSource).toBe("estimated");
        });
        out.days.forEach((d) => expect(d.total).toBe(d.activities.reduce((s, a) => s + a.cost, 0)));
        expect(out.totalCost).toBe(out.days.reduce((s, d) => s + d.total, 0));

        // Second pass (even with a different rate) changes nothing.
        expect(normalizeItineraryToInr(out, rate * 2 + 1)).toEqual(out);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("keeps model-generated INR costs (only rounding) and is idempotent", () => {
    fc.assert(
      fc.property(modelItineraryArb, rateArb, (it, rate) => {
        const before = allActivities(it).map((a) => a.cost);
        const out = normalizeItineraryToInr(it, rate);
        allActivities(out).forEach((a, i) => {
          expect(a.cost).toBe(before[i]);
          expect(a.priceSource).toBe("estimated");
        });
        expect(out.costUnit).toBe("inr");
        expect(normalizeItineraryToInr(out, rate)).toEqual(out);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("returns an already-INR itinerary unchanged regardless of rate", () => {
    fc.assert(
      fc.property(daysOf(usdActivityArb), rateArb, (days, rate) => {
        const it = buildItinerary(days, "inr");
        expect(normalizeItineraryToInr(it, rate)).toEqual(it);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("keeps every cost, source and basis through the history codec round trip", () => {
    const basisArb = fc.option(fc.string({ maxLength: 20 }), { nil: undefined });
    fc.assert(
      fc.property(fc.oneof(usdItineraryArb, modelItineraryArb), rateArb, basisArb, (it, rate, basis) => {
        const normalized = normalizeItineraryToInr(it, rate);
        const withBasis: Itinerary = {
          ...normalized,
          days: normalized.days.map((d) => ({
            ...d,
            activities: d.activities.map((a) => (basis === undefined ? a : { ...a, priceBasis: basis })),
          })),
        };
        const stored = JSON.parse(JSON.stringify(fromSharedContext({ context: {}, dates: {}, itinerary: withBasis })));
        const restored = toSharedContext(stored).itinerary as Itinerary;
        expect(restored.costUnit).toBe("inr");
        expect(restored.totalCost).toBe(withBasis.totalCost);
        allActivities(restored).forEach((a, i) => {
          const orig = allActivities(withBasis)[i];
          expect(a.cost).toBe(orig.cost);
          expect(a.priceSource).toBe(orig.priceSource);
          expect(a.priceBasis).toBe(orig.priceBasis);
        });
        // Re-normalising a restored itinerary must not convert a second time.
        expect(normalizeItineraryToInr(restored, rate)).toEqual(restored);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Feature: trip-planning-v2, Property 14: Rate resolution never yields a bad rate", () => {
  const goodRate = (r: unknown) => typeof r === "number" && Number.isFinite(r) && r > 0;

  it("always returns a finite rate > 0 for any response shape", () => {
    fc.assert(
      fc.property(fc.anything(), (res) => {
        const info = resolveUsdInr(res as never);
        expect(Number.isFinite(info.usdInr)).toBe(true);
        expect(info.usdInr).toBeGreaterThan(0);
        expect(["live", "fallback"]).toContain(info.basis);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("uses the rate for live/cached with a valid rate, otherwise falls back", () => {
    const modeArb = fc.oneof(fc.constantFrom("live", "cached", "fallback", "mock", ""), fc.anything());
    const rateAnyArb = fc.oneof(
      fc.double(),
      fc.constantFrom(0, -1, NaN, Infinity, -Infinity, "95", null, undefined),
      fc.anything(),
    );
    fc.assert(
      fc.property(modeArb, rateAnyArb, fc.boolean(), (mode, rate, wrap) => {
        const res = wrap ? { mode, data: { rate } } : { mode };
        const info = resolveUsdInr(res as never);
        const ok = wrap && (mode === "live" || mode === "cached") && goodRate(rate);
        if (ok) {
          expect(info).toEqual({ usdInr: rate, basis: "live" });
        } else {
          expect(info).toEqual({ usdInr: USD_INR_FALLBACK, basis: "fallback" });
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("falls back for null, undefined and mode fallback with a good rate", () => {
    expect(resolveUsdInr(null)).toEqual({ usdInr: USD_INR_FALLBACK, basis: "fallback" });
    expect(resolveUsdInr(undefined)).toEqual({ usdInr: USD_INR_FALLBACK, basis: "fallback" });
    fc.assert(
      fc.property(rateArb, (rate) => {
        expect(resolveUsdInr({ mode: "fallback", data: { rate } })).toEqual({
          usdInr: USD_INR_FALLBACK,
          basis: "fallback",
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Feature: trip-planning-v2, Property 15: Totals are always the sum of the displayed lines", () => {
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

  /** For every activity: no result, or a result with source ai/estimated and an integer inr. */
  const resultPlanArb = fc.array(
    fc.option(
      fc.record({
        inr: fc.integer({ min: 0, max: 500000 }),
        source: fc.constantFrom<"ai" | "estimated">("ai", "estimated"),
        basis: fc.string({ maxLength: 20 }),
      }),
      { nil: undefined },
    ),
    { minLength: 16, maxLength: 16 },
  );
  const strayArb = fc.array(
    fc.record({
      id: fc.string({ maxLength: 10 }).map((s) => `zz-${s}`),
      inr: fc.integer({ min: 0, max: 500000 }),
      source: fc.constantFrom<"ai" | "estimated">("ai", "estimated"),
      basis: fc.string({ maxLength: 20 }),
    }),
    { maxLength: 4 },
  );

  const scenarioArb = fc.tuple(
    daysOf(modelActivityArb).map((d) => buildItinerary(d)),
    resultPlanArb,
    strayArb,
    fc.integer({ min: 1, max: 9 }),
  );

  function build(it: Itinerary, plan: Array<{ inr: number; source: "ai" | "estimated"; basis: string } | undefined>, stray: PriceResult[]) {
    const results: PriceResult[] = [];
    const matched = new Map<string, PriceResult>();
    let n = 0;
    it.days.forEach((d) =>
      d.activities.forEach((a, i) => {
        const p = plan[n++ % plan.length];
        if (!p) return;
        const r = { id: activityId(d.day, a, i), inr: p.inr, source: p.source, basis: p.basis } as PriceResult;
        results.push(r);
        matched.set(r.id, r);
      }),
    );
    return { results: [...results, ...stray], matched };
  }

  it("keeps day totals, totalCost and activitiesTotalInr equal to the sum of displayed lines", () => {
    fc.assert(
      fc.property(scenarioArb, ([it, plan, stray, travellers]) => {
        const { results } = build(it, plan, stray as PriceResult[]);
        const out = applyPriceResults(it, results);
        out.days.forEach((d) => expect(d.total).toBe(sum(d.activities.map((a) => a.cost))));
        const dayTotals = sum(out.days.map((d) => d.total));
        const allCosts = sum(out.days.flatMap((d) => d.activities.map((a) => a.cost)));
        expect(out.totalCost).toBe(dayTotals);
        expect(activitiesTotalInr(out)).toBe(dayTotals);
        expect(activitiesTotalInr(out)).toBe(allCosts);
        // Party total on the Trip Summary is the per-person sum times travellers.
        expect(activitiesTotalInr(out) * travellers).toBe(allCosts * travellers);
        expect(out.costUnit).toBe("inr");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("copies matched inr unconverted with its source, and leaves unmatched activities unchanged", () => {
    fc.assert(
      fc.property(scenarioArb, ([it, plan, stray]) => {
        const { results, matched } = build(it, plan, stray as PriceResult[]);
        const out = applyPriceResults(it, results);
        expect(out.days.length).toBe(it.days.length);
        out.days.forEach((d, di) =>
          d.activities.forEach((a, i) => {
            const orig = it.days[di].activities[i];
            const r = matched.get(activityId(it.days[di].day, orig, i));
            if (r) {
              expect(a.cost).toBe(r.inr); // never multiplied or rescaled
              expect(a.priceSource).toBe(r.source === "ai" ? "ai" : "estimated");
              expect(a.priceBasis).toBe(r.basis);
              expect(a.title).toBe(orig.title);
            } else {
              expect(a).toEqual(orig);
            }
          }),
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("ignores results that match no activity and is a no-op on costs when nothing matches", () => {
    fc.assert(
      fc.property(scenarioArb, ([it, , stray]) => {
        const out = applyPriceResults(it, stray as PriceResult[]);
        expect(allActivities(out).map((a) => a.cost)).toEqual(allActivities(it).map((a) => a.cost));
        expect(out.totalCost).toBe(recomputeTotals(it).totalCost);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// Feature: trip-planning-v2, Property 16: Edits keep unchanged prices
// Feature: trip-planning-v2, Property 17: Labels and INR formatting
describe("Feature: trip-planning-v2, Property 16: Edits keep unchanged prices", () => {
  const pricedActivityArb: fc.Arbitrary<Activity> = fc.record({
    time: textArb,
    title: fc.string({ minLength: 1, maxLength: 12 }),
    description: textArb,
    cost: fc.integer({ min: 0, max: 500000 }),
    category: categoryArb,
    priceSource: fc.constantFrom<"ai" | "estimated">("ai", "estimated"),
    priceBasis: fc.string({ minLength: 1, maxLength: 20 }),
  });
  const pricedItineraryArb = daysOf(pricedActivityArb).map((d) => recomputeTotals(buildItinerary(d, "inr")));
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

  it("add: untouched activities keep cost/source/basis, the new one is estimated, totals hold", () => {
    fc.assert(
      fc.property(
        pricedItineraryArb,
        fc.nat({ max: 10 }),
        fc.string({ minLength: 1, maxLength: 12 }),
        rateArb,
        (it, pick, title, rate) => {
          const di = pick % it.days.length;
          const added = withEstimatedActivity(
            { time: "10:00", title, description: "", cost: 1, category: "sight", priceSource: "ai", priceBasis: "old" },
            "Goa",
            rate,
          );
          expect(added.priceSource).toBe("estimated");
          expect(added.priceBasis).toBeUndefined();
          expect(Number.isInteger(added.cost)).toBe(true);
          expect(added.cost).toBeGreaterThanOrEqual(0);

          const edited = recomputeTotals({
            ...it,
            days: it.days.map((d, i) => (i === di ? { ...d, activities: [...d.activities, added] } : d)),
          });
          it.days.forEach((d, i) =>
            d.activities.forEach((a, j) => {
              const b = edited.days[i].activities[j];
              expect(b.cost).toBe(a.cost);
              expect(b.priceSource).toBe(a.priceSource);
              expect(b.priceBasis).toBe(a.priceBasis);
            }),
          );
          edited.days.forEach((d) => expect(d.total).toBe(sum(d.activities.map((a) => a.cost))));
          expect(edited.totalCost).toBe(sum(edited.days.map((d) => d.total)));
          expect(activitiesTotalInr(edited)).toBe(edited.totalCost);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("remove: remaining activities keep their prices and totals hold", () => {
    fc.assert(
      fc.property(pricedItineraryArb, fc.nat({ max: 10 }), (it, pick) => {
        const di = pick % it.days.length;
        const removed = recomputeTotals({
          ...it,
          days: it.days.map((d, i) => (i === di ? { ...d, activities: d.activities.slice(0, -1) } : d)),
        });
        removed.days.forEach((d, i) =>
          d.activities.forEach((a, j) => {
            expect(a).toEqual(it.days[i].activities[j]);
          }),
        );
        removed.days.forEach((d) => expect(d.total).toBe(sum(d.activities.map((a) => a.cost))));
        expect(removed.totalCost).toBe(sum(removed.days.map((d) => d.total)));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Feature: trip-planning-v2, Property 17: Labels and INR formatting", () => {
  it("priceLabel is 'AI estimate' iff source is ai, else 'estimated'", () => {
    fc.assert(
      fc.property(fc.oneof(fc.constantFrom<"ai" | "estimated" | undefined>("ai", "estimated", undefined), fc.anything()), (s) => {
        expect(priceLabel(s as never)).toBe(s === "ai" ? "AI estimate" : "estimated");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("formatInr uses Indian grouping for non-negative integers", () => {
    const indian = (n: number) => {
      const s = String(n);
      if (s.length <= 3) return s;
      return `${s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${s.slice(-3)}`;
    };
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2_000_000_000 }), (n) => {
        const out = formatInr(n);
        expect(out).toBe(`INR ${indian(n)}`);
        expect(out.slice(4).replace(/,/g, "")).toBe(String(n));
        expect(out).toBe(`INR ${n.toLocaleString("en-IN")}`);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("formatInr examples and totality", () => {
    expect(formatInr(1234567)).toBe("INR 12,34,567");
    expect(formatInr(999)).toBe("INR 999");
    expect(formatInr(1000)).toBe("INR 1,000");
    expect(formatInr(0)).toBe("INR 0");
    fc.assert(fc.property(fc.anything(), (v) => typeof formatInr(v as never) === "string"), { numRuns: NUM_RUNS });
  });
});

describe("restampItineraryDates (design C1)", () => {
  const base = buildItinerary([[{ time: "9", title: "a", description: "", cost: 1 }], [], []], "inr");

  it("sets day i to start + i days, crossing month and year ends", () => {
    expect(restampItineraryDates(base, "2030-12-30").days.map((d) => d.date)).toEqual([
      "2030-12-30",
      "2030-12-31",
      "2031-01-01",
    ]);
    expect(restampItineraryDates(base, "2028-02-28").days.map((d) => d.date)).toEqual([
      "2028-02-28",
      "2028-02-29",
      "2028-03-01",
    ]);
  });

  it("returns the itinerary unchanged for invalid start dates", () => {
    for (const bad of ["", "tomorrow", "2030-13-01", "2030-02-30", "30-01-2030", "2030-1-1"]) {
      expect(restampItineraryDates(base, bad)).toBe(base);
    }
  });

  it("keeps everything but day dates", () => {
    const out = restampItineraryDates(base, "2030-05-01");
    expect(out.totalCost).toBe(base.totalCost);
    out.days.forEach((d, i) => expect({ ...d, date: "" }).toEqual({ ...base.days[i], date: "" }));
  });
});

// ---------------------------------------------------------------------------
// web-grounded-pricing: classification, caps and web fields (tasks 4.6)
// ---------------------------------------------------------------------------
import {
  CAPPED_BASIS,
  capFor,
  resolveBudgetLevel,
  resolveCityTier,
  webBoundFor,
  type BudgetLevel,
} from "@/lib/cost-caps";
import { basisFor, classifyActivity, isPriceable } from "@/lib/cost-classifier";
import { toPricerRequest, type ItineraryCostOpts } from "@/lib/itinerary-inr";

const WGP_CLASSES = [
  "stay-checkin",
  "route-transport",
  "shopping",
  "free-sight",
  "paid-sight",
  "meal",
  "local-transfer",
  "other",
];
const WGP_TITLES = [
  "Private Car Transfer from Chennai",
  "Check-in at Sterling Yelagiri Resort",
  "Vaniyambadi Fort Exploration",
  "Leather Shopping at Gandhi Road Market",
  "Dinner at Hotel Saravana Bhavan",
  "Visit the Government Museum",
  "Auto ride to the lake",
  "Train from Chennai to Vaniyambadi",
  "Evening free time",
  "",
];
const wgpTitleArb = fc.oneof(fc.constantFrom(...WGP_TITLES), fc.string({ maxLength: 40 }), fc.string({ minLength: 200, maxLength: 300 }));
const wgpBudgetArb = fc.constantFrom<BudgetLevel>("budget", "mid", "luxury");
const wgpPlaceArb = fc.oneof(
  fc.constantFrom("Vaniyambadi", "Chennai", "Goa", "Singapore", "Chennai, India", ""),
  fc.string({ maxLength: 12 }),
);
const wgpActivityArb: fc.Arbitrary<Activity> = fc.record(
  {
    time: textArb,
    title: wgpTitleArb,
    description: textArb,
    cost: fc.integer({ min: 0, max: 200000 }),
    category: categoryArb,
  },
  { requiredKeys: ["time", "title", "description", "cost"] },
);
/** Model-generated INR itinerary: at least one activity lacks a category, so nothing is rescaled. */
const wgpItineraryArb = fc
  .tuple(fc.array(fc.array(wgpActivityArb, { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 3 }), fc.double({ min: 0.01, max: 500, noNaN: true, noDefaultInfinity: true }))
  .map(([days]) => {
    delete days[0][0].category;
    return buildItinerary(days);
  });

describe("Feature: web-grounded-pricing, Property 1: Classification is total and non-priceable rows are excluded", () => {
  // Feature: web-grounded-pricing, Property 1: Classification is total and non-priceable rows are excluded
  it("classifyActivity returns one known class and basisFor is group only for hired vehicles", () => {
    fc.assert(
      fc.property(
        wgpTitleArb,
        fc.option(categoryArb, { nil: undefined }),
        fc.oneof(fc.string({ maxLength: 20 }), fc.constant(undefined)),
        fc.oneof(fc.string({ maxLength: 20 }), fc.constant(undefined)),
        (title, category, origin, destination) => {
          const cls = classifyActivity({ title, category }, { origin, destination });
          expect(WGP_CLASSES).toContain(cls);
          const basis = basisFor(cls, title);
          if (basis === "group") {
            expect(cls).toBe("local-transfer");
            expect(/\b(cab|taxi|auto|private car|driver)\b/i.test(title)).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: web-grounded-pricing, Property 1: Classification is total and non-priceable rows are excluded
  it("non-priceable rows are zeroed by normalisation and absent from the pricer request", () => {
    fc.assert(
      fc.property(
        wgpItineraryArb,
        rateArb,
        wgpBudgetArb,
        wgpPlaceArb,
        wgpPlaceArb,
        (it, rate, budgetLevel, origin, destination) => {
          const opts: ItineraryCostOpts = { origin, destination, budgetLevel };
          const out = normalizeItineraryToInr(it, rate, opts);
          const req = toPricerRequest(destination, out, opts);
          const requested = new Set(req.activities.map((a) => a.id));
          let priceable = 0;
          out.days.forEach((d, di) =>
            d.activities.forEach((a, i) => {
              expect(WGP_CLASSES).toContain(a.costClass);
              const id = activityId(d.day ?? di + 1, a, i);
              if (isPriceable(a.costClass!)) {
                priceable += 1;
                expect(requested.has(id)).toBe(true);
              } else {
                expect(a.cost).toBe(0);
                expect(requested.has(id)).toBe(false);
              }
            }),
          );
          expect(req.activities.length).toBe(priceable);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Feature: web-grounded-pricing, Property 3: Applied costs stay inside their bound and totals stay consistent", () => {
  const WEB = { sourceUrl: "https://example.org/fees", sourceHost: "example.org", checkedAt: "2025-01-01T00:00:00.000Z" };
  const planArb = fc.array(
    fc.option(
      fc.record({
        source: fc.constantFrom<"web" | "ai" | "estimated">("web", "ai", "estimated"),
        inr: fc.oneof(fc.integer({ min: -5000, max: 2_000_000 }), fc.constantFrom(0, 1e12, -1, Number.NaN, Infinity)),
        validWeb: fc.boolean(),
      }),
      { nil: undefined },
    ),
    { minLength: 12, maxLength: 12 },
  );

  // Feature: web-grounded-pricing, Property 3: Applied costs stay inside their bound and totals stay consistent
  it("caps non-web costs, bounds web costs, labels clamps and keeps totals consistent", () => {
    fc.assert(
      fc.property(wgpItineraryArb, rateArb, wgpBudgetArb, wgpPlaceArb, planArb, (it, rate, budgetLevel, destination, plan) => {
        const opts: ItineraryCostOpts = { origin: "Chennai", destination, budgetLevel };
        const normalised = normalizeItineraryToInr(it, rate, opts);
        expect(normalizeItineraryToInr(normalised, rate * 3 + 1, opts)).toEqual(normalised);

        const results: Array<PriceResult & { source: string }> = [];
        let n = 0;
        normalised.days.forEach((d, di) =>
          d.activities.forEach((a, i) => {
            const p = plan[n++ % plan.length];
            if (!p) return;
            const r = { id: activityId(d.day ?? di + 1, a, i), inr: p.inr, source: p.source, basis: "b" } as PriceResult & Record<string, unknown>;
            if (p.source === "web") Object.assign(r, p.validWeb ? WEB : { sourceUrl: "http://bad", sourceHost: "x", checkedAt: "no" });
            results.push(r as PriceResult & { source: string });
          }),
        );
        const out = applyPriceResults(normalised, results, opts);

        const budget = resolveBudgetLevel(budgetLevel);
        const tier = resolveCityTier(destination);
        out.days.forEach((d) => {
          expect(d.total).toBe(d.activities.reduce((s, a) => s + a.cost, 0));
          d.activities.forEach((a) => {
            const cls = a.costClass!;
            expect(Number.isFinite(a.cost)).toBe(true);
            expect(a.cost).toBeGreaterThanOrEqual(0);
            if (a.priceSource === "web") {
              expect(a.cost).toBeLessThanOrEqual(webBoundFor(cls, budget, tier));
            } else {
              expect(a.cost).toBeLessThanOrEqual(capFor(cls, budget, tier));
            }
            if (a.priceBasis === CAPPED_BASIS) expect(a.priceSource).toBe("estimated");
          });
        });
        expect(out.totalCost).toBe(out.days.reduce((s, d) => s + d.total, 0));
        expect(activitiesTotalInr(out)).toBe(out.totalCost);
        expect(out.costUnit).toBe("inr");
        expect(applyPriceResults(out, [], opts)).toEqual(out);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: web-grounded-pricing, Property 3: Applied costs stay inside their bound and totals stay consistent
  it("a priced result above the cap becomes an estimated, capped price", () => {
    fc.assert(
      fc.property(wgpBudgetArb, fc.integer({ min: 1_000_000, max: 5_000_000 }), (budgetLevel, huge) => {
        const opts: ItineraryCostOpts = { origin: "Chennai", destination: "Vaniyambadi", budgetLevel };
        const base = normalizeItineraryToInr(
          buildItinerary([[{ time: "10:00", title: "Dinner at Hotel Saravana Bhavan", description: "", cost: 10 }]]),
          83,
          opts,
        );
        const id = activityId(1, base.days[0].activities[0], 0);
        const out = applyPriceResults(base, [{ id, inr: huge, source: "ai", basis: "x" } as PriceResult], opts);
        const a = out.days[0].activities[0];
        expect(a.cost).toBe(capFor("meal", resolveBudgetLevel(budgetLevel), "small"));
        expect(a.priceSource).toBe("estimated");
        expect(a.priceBasis).toBe(CAPPED_BASIS);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("web-grounded-pricing: the five reported rows after normalisation", () => {
  const opts: ItineraryCostOpts = { origin: "Chennai", destination: "Vaniyambadi", budgetLevel: "mid" };
  const rows: Activity[] = [
    { time: "08:00", title: "Private Car Transfer from Chennai", description: "", cost: 8000 },
    { time: "14:00", title: "Check-in at Sterling Yelagiri Resort", description: "", cost: 15000 },
    { time: "16:00", title: "Vaniyambadi Fort Exploration", description: "", cost: 2000 },
    { time: "18:00", title: "Leather Shopping at Gandhi Road Market", description: "", cost: 5000 },
    { time: "20:00", title: "Dinner at Hotel Saravana Bhavan", description: "", cost: 3000 },
  ];
  const out = normalizeItineraryToInr(buildItinerary([rows]), 83, opts);
  const [route, checkin, fort, shopping, dinner] = out.days[0].activities;

  it("zeroes route transport with its note", () => {
    expect(route.cost).toBe(0);
    expect(route.costNote).toBe("Included in route transport");
  });

  it("zeroes the stay check-in with its note", () => {
    expect(checkin.cost).toBe(0);
    expect(checkin.costNote).toBe("Included in stay");
  });

  it("keeps the fort inside the sanity bound", () => {
    expect(fort.cost).toBeLessThanOrEqual(webBoundFor("free-sight", "mid", "small"));
    expect(fort.cost).toBeLessThan(2000);
  });

  it("zeroes shopping with its note", () => {
    expect(shopping.cost).toBe(0);
    expect(shopping.costNote).toBe("Optional, your spend");
  });

  it("keeps the dinner inside the meal cap", () => {
    expect(dinner.cost).toBeLessThanOrEqual(capFor("meal", "mid", "small"));
    expect(dinner.costClass).toBe("meal");
  });

  it("totals only the priceable rows", () => {
    expect(out.totalCost).toBe(fort.cost + dinner.cost);
  });
});

describe("web-grounded-pricing: withEstimatedActivity strips web fields", () => {
  it("drops sourceUrl, sourceHost, checkedAt and priceBasis and labels the price estimated", () => {
    const a: Activity = {
      time: "10:00",
      title: "Vaniyambadi Fort Exploration",
      description: "",
      cost: 120,
      priceSource: "web",
      priceBasis: "INR 120 entry, per example.org",
      sourceUrl: "https://example.org/fees",
      sourceHost: "example.org",
      checkedAt: "2025-01-01T00:00:00.000Z",
    };
    const out = withEstimatedActivity(a, "Vaniyambadi", 83, { origin: "Chennai", destination: "Vaniyambadi", budgetLevel: "mid" });
    expect(out.sourceUrl).toBeUndefined();
    expect(out.sourceHost).toBeUndefined();
    expect(out.checkedAt).toBeUndefined();
    expect(out.priceBasis).toBeUndefined();
    expect(out.priceSource).toBe("estimated");
    expect(out.cost).toBe(Math.round(capFor("free-sight", "mid", "small") / 2));
  });
});
