import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { AIRPORTS, resolveAirport } from "@/lib/airports";

// Feature: live-travel-pricing, Property 1: Airport resolution is case- and whitespace-insensitive

const TABLE_NAMES = new Set(
  AIRPORTS.flatMap((e) => e.names.map((n) => n.trim().replace(/\s+/g, " ").toLowerCase())),
);

const WS_CHARS = [" ", "\t", "\n", "\r", "\u00a0"];
const wsRun = (min: number) =>
  fc.array(fc.constantFrom(...WS_CHARS), { minLength: min, maxLength: 4 }).map((a) => a.join(""));

/** Randomise letter case of a string, character by character. */
const randomCase = (s: string) =>
  fc
    .array(fc.boolean(), { minLength: s.length, maxLength: s.length })
    .map((flags) => [...s].map((ch, i) => (flags[i] ? ch.toUpperCase() : ch.toLowerCase())).join(""));

/** Case, padding and internal-whitespace-run variant of a single-spaced term. */
const variantOf = (term: string) =>
  fc
    .tuple(
      randomCase(term),
      wsRun(0),
      wsRun(0),
      fc.array(wsRun(1), { minLength: term.length, maxLength: term.length }),
    )
    .map(([cased, lead, trail, runs]) => {
      let i = 0;
      const inner = cased.split(" ").join("\u0000").replace(/\u0000/g, () => runs[i++]);
      return lead + inner + trail;
    });

const entryAndTerm = fc
  .constantFrom(...AIRPORTS)
  .chain((entry) => fc.constantFrom(entry.code, ...entry.names).map((term) => ({ entry, term })));

const threeAlphaNotName = fc
  .stringMatching(/^[a-zA-Z]{3}$/)
  .filter((s) => !TABLE_NAMES.has(s.toLowerCase()));

describe("Feature: live-travel-pricing, airport resolution", () => {
  it("Property 1: table names and codes resolve regardless of case and whitespace", () => {
    fc.assert(
      fc.property(
        entryAndTerm.chain(({ entry, term }) => variantOf(term).map((input) => ({ entry, input }))),
        ({ entry, input }) => {
          expect(resolveAirport(input)).toBe(entry.code);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("Property 1: three-letter alphabetic non-names resolve to themselves in upper case", () => {
    fc.assert(
      fc.property(threeAlphaNotName, wsRun(0), wsRun(0), (s, lead, trail) => {
        expect(resolveAirport(lead + s + trail)).toBe(s.toUpperCase());
      }),
      { numRuns: 200 },
    );
  });

  it("examples: table names win over the bare 3-letter rule, and the City (ABC) suffix", () => {
    expect(resolveAirport("Goa")).toBe("GOI");
    expect(resolveAirport("Leh")).toBe("IXL");
    expect(resolveAirport("Mumbai (BOM)")).toBe("BOM");
  });
});
