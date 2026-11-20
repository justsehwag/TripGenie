import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { classifyActivity, basisFor, isPriceable } from "../lib/cost-classifier";
import type { CostClass } from "../lib/cost-caps";

const CLASSES: CostClass[] = [
  "stay-checkin", "route-transport", "shopping", "free-sight",
  "paid-sight", "meal", "local-transfer", "other",
];
const CATEGORIES = ["transfer", "meal", "sight", "other", undefined] as const;
const VEHICLE_RE = /\b(cab|taxi|auto|private car|driver)\b/i;

describe("classifyActivity examples", () => {
  const ctx = { origin: "Chennai", destination: "Vaniyambadi" };
  it.each([
    ["Private Car Transfer from Chennai", "route-transport"],
    ["Check-in at Sterling Yelagiri Resort", "stay-checkin"],
    ["Vaniyambadi Fort Exploration", "free-sight"],
    ["Leather Shopping at Gandhi Road Market", "shopping"],
    ["Dinner at Hotel Saravana Bhavan", "meal"],
  ] as const)("%s -> %s", (title, expected) => {
    expect(classifyActivity({ title }, ctx)).toBe(expected);
  });

  it("only local transfers naming a hired vehicle are group basis", () => {
    expect(basisFor("local-transfer", "Cab to the lake")).toBe("group");
    expect(basisFor("local-transfer", "Metro ride")).toBe("person");
    expect(basisFor("meal", "Cab dinner")).toBe("person");
  });
});

describe("classifier properties", () => {
  // Feature: web-grounded-pricing, Property 1: Classification is total and non-priceable rows are excluded
  it("always returns exactly one Cost_Class and never throws", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.fullUnicodeString(), fc.string({ minLength: 500, maxLength: 2000 })),
        fc.constantFrom(...CATEGORIES),
        fc.record({ origin: fc.option(fc.string(), { nil: undefined }), destination: fc.option(fc.string(), { nil: undefined }) }),
        (title, category, ctx) => {
          const c = classifyActivity({ title, category: category as never }, ctx);
          expect(CLASSES).toContain(c);
          expect(typeof isPriceable(c)).toBe("boolean");
        },
      ),
      { numRuns: 200 },
    );
  });

  it("basisFor returns group only for local-transfer titles naming a hired vehicle", () => {
    fc.assert(
      fc.property(fc.constantFrom(...CLASSES), fc.string(), (c, title) => {
        const b = basisFor(c, title);
        expect(["person", "group"]).toContain(b);
        if (b === "group") {
          expect(c).toBe("local-transfer");
          expect(VEHICLE_RE.test(title)).toBe(true);
        } else if (c === "local-transfer" && VEHICLE_RE.test(title)) {
          expect.fail("vehicle title must be group");
        }
      }),
      { numRuns: 200 },
    );
  });

  it("isPriceable is false exactly for stay-checkin, route-transport and shopping", () => {
    for (const c of CLASSES) {
      expect(isPriceable(c)).toBe(!["stay-checkin", "route-transport", "shopping"].includes(c));
    }
  });
});
