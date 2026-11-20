import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { extractPrices, MAX_CANDIDATES } from "../lib/price-extractor";
import { PRICE_MAX_INR } from "../lib/price-validator";

const RUNS = { numRuns: 150 };

const amounts = (t: string) => extractPrices(t).candidates.map((c) => [c.min, c.max]);

// ---------- helpers ----------
function western(n: number): string {
  return n.toLocaleString("en-US");
}
function indian(n: number): string {
  const s = String(n);
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  let rest = s.slice(0, -3);
  const parts: string[] = [];
  while (rest.length > 2) {
    parts.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) parts.unshift(rest);
  return `${parts.join(",")},${last3}`;
}
const groupings = [String, western, indian] as const;

const amountArb = fc.integer({ min: 0, max: PRICE_MAX_INR });
const groupArb = fc.constantFrom(...groupings);
const caseArb = fc.constantFrom<(s: string) => string>(
  (s) => s,
  (s) => s.toLowerCase(),
  (s) => s.toUpperCase(),
);
const fillerArb = fc.constantFrom("Entry fee:", "Tickets cost", "The fee is", "Adults pay", "Price");
const trailArb = fc.constantFrom("", " at the gate", " for adults", " today");

const singleForms: Array<(n: string) => string> = [
  (n) => `₹${n}`,
  (n) => `₹ ${n}`,
  (n) => `Rs. ${n}`,
  (n) => `Rs ${n}`,
  (n) => `INR ${n}`,
  (n) => `${n} INR`,
  (n) => `${n} rupees`,
  (n) => `${n}/-`,
];

const rangeForms: Array<(a: string, b: string) => string> = [
  (a, b) => `₹${a}-${b}`,
  (a, b) => `Rs. ${a} to ${b}`,
  (a, b) => `INR ${a} – ${b}`,
  (a, b) => `between ${a} and ${b} rupees`,
];

// ---------- examples (folded from price-extractor.examples.test.ts) ----------
describe("extractPrices examples", () => {
  it("finds a rupee sign amount", () => {
    expect(amounts("Entry ₹500 only")).toEqual([[500, 500]]);
  });
  it("finds ranges", () => {
    expect(amounts("Rs. 50 to 100")).toEqual([[50, 100]]);
    expect(amounts("between 50 and 100 rupees")).toEqual([[50, 100]]);
  });
  it("handles Indian grouping with suffix", () => {
    expect(amounts("1,20,000 INR")).toEqual([[120000, 120000]]);
  });
  it("ignores other currencies", () => {
    expect(amounts("Costs $20 or USD 30 or €5")).toEqual([]);
  });
  it("detects free entry", () => {
    expect(extractPrices("Free entry for all").freeEntry).toBe(true);
    expect(extractPrices("Open daily").freeEntry).toBe(false);
  });
  it("tags audiences in both clause orders", () => {
    const a = extractPrices("₹50 for Indians and ₹600 for foreigners").candidates;
    expect(a.map((c) => [c.min, c.audience])).toEqual([[50, "indian"], [600, "foreign"]]);
    const b = extractPrices("Indians ₹50, foreigners ₹600").candidates;
    expect(b.map((c) => [c.min, c.audience])).toEqual([[50, "indian"], [600, "foreign"]]);
  });
  it("tags units", () => {
    expect(extractPrices("₹400 per car").candidates[0].unit).toBe("vehicle");
    expect(extractPrices("₹40 per person").candidates[0].unit).toBe("person");
  });
  it("never throws on odd input", () => {
    expect(extractPrices(undefined as unknown as string).candidates).toEqual([]);
  });
});

// ---------- Property 14 ----------
describe("Feature: web-grounded-pricing, Property 14: The extractor is total and its output is well formed", () => {
  const fragment = fc.oneof(
    fc.string(),
    fc.string({ unit: "binary" }),
    fc.constantFrom("₹", "Rs.", "INR", "to", "-", "–", "between", "and", "per person", "free entry", " ", "$", "/-", ","),
    amountArb.map(String),
    amountArb.map((n) => `₹${western(n)}`),
    fc.tuple(amountArb, amountArb).map(([a, b]) => `Rs ${a}-${b}`),
  );
  const textArb = fc.array(fragment, { maxLength: 40 }).map((p) => p.join(" "));

  it("is total with well-formed output for any string", () => {
    fc.assert(
      fc.property(fc.oneof(textArb, fc.string({ maxLength: 300 }), fc.string({ unit: "binary", maxLength: 300 })), (text) => {
        const r = extractPrices(text);
        expect(r.candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES);
        expect(typeof r.freeEntry).toBe("boolean");
        const keys = new Set<string>();
        let prevIndex = -1;
        for (const c of r.candidates) {
          for (const v of [c.min, c.max]) {
            expect(Number.isFinite(v)).toBe(true);
            expect(Number.isInteger(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(PRICE_MAX_INR);
          }
          expect(c.min).toBeLessThanOrEqual(c.max);
          expect(c.index).toBeGreaterThanOrEqual(0);
          expect(c.end).toBeGreaterThan(c.index);
          expect(c.end).toBeLessThanOrEqual(text.length);
          expect(c.index).toBeGreaterThan(prevIndex);
          prevIndex = c.index;
          const key = `${c.min}|${c.max}|${c.unit}|${c.audience}`;
          expect(keys.has(key)).toBe(false);
          keys.add(key);
        }
      }),
      RUNS,
    );
  });

  it("never throws for non-string input", () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        const r = extractPrices(v as unknown as string);
        expect(Array.isArray(r.candidates)).toBe(true);
      }),
      RUNS,
    );
  });

  it("drops amounts above PRICE_MAX_INR", () => {
    fc.assert(
      fc.property(fc.integer({ min: PRICE_MAX_INR + 1, max: PRICE_MAX_INR * 50 }), (n) => {
        expect(extractPrices(`₹${n}`).candidates).toEqual([]);
      }),
      RUNS,
    );
  });

  it("each index points at the start of its match", () => {
    fc.assert(
      fc.property(amountArb, fillerArb, (n, filler) => {
        const text = `${filler} ₹${n}`;
        const c = extractPrices(text).candidates[0];
        expect(c).toBeDefined();
        expect(c.index).toBe(text.indexOf("₹"));
      }),
      RUNS,
    );
  });
});

// ---------- Property 15 ----------
describe("Feature: web-grounded-pricing, Property 15: The extractor finds every supported amount format", () => {
  it("finds a single amount in every supported form, case and grouping", () => {
    fc.assert(
      fc.property(
        amountArb,
        fc.integer({ min: 0, max: singleForms.length - 1 }),
        groupArb,
        caseArb,
        fillerArb,
        trailArb,
        (n, formIdx, group, casing, filler, trail) => {
          const text = `${filler} ${casing(singleForms[formIdx](group(n)))}${trail}`;
          const found = extractPrices(text).candidates;
          expect(found.some((c) => c.min === n && c.max === n)).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it("returns one range candidate for each supported range form", () => {
    fc.assert(
      fc.property(
        fc.tuple(amountArb, amountArb),
        fc.integer({ min: 0, max: rangeForms.length - 1 }),
        groupArb,
        caseArb,
        fillerArb,
        trailArb,
        ([x, y], formIdx, group, casing, filler, trail) => {
          const lo = Math.min(x, y);
          const hi = Math.max(x, y);
          const text = `${filler} ${casing(rangeForms[formIdx](group(lo), group(hi)))}${trail}`;
          const found = extractPrices(text).candidates;
          expect(found).toHaveLength(1);
          expect(found[0].min).toBe(lo);
          expect(found[0].max).toBe(hi);
        },
      ),
      RUNS,
    );
  });

  it("ignores amounts written only in other currencies", () => {
    const foreign: Array<(n: number) => string> = [
      (n) => `$${n}`,
      (n) => `$ ${n}`,
      (n) => `USD ${n}`,
      (n) => `US$ ${n}`,
      (n) => `EUR ${n}`,
      (n) => `£${n}`,
      (n) => `€${n}`,
    ];
    fc.assert(
      fc.property(amountArb, fc.integer({ min: 0, max: foreign.length - 1 }), fillerArb, (n, i, filler) => {
        expect(extractPrices(`${filler} ${foreign[i](n)} per ticket`).candidates).toEqual([]);
      }),
      RUNS,
    );
  });
});

// ---------- Property 16 ----------
describe("Feature: web-grounded-pricing, Property 16: Unit, audience and free-entry tagging", () => {
  const personPhrases = ["per person", "per head", "per adult", "each", "pp"];
  const vehiclePhrases = ["per vehicle", "per car", "per cab", "per taxi", "per trip"];

  it("tags person, vehicle and unknown units", () => {
    fc.assert(
      fc.property(
        amountArb,
        fc.constantFrom(...personPhrases),
        fc.constantFrom(...vehiclePhrases),
        (n, p, v) => {
          expect(extractPrices(`₹${n} ${p}`).candidates[0].unit).toBe("person");
          expect(extractPrices(`₹${n} ${v}`).candidates[0].unit).toBe("vehicle");
          expect(extractPrices(`₹${n} entry`).candidates[0].unit).toBe("unknown");
        },
      ),
      RUNS,
    );
  });

  it("tags the audience named in the same clause", () => {
    fc.assert(
      fc.property(amountArb, amountArb, (a, b) => {
        expect(extractPrices(`₹${a} for Indians`).candidates[0].audience).toBe("indian");
        expect(extractPrices(`₹${a} for foreigners`).candidates[0].audience).toBe("foreign");
        expect(extractPrices(`₹${a} for adults`).candidates[0].audience).toBe("unspecified");
        const both = extractPrices(`₹${a} for Indians and ₹${b} for foreigners`).candidates;
        const ind = both.find((c) => c.audience === "indian");
        const frn = both.find((c) => c.audience === "foreign");
        expect(ind?.min).toBe(a);
        expect(frn?.min).toBe(b);
        const lead = extractPrices(`Indians ₹${a}, foreigners ₹${b}`).candidates;
        expect(lead.find((c) => c.audience === "indian")?.min).toBe(a);
        expect(lead.find((c) => c.audience === "foreign")?.min).toBe(b);
      }),
      RUNS,
    );
  });

  const markers = ["free entry", "entry is free", "free of cost", "free admission", "no entry fee", "no entrance fee"];

  it("sets freeEntry for every marker in any letter case", () => {
    fc.assert(
      fc.property(fc.constantFrom(...markers), caseArb, fc.string({ maxLength: 20 }), fc.string({ maxLength: 20 }), (m, casing, pre, post) => {
        expect(extractPrices(`${pre} ${casing(m)} ${post}`).freeEntry).toBe(true);
      }),
      RUNS,
    );
  });

  it("leaves freeEntry false when no marker is present", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 120 }).filter((s) => !markers.some((m) => s.toLowerCase().includes(m))),
        (s) => {
          expect(extractPrices(s).freeEntry).toBe(false);
        },
      ),
      RUNS,
    );
  });
});
