import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { PRICE_MAX_INR, BASIS_MAX, validatePrices, extractFirstJsonObject } from "../lib/price-validator";

interface Act {
  id: string;
}

// Feature: trip-planning-v2, Property 8: Price validation is total and well-shaped
describe("Feature: trip-planning-v2, Property 8: Price validation is total and well-shaped", () => {
  const activitiesArb = fc
    .uniqueArray(fc.string({ maxLength: 8 }), { maxLength: 12 })
    .map((ids): Act[] => ids.map((id) => ({ id })));

  const numberishArb = fc.oneof(
    fc.double({ noNaN: false }),
    fc.integer(),
    fc.constantFrom(NaN, Infinity, -Infinity, -1, 0, 1e12, Number.MAX_VALUE),
  );

  // Estimate functions: finite, non-finite, wrong type, or throwing.
  const estimateArb: fc.Arbitrary<(a: Act) => number> = fc.oneof(
    numberishArb.map((n) => (_a: Act) => n),
    fc.anything().map((v) => (_a: Act) => v as unknown as number),
    fc.constant((_a: Act): number => {
      throw new Error("estimate failed");
    }),
  );

  const entryArb = (ids: string[]) =>
    fc.oneof(
      fc.anything(),
      fc.record(
        {
          id: ids.length > 0 ? fc.oneof(fc.constantFrom(...ids), fc.anything()) : fc.anything(),
          inr: fc.oneof(numberishArb, fc.anything()),
          basis: fc.oneof(fc.string({ maxLength: 300 }), fc.fullUnicodeString({ maxLength: 300 }), fc.anything()),
        },
        { requiredKeys: [] },
      ),
    );

  // Raw values: any type, JSON-ish objects with a prices array, and strings wrapping such objects.
  const rawArb = (ids: string[]): fc.Arbitrary<unknown> => {
    const structured = fc.record(
      { prices: fc.oneof(fc.array(entryArb(ids), { maxLength: 20 }), fc.anything()) },
      { requiredKeys: [] },
    );
    return fc.oneof(
      fc.anything(),
      fc.constant(undefined),
      structured,
      structured.map((o) => {
        try {
          return `Here you go: ${JSON.stringify(o)} thanks`;
        } catch {
          return "{";
        }
      }),
      fc.string({ maxLength: 100 }),
    );
  };

  it("never throws and returns well-shaped results, one per activity in order", () => {
    fc.assert(
      fc.property(
        activitiesArb.chain((acts) =>
          fc.tuple(fc.constant(acts), rawArb(acts.map((a) => a.id)), estimateArb),
        ),
        ([acts, raw, estimate]) => {
          const out = validatePrices(raw, acts, estimate);

          expect(out).toHaveLength(acts.length);
          out.forEach((r, i) => {
            expect(r.id).toBe(acts[i].id);
            expect(Number.isInteger(r.inr)).toBe(true);
            expect(r.inr).toBeGreaterThanOrEqual(0);
            expect(r.inr).toBeLessThanOrEqual(PRICE_MAX_INR);
            expect(typeof r.basis).toBe("string");
            expect(r.basis.trim().length).toBeGreaterThan(0);
            expect(r.basis.length).toBeLessThanOrEqual(BASIS_MAX);
            expect(["ai", "estimated"]).toContain(r.source);
          });
        },
      ),
      { numRuns: 200 },
    );
  });

  it("accepts a well-formed prices array as source ai", () => {
    const out = validatePrices(
      { prices: [{ id: "a", inr: 499.6, basis: "  Entry   ticket " }] },
      [{ id: "a" }, { id: "b" }],
      () => 100,
    );
    expect(out[0]).toMatchObject({ id: "a", inr: 500, basis: "Entry ticket", source: "ai" });
    expect(out[1]).toMatchObject({ id: "b", inr: 100, source: "estimated" });
  });
});

// Feature: trip-planning-v2, Property 9: First balanced JSON object extraction
describe("Feature: trip-planning-v2, Property 9: First balanced JSON object extraction", () => {
  const noBrace = fc.string({ maxLength: 60 }).filter((s) => !s.includes("{"));
  const jsonObjectArb = fc.dictionary(fc.string({ maxLength: 8 }), fc.jsonValue({ maxDepth: 3 }), { maxKeys: 6 });
  const normalize = (o: unknown) => JSON.parse(JSON.stringify(o));

  it("returns the original object for prefix/suffix without braces, plain or fenced", () => {
    fc.assert(
      fc.property(jsonObjectArb, noBrace, noBrace, fc.boolean(), (obj, prefix, suffix, fenced) => {
        const json = JSON.stringify(obj);
        const text = fenced
          ? `${prefix}\n\`\`\`json\n${json}\n\`\`\`\n${suffix}`
          : `${prefix}${json}${suffix}`;
        expect(extractFirstJsonObject(text)).toEqual(normalize(obj));
      }),
      { numRuns: 200 },
    );
  });

  it("returns null and marks every activity estimated when no object is parsable", () => {
    fc.assert(
      fc.property(
        noBrace,
        fc.uniqueArray(fc.string({ maxLength: 6 }), { maxLength: 8 }),
        (text, ids) => {
          expect(extractFirstJsonObject(text)).toBeNull();
          const acts = ids.map((id) => ({ id }));
          const out = validatePrices(text, acts, () => 7);
          expect(out).toHaveLength(acts.length);
          out.forEach((r, i) => {
            expect(r.id).toBe(acts[i].id);
            expect(r.source).toBe("estimated");
            expect(r.inr).toBe(7);
          });
        },
      ),
      { numRuns: 200 },
    );
  });

  it("handles stray braces in prose before the object", () => {
    const text = 'Note {not json} and a lone } or { here. {"prices":[{"id":"a","inr":50,"basis":"x"}]} done';
    expect(extractFirstJsonObject(text)).toEqual({ prices: [{ id: "a", inr: 50, basis: "x" }] });
    const out = validatePrices(text, [{ id: "a" }], () => 1);
    expect(out[0]).toMatchObject({ id: "a", inr: 50, source: "ai" });
  });

  it("rejects a string inr value (\"1200\") as estimated", () => {
    const out = validatePrices({ prices: [{ id: "a", inr: "1200", basis: "x" }] }, [{ id: "a" }], () => 300);
    expect(out[0]).toMatchObject({ id: "a", inr: 300, source: "estimated" });
  });

  it("clamps 1e9 to 1,000,000", () => {
    const out = validatePrices('{"prices":[{"id":"a","inr":1e9,"basis":"x"}]}', [{ id: "a" }], () => 1);
    expect(out[0]).toMatchObject({ id: "a", inr: 1_000_000, source: "ai" });
  });
});

// Feature: trip-planning-v2, Property 10: Entry-level validation and unknown ids
describe("Feature: trip-planning-v2, Property 10: Entry-level validation and unknown ids", () => {
  type Kind = "valid" | "negative" | "nan" | "nonNumeric" | "missing";
  interface Spec {
    kind: Kind;
    value: number;
  }

  const specArb: fc.Arbitrary<Spec> = fc.record({
    kind: fc.constantFrom<Kind>("valid", "negative", "nan", "nonNumeric", "missing"),
    value: fc.oneof(
      fc.double({ min: 0, max: 5_000_000, noNaN: true }),
      fc.integer({ min: 0, max: 2_000 }),
    ),
  });

  const nonNumericArb = fc.constantFrom<unknown>("1200", "", null, true, [], {}, undefined, Infinity, -Infinity);

  const toEntry = (id: string, s: Spec, nonNum: unknown): Record<string, unknown> => {
    const base: Record<string, unknown> = { id, basis: "basis" };
    switch (s.kind) {
      case "valid":
        return { ...base, inr: s.value };
      case "negative":
        return { ...base, inr: -(s.value + 0.5) };
      case "nan":
        return { ...base, inr: NaN };
      case "nonNumeric":
        return { ...base, inr: nonNum };
      default:
        return base; // missing inr
    }
  };

  const scenarioArb = fc.record({
    n: fc.integer({ min: 0, max: 8 }),
    // Per activity: 0..3 entries (0 = absent, >1 = duplicated).
    perId: fc.array(fc.array(specArb, { maxLength: 3 }), { minLength: 8, maxLength: 8 }),
    nonNum: nonNumericArb,
    unknowns: fc.array(
      fc.record({ suffix: fc.string({ maxLength: 5 }), spec: specArb }),
      { maxLength: 8 },
    ),
  });

  const estimate = (a: Act) => a.id.length * 10;

  it("is 'ai' iff exactly one valid entry, else 'estimated'; unknown ids change nothing", () => {
    fc.assert(
      fc.property(scenarioArb, (sc) => {
        const acts: Act[] = Array.from({ length: sc.n }, (_, i) => ({ id: `act-${i}` }));
        const known: Record<string, unknown>[] = [];
        acts.forEach((a, i) => sc.perId[i].forEach((s) => known.push(toEntry(a.id, s, sc.nonNum))));

        // Unknown ids are guaranteed not to collide with requested ids.
        const unknown = sc.unknowns.map((u) => toEntry(`unknown:${u.suffix}`, u.spec, sc.nonNum));
        const mixed = [...unknown.slice(0, Math.ceil(unknown.length / 2)), ...known, ...unknown.slice(Math.ceil(unknown.length / 2))];

        const base = validatePrices({ prices: known }, acts, estimate);
        const withUnknown = validatePrices({ prices: mixed }, acts, estimate);

        expect(withUnknown).toEqual(base);
        expect(base).toHaveLength(acts.length);

        acts.forEach((a, i) => {
          const specs = sc.perId[i];
          const r = base[i];
          expect(r.id).toBe(a.id);
          if (specs.length === 1 && specs[0].kind === "valid") {
            expect(r.source).toBe("ai");
            expect(r.inr).toBe(Math.round(Math.min(specs[0].value, PRICE_MAX_INR)));
          } else {
            expect(r.source).toBe("estimated");
            expect(r.inr).toBe(estimate(a));
          }
        });
      }),
      { numRuns: 200 },
    );
  });

  it("a duplicated id is estimated even when both entries are valid", () => {
    const out = validatePrices(
      {
        prices: [
          { id: "a", inr: 10, basis: "x" },
          { id: "a", inr: 20, basis: "y" },
        ],
      },
      [{ id: "a" }],
      () => 99,
    );
    expect(out[0]).toMatchObject({ id: "a", inr: 99, source: "estimated" });
  });

  it("ignores entries for unrequested ids", () => {
    const out = validatePrices({ prices: [{ id: "zzz", inr: 5, basis: "x" }] }, [{ id: "a" }], () => 42);
    expect(out).toEqual([
      { id: "a", inr: 42, basis: "Typical cost for this kind of activity, converted to INR.", source: "estimated" },
    ]);
  });
});
