import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  capFor,
  webBoundFor,
  estimateFor,
  clampToCap,
  resolveBudgetLevel,
  resolveCityTier,
  type BudgetLevel,
  type CityTier,
  type CostClass,
} from "../lib/cost-caps";

const CLASSES: CostClass[] = [
  "stay-checkin", "route-transport", "shopping", "free-sight",
  "paid-sight", "meal", "local-transfer", "other",
];
const BUDGETS: BudgetLevel[] = ["budget", "mid", "luxury"];
const TIERS: CityTier[] = ["small", "tier2", "metro"];

const cls = fc.constantFrom(...CLASSES);
const bud = fc.constantFrom(...BUDGETS);
const tier = fc.constantFrom(...TIERS);

// Feature: web-grounded-pricing, Property 2: Cap table and Web_Sanity_Bound are total, monotone and ordered
describe("cost-caps Property 2", () => {
  it("caps and bounds are total, integer and ordered for every cell", () => {
    for (const c of CLASSES)
      for (const b of BUDGETS)
        for (const t of TIERS) {
          const cap = capFor(c, b, t);
          const bound = webBoundFor(c, b, t);
          expect(Number.isInteger(cap) && cap >= 0).toBe(true);
          expect(Number.isInteger(bound) && Number.isFinite(bound)).toBe(true);
          expect(bound).toBeGreaterThanOrEqual(cap);
          expect(estimateFor(c, b, t)).toBe(Math.round(cap / 2));
        }
  });

  it("is monotone in budget level and city tier", () => {
    fc.assert(
      fc.property(cls, bud, tier, (c, b, t) => {
        const bi = BUDGETS.indexOf(b);
        const ti = TIERS.indexOf(t);
        if (bi < 2) {
          const nb = BUDGETS[bi + 1];
          expect(capFor(c, nb, t)).toBeGreaterThanOrEqual(capFor(c, b, t));
          expect(webBoundFor(c, nb, t)).toBeGreaterThanOrEqual(webBoundFor(c, b, t));
        }
        if (ti < 2) {
          const nt = TIERS[ti + 1];
          expect(capFor(c, b, nt)).toBeGreaterThanOrEqual(capFor(c, b, t));
          expect(webBoundFor(c, b, nt)).toBeGreaterThanOrEqual(webBoundFor(c, b, t));
        }
      }),
      { numRuns: 200 },
    );
  });

  it("free-sight bound equals paid-sight bound", () => {
    fc.assert(
      fc.property(bud, tier, (b, t) => {
        expect(webBoundFor("free-sight", b, t)).toBe(webBoundFor("paid-sight", b, t));
      }),
      { numRuns: 100 },
    );
  });

  it("clampToCap never exceeds the cap and treats bad input as 0", () => {
    fc.assert(
      fc.property(fc.oneof(fc.double({ noNaN: false }), fc.integer()), cls, bud, tier, (n, c, b, t) => {
        const r = clampToCap(n, c, b, t);
        expect(r.inr).toBeGreaterThanOrEqual(0);
        expect(r.inr).toBeLessThanOrEqual(capFor(c, b, t));
        if (!Number.isFinite(n) || n < 0) expect(r.inr).toBe(0);
      }),
      { numRuns: 200 },
    );
  });

  it("resolvers return valid members and default for unknown input", () => {
    fc.assert(
      fc.property(fc.anything(), (x) => {
        expect(BUDGETS).toContain(resolveBudgetLevel(x));
        expect(TIERS).toContain(resolveCityTier(x));
        if (typeof x !== "string") {
          expect(resolveBudgetLevel(x)).toBe("mid");
          expect(resolveCityTier(x)).toBe("tier2");
        }
      }),
      { numRuns: 200 },
    );
    fc.assert(
      fc.property(fc.string(), (s) => {
        const v = s.trim().toLowerCase();
        if (!BUDGETS.includes(v as BudgetLevel)) expect(resolveBudgetLevel(s)).toBe("mid");
      }),
      { numRuns: 200 },
    );
    expect(resolveCityTier("Some Unknown Place")).toBe("tier2");
  });
});
