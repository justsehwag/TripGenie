import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  ESTIMATED_BASIS,
  PRICE_MAX_INR,
  validatePrices,
  type WebValidation,
} from "@/lib/price-validator";
import { webBoundFor } from "@/lib/cost-caps";
import type { EvidenceSet } from "@/lib/web-pricing/evidence";
import type { WebCheckContext } from "@/lib/web-pricing/citation";

interface Act {
  id: string;
}

const URL_OK = "https://asi.example.org/fort-fees";
const CHECKED = Date.UTC(2025, 2, 12, 9, 0, 0);

function evidence(text: string): EvidenceSet {
  return {
    key: "k",
    kind: "entry-fee",
    checkedAtMs: CHECKED,
    snippets: [{ title: "Fort fees", text, url: URL_OK, host: "asi.example.org" }],
  };
}

function web(set: EvidenceSet | undefined): WebValidation<Act> {
  const ctx: WebCheckContext | undefined = set
    ? {
        evidence: set,
        kind: "entry-fee",
        costClass: "paid-sight",
        costBasis: "person",
        budget: "mid",
        tier: "tier2",
      }
    : undefined;
  return { contextFor: () => ctx };
}

const est = () => 77;
const acts = (n: number): Act[] => Array.from({ length: n }, (_, i) => ({ id: `a${i}` }));

describe("Feature: web-grounded-pricing, Property 18: Validation is total and every activity gets exactly one price", () => {
  it("never throws and returns one bounded result per activity in order", () => {
    const entry = fc.record(
      {
        id: fc.oneof(fc.constantFrom("a0", "a1", "a2", "zz"), fc.anything()),
        inr: fc.oneof(fc.integer({ min: -50, max: 10_000_000 }), fc.double(), fc.anything()),
        basis: fc.anything(),
        source: fc.oneof(fc.constant("web"), fc.constant("ai"), fc.anything()),
        sourceUrl: fc.oneof(fc.constant(URL_OK), fc.string(), fc.anything()),
        unit: fc.anything(),
      },
      { requiredKeys: [] },
    );
    const raw = fc.oneof(
      fc.anything(),
      fc.jsonValue(),
      fc.string(),
      fc.constant(undefined),
      fc.record({ prices: fc.oneof(fc.array(entry, { maxLength: 8 }), fc.anything()) }),
      fc
        .array(entry, { maxLength: 8 })
        .map((p) => "noise " + JSON.stringify({ prices: p }) + " tail"),
    );
    fc.assert(
      fc.property(
        raw,
        fc.integer({ min: 0, max: 4 }),
        fc.boolean(),
        (r, n, withEvidence) => {
          const list = acts(n);
          const set = evidence("Entry fee INR 50 per person for Indians.");
          const out = validatePrices(r, list, est, withEvidence ? web(set) : undefined);
          expect(out).toHaveLength(list.length);
          const bound = webBoundFor("paid-sight", "mid", "tier2");
          out.forEach((p, i) => {
            expect(p.id).toBe(list[i].id);
            expect(Number.isFinite(p.inr)).toBe(true);
            expect(p.inr).toBeGreaterThanOrEqual(0);
            expect(p.inr).toBeLessThanOrEqual(PRICE_MAX_INR);
            if (p.source === "web") expect(p.inr).toBeLessThanOrEqual(bound);
          });
        },
      ),
      { numRuns: 200 },
    );
  });

  it("keeps source ai for entries without source web", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5000 }), (inr) => {
        const out = validatePrices(
          { prices: [{ id: "a0", inr, basis: "ok" }] },
          acts(1),
          est,
          web(evidence("INR 50 entry")),
        );
        expect(out[0].source).toBe("ai");
        expect(out[0].inr).toBe(inr);
      }),
      { numRuns: 100 },
    );
  });

  it("rejected web entries become estimated with the cap-table estimate", () => {
    const bad = [
      { id: "a0", inr: 50, source: "web", sourceUrl: "https://other.example.com/x" },
      { id: "a0", inr: 999, source: "web", sourceUrl: URL_OK },
      { id: "a0", inr: 0, source: "web", sourceUrl: URL_OK },
    ];
    for (const e of bad) {
      const out = validatePrices(
        { prices: [e] },
        acts(1),
        est,
        web(evidence("Entry fee INR 50 per person.")),
      );
      expect(out[0]).toEqual({ id: "a0", inr: 77, basis: ESTIMATED_BASIS, source: "estimated" });
    }
    // no evidence context at all
    const out = validatePrices(
      { prices: [{ id: "a0", inr: 50, source: "web", sourceUrl: URL_OK }] },
      acts(1),
      est,
      web(undefined),
    );
    expect(out[0].source).toBe("estimated");
    expect(out[0].inr).toBe(77);
  });
});

describe("Feature: web-grounded-pricing, Property 19: The server owns host, time and basis (result level)", () => {
  it("ignores model-supplied host, time and basis and carries no snippet text", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.string(),
        fc.integer({ min: 1, max: 400 }),
        (host, checkedAt, basis, inr) => {
          const text = `Ticket price is INR ${inr} per person for Indians. Open daily.`;
          const out = validatePrices(
            {
              prices: [
                { id: "a0", inr, source: "web", sourceUrl: URL_OK, sourceHost: host, checkedAt, basis },
              ],
            },
            acts(1),
            est,
            web(evidence(text)),
          );
          const p = out[0];
          expect(p.source).toBe("web");
          expect(p.sourceUrl).toBe(URL_OK);
          expect(p.sourceHost).toBe(new URL(p.sourceUrl as string).hostname);
          expect(p.checkedAt).toBe(new Date(CHECKED).toISOString());
          expect(p.basis.length).toBeLessThanOrEqual(120);
          expect(p.basis.endsWith(`per ${p.sourceHost}`)).toBe(true);
          expect(p.basis.startsWith(`INR ${inr} `)).toBe(true);
          expect(JSON.stringify(p)).not.toContain("Open daily");
          expect(p.basis).not.toMatch(/confirmed|bookable/i);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("uses 'Free, per <host>' for a stated free entry", () => {
    const out = validatePrices(
      { prices: [{ id: "a0", inr: 0, source: "web", sourceUrl: URL_OK }] },
      acts(1),
      est,
      web(evidence("Free entry for all visitors.")),
    );
    expect(out[0].source).toBe("web");
    expect(out[0].inr).toBe(0);
    expect(out[0].basis).toBe("Free, per asi.example.org");
  });
});
