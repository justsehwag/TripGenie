import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  buildWebBasis,
  checkRouteFare,
  checkWebCitation,
  ROUTE_FARE_MAX_INR,
  type WebCheckContext,
} from "../lib/web-pricing/citation";
import type { EvidenceSet, EvidenceSnippet } from "../lib/web-pricing/evidence";
import { VEHICLE_SEATS, webBoundFor } from "../lib/cost-caps";
import { normalizeUrlForCompare } from "../lib/grounding/bundle";

const RUNS = { numRuns: 150 };
const CHECKED_AT = Date.UTC(2025, 2, 12, 9, 0, 0);

function snip(i: number, text: string, title = "Fort tickets"): EvidenceSnippet {
  return { title, text, url: `https://site${i}.example.org/p${i}`, host: `site${i}.example.org` };
}
function mkSet(
  snippets: EvidenceSnippet[],
  kind: EvidenceSet["kind"] = "entry-fee",
  checkedAtMs = CHECKED_AT,
): EvidenceSet {
  return { key: `${kind}|k`, kind, snippets, checkedAtMs };
}
function ctxFor(
  evidence: EvidenceSet | undefined,
  over: Partial<WebCheckContext> = {},
): WebCheckContext {
  return {
    evidence,
    kind: "entry-fee",
    costClass: "paid-sight",
    costBasis: "person",
    budget: "mid",
    tier: "tier2",
    ...over,
  };
}
const BOUND = webBoundFor("paid-sight", "mid", "tier2");

const amountsArb = fc.array(fc.integer({ min: 1, max: 1500 }), { minLength: 0, maxLength: 5 });
function textOf(amounts: number[], free: boolean): string {
  const parts = amounts.map((a) => `Rs. ${a}`);
  const body = parts.length ? `Entry ticket ${parts.join(". Also ")}.` : "Visitor information.";
  return free ? `${body} Free entry for all visitors.` : body;
}

// Feature: web-grounded-pricing, Property 17: Citation soundness
describe("Property 17: citation soundness", () => {
  it("accepts only supplied URLs with a verifiable amount within the bound", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(amountsArb, fc.boolean()), { minLength: 1, maxLength: 3 }),
        fc.nat(5),
        fc.boolean(),
        fc.webUrl({ validSchemes: ["https"] }),
        fc.integer({ min: 0, max: 1500 }),
        fc.record({ h: fc.string(), t: fc.string(), b: fc.string() }),
        (specs, pick, useSupplied, foreignUrl, inr, junk) => {
          const snippets = specs.map(([a, f], i) => snip(i, textOf(a, f)));
          const set = mkSet(snippets);
          const idx = pick % snippets.length;
          const url = useSupplied ? snippets[idx].url : foreignUrl;
          const v = checkWebCitation(
            { source: "web", sourceUrl: url, inr, sourceHost: junk.h, checkedAt: junk.t, basis: junk.b },
            ctxFor(set),
          );
          const supplied = snippets.find(
            (s) => normalizeUrlForCompare(s.url) === normalizeUrlForCompare(url),
          );
          if (!v.ok) return true;
          expect(supplied).toBeDefined();
          expect(v.price.sourceUrl).toBe(supplied!.url);
          expect(v.price.inr).toBeLessThanOrEqual(BOUND);
          const i = snippets.indexOf(supplied!);
          const [amounts, free] = specs[i];
          if (v.price.inr === 0) {
            expect(free).toBe(true);
            expect(amounts.length).toBe(0);
          } else {
            expect(amounts).toContain(v.price.inr);
          }
          return true;
        },
      ),
      RUNS,
    );
  });

  it("accepts every supplied, in-bound, listed amount (person basis)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: BOUND }), { minLength: 1, maxLength: 5 }),
        fc.nat(4),
        (amounts, pick) => {
          const set = mkSet([snip(0, textOf(amounts, false))]);
          const inr = amounts[pick % amounts.length];
          const v = checkWebCitation({ source: "web", sourceUrl: set.snippets[0].url, inr }, ctxFor(set));
          expect(v.ok).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it("accepts person-unit amount times 4 for group basis when within the bound", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 600 }), (n) => {
        const set = mkSet([snip(0, `Cab fare Rs. ${n} per person for the ride.`)], "cab-fare");
        const c = ctxFor(set, { kind: "cab-fare", costClass: "local-transfer", costBasis: "group" });
        const inr = n * VEHICLE_SEATS;
        const v = checkWebCitation({ source: "web", sourceUrl: set.snippets[0].url, inr }, c);
        const bound = webBoundFor("local-transfer", "mid", "tier2");
        expect(v.ok).toBe(inr <= bound);
        // The raw per-person amount is never what a group price equals.
        if (!v.ok) expect(["over-bound", "amount-not-found"]).toContain(v.reason);
      }),
      RUNS,
    );
  });

  it("rejects an amount above the Web_Sanity_Bound even when the snippet shows it", () => {
    fc.assert(
      fc.property(fc.integer({ min: BOUND + 1, max: 90_000 }), (n) => {
        const set = mkSet([snip(0, `Entry Rs. ${n}.`)]);
        const v = checkWebCitation({ source: "web", sourceUrl: set.snippets[0].url, inr: n }, ctxFor(set));
        expect(v).toEqual({ ok: false, reason: "over-bound" });
      }),
      RUNS,
    );
  });

  it("never throws for arbitrary entries and contexts", () => {
    fc.assert(
      fc.property(fc.anything(), (entry) => {
        const set = mkSet([snip(0, "Entry Rs. 50.")]);
        const v = checkWebCitation(entry, ctxFor(set));
        expect(typeof v.ok).toBe("boolean");
        checkWebCitation(entry, ctxFor(undefined));
      }),
      RUNS,
    );
  });

  describe("examples", () => {
    const set = mkSet([snip(0, "Entry fee Rs. 50 per person.")]);
    const url = set.snippets[0].url;

    it("rejects a URL that was not supplied", () => {
      const v = checkWebCitation(
        { source: "web", sourceUrl: "https://evil.example.com/page", inr: 50 },
        ctxFor(set),
      );
      expect(v).toEqual({ ok: false, reason: "url-not-supplied" });
    });

    it("rejects a real URL with an amount not in the snippet", () => {
      const v = checkWebCitation({ source: "web", sourceUrl: url, inr: 75 }, ctxFor(set));
      expect(v).toEqual({ ok: false, reason: "amount-not-found" });
    });

    it("accepts the listed amount and builds the server-side fields", () => {
      const v = checkWebCitation({ source: "web", sourceUrl: url, inr: 50 }, ctxFor(set));
      expect(v.ok).toBe(true);
      if (v.ok) {
        expect(v.price.sourceHost).toBe("site0.example.org");
        expect(v.price.checkedAt).toBe(new Date(CHECKED_AT).toISOString());
        expect(v.price.basis).toBe("INR 50 entry, per site0.example.org");
      }
    });

    it("rejects 0 for 'free entry for children, INR 50 adults'", () => {
      const s = mkSet([snip(0, "Free entry for children, INR 50 adults.")]);
      const v = checkWebCitation({ source: "web", sourceUrl: s.snippets[0].url, inr: 0 }, ctxFor(s));
      expect(v).toEqual({ ok: false, reason: "free-not-stated" });
    });

    it("accepts 0 when the snippet only states free entry", () => {
      const s = mkSet([snip(0, "Entry is free for all visitors.")]);
      const v = checkWebCitation({ source: "web", sourceUrl: s.snippets[0].url, inr: 0 }, ctxFor(s));
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.price.basis).toBe("Free, per site0.example.org");
    });

    it("rejects a price quoted for two people", () => {
      const s = mkSet([snip(0, "Entry INR 500 for two people.")]);
      const v = checkWebCitation({ source: "web", sourceUrl: s.snippets[0].url, inr: 500 }, ctxFor(s));
      expect(v).toEqual({ ok: false, reason: "party-price" });
    });

    it("rejects a foreign price when an Indian price is also quoted", () => {
      const s = mkSet([snip(0, "Entry Rs. 50 for Indians and Rs. 600 for foreigners.")]);
      const v = checkWebCitation({ source: "web", sourceUrl: s.snippets[0].url, inr: 600 }, ctxFor(s));
      expect(v.ok).toBe(false);
    });

    it("rejects entries without source web and missing evidence", () => {
      expect(checkWebCitation({ sourceUrl: url, inr: 50 }, ctxFor(set)).ok).toBe(false);
      expect(checkWebCitation({ source: "web", sourceUrl: url, inr: 50 }, ctxFor(undefined))).toEqual({
        ok: false,
        reason: "no-evidence",
      });
    });
  });
});

// Feature: web-grounded-pricing, Property 19: The server owns host, time and basis
describe("Property 19: the server owns host, time and basis (citation level)", () => {
  it("derives host, time and basis from the evidence, ignoring model-supplied values", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: BOUND }),
        fc.integer({ min: 0, max: Date.UTC(2100, 0, 1) }),
        fc.domain().filter((d) => d.length <= 60),
        fc.record({ h: fc.string(), t: fc.string(), b: fc.string({ maxLength: 300 }) }),
        fc.constantFrom("entry-fee", "meal", "cab-fare", "route-fare") as fc.Arbitrary<
          EvidenceSet["kind"]
        >,
        (n, ms, domain, junk, kind) => {
          const s: EvidenceSnippet = {
            title: "Tickets",
            text: `Price Rs. ${n}.`,
            url: `https://${domain}/page`,
            host: domain,
          };
          const set = mkSet([s], kind, ms);
          const v = checkWebCitation(
            { source: "web", sourceUrl: s.url, inr: n, sourceHost: junk.h, checkedAt: junk.t, basis: junk.b },
            ctxFor(set, { kind }),
          );
          expect(v.ok).toBe(true);
          if (!v.ok) return;
          const host = new URL(v.price.sourceUrl).hostname;
          expect(v.price.sourceHost).toBe(host);
          expect(v.price.checkedAt).toBe(new Date(ms).toISOString());
          expect(v.price.basis.length).toBeLessThanOrEqual(120);
          expect(v.price.basis.endsWith(`per ${host}`)).toBe(true);
          expect(v.price.basis.startsWith("INR ")).toBe(true);
          expect(v.price.basis).not.toContain(junk.b.length > 3 ? junk.b : "\u0000");
          expect(v.price.basis.replace(host, "")).not.toMatch(/confirmed|bookable/i);
        },
      ),
      RUNS,
    );
  });

  it("free basis is 'Free, per <host>' and buildWebBasis is always bounded", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.constantFrom("entry-fee", "meal", "cab-fare", "route-fare") as fc.Arbitrary<
          EvidenceSet["kind"]
        >,
        fc.string({ maxLength: 400 }),
        (inr, kind, host) => {
          const b = buildWebBasis(inr, kind, host);
          expect(b.length).toBeLessThanOrEqual(120);
          if (inr === 0 && host.length <= 100) expect(b).toBe(`Free, per ${host}`);
        },
      ),
      RUNS,
    );
  });
});

// Feature: web-grounded-pricing, Property 20: Route fares are accepted only when verifiable
describe("Property 20: route fares are accepted only when verifiable", () => {
  const rangeArb = fc
    .tuple(fc.integer({ min: 1, max: 3000 }), fc.integer({ min: 1, max: 3000 }))
    .map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as const);

  it("accepts a range only when every claim is backed by the cited snippet", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 3000 }), { minLength: 0, maxLength: 4 }),
        fc.option(rangeArb, { nil: undefined }),
        fc.constantFrom("bus", "train", "plane", 7, undefined),
        fc.integer({ min: -5, max: 9000 }),
        fc.integer({ min: -5, max: 9000 }),
        fc.boolean(),
        fc.boolean(),
        (amounts, range, mode, minInr, maxInr, useUrl, useBusSet) => {
          const parts = amounts.map((a) => `Rs. ${a}`);
          if (range) parts.push(`₹${range[0]}-${range[1]}`);
          const text = `Fare details: ${parts.join(". Also ")}.`;
          const busSet = mkSet([snip(1, text)], "route-fare", CHECKED_AT);
          const trainSet = mkSet([snip(2, "Nothing about prices here.")], "route-fare", CHECKED_AT + 1000);
          const sets = { bus: busSet, train: trainSet };
          const url = useUrl ? (useBusSet ? busSet.snippets[0].url : trainSet.snippets[0].url) : "https://x.example.com/";
          const out = checkRouteFare({ mode, minInr, maxInr, sourceUrl: url }, sets);
          if (!out) return;
          expect(out.mode === "bus" || out.mode === "train").toBe(true);
          expect(Number.isInteger(out.minInr) && Number.isInteger(out.maxInr)).toBe(true);
          expect(out.minInr).toBeGreaterThan(0);
          expect(out.minInr).toBeLessThanOrEqual(out.maxInr);
          expect(out.maxInr).toBeLessThanOrEqual(ROUTE_FARE_MAX_INR);
          const set = sets[out.mode];
          const found = set.snippets.find(
            (s) => normalizeUrlForCompare(s.url) === normalizeUrlForCompare(url),
          );
          expect(found).toBeDefined();
          expect(out.sourceUrl).toBe(found!.url);
          expect(out.sourceHost).toBe(new URL(found!.url).hostname);
          expect(out.checkedAt).toBe(new Date(set.checkedAtMs).toISOString());
          const all = new Set<number>(amounts);
          if (range) {
            all.add(range[0]);
            all.add(range[1]);
          }
          const asRange = !!range && range[0] === out.minInr && range[1] === out.maxInr;
          expect(asRange || (all.has(out.minInr) && all.has(out.maxInr))).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it("never throws for arbitrary input", () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        const s = mkSet([snip(1, "Rs. 100 to 300")], "route-fare");
        const out = checkRouteFare(raw, { bus: s, train: s });
        expect(out === undefined || typeof out === "object").toBe(true);
        checkRouteFare(raw, {});
      }),
      RUNS,
    );
  });

  describe("examples", () => {
    const bus = mkSet([snip(1, "Bus fare Rs. 120 to 350 per person.")], "route-fare");
    const url = bus.snippets[0].url;

    it("accepts both ends of one range", () => {
      const out = checkRouteFare({ mode: "bus", minInr: 120, maxInr: 350, sourceUrl: url }, { bus });
      expect(out).toMatchObject({ mode: "bus", minInr: 120, maxInr: 350, sourceHost: "site1.example.org" });
    });

    it("accepts two separate amounts in the snippet", () => {
      const s = mkSet([snip(1, "Sleeper Rs. 200. AC chair Rs. 600.")], "route-fare");
      const out = checkRouteFare(
        { mode: "train", minInr: 200, maxInr: 600, sourceUrl: s.snippets[0].url },
        { train: s },
      );
      expect(out).toBeDefined();
    });

    it("rejects an unsupported amount, an unsupplied URL, and an over-ceiling fare", () => {
      expect(checkRouteFare({ mode: "bus", minInr: 100, maxInr: 350, sourceUrl: url }, { bus })).toBeUndefined();
      expect(
        checkRouteFare({ mode: "bus", minInr: 120, maxInr: 350, sourceUrl: "https://other.example.com/" }, { bus }),
      ).toBeUndefined();
      const big = mkSet([snip(1, "Fare Rs. 100 to 9000.")], "route-fare");
      expect(
        checkRouteFare({ mode: "bus", minInr: 100, maxInr: 9000, sourceUrl: big.snippets[0].url }, { bus: big }),
      ).toBeUndefined();
    });

    it("rejects a vehicle-unit amount and a cross-mode citation", () => {
      const veh = mkSet([snip(1, "Taxi Rs. 120 per cab. Rs. 350 per cab.")], "route-fare");
      expect(
        checkRouteFare({ mode: "bus", minInr: 120, maxInr: 350, sourceUrl: veh.snippets[0].url }, { bus: veh }),
      ).toBeUndefined();
      expect(
        checkRouteFare({ mode: "train", minInr: 120, maxInr: 350, sourceUrl: url }, { bus }),
      ).toBeUndefined();
    });
  });
});
