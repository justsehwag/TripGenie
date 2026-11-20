// Feature: places-first-itinerary, Property 11: Every enrichment value is valid and cited
// Validates: Requirements 6.3, 6.4, 6.5, 6.6, 6.7, 6.13, 6.15
import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";

// Any Bedrock call during enrichment is recorded here (and must stay at 0).
const bedrockSends = vi.hoisted(() => ({ n: 0 }));
vi.mock("@aws-sdk/client-bedrock-runtime", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@aws-sdk/client-bedrock-runtime");
  class BedrockRuntimeClient {
    async send(): Promise<never> {
      bedrockSends.n += 1;
      throw new Error("Bedrock must not be called during enrichment");
    }
  }
  return { ...actual, BedrockRuntimeClient };
});

import { enrichStops, type EnrichInput } from "@/lib/itinerary/enrichment";
import { createEvidenceCache } from "@/lib/web-pricing/evidence-cache";
import { createLimiter } from "@/lib/grounding/limiter";
import { MAX_RESEARCH_QUERIES } from "@/lib/web-pricing/query-planner";
import { MAX_SNIPPET_CHARS } from "@/lib/web-pricing/evidence";
import { MAX_SOURCES } from "@/lib/grounding/sources";
import { extractPrices } from "@/lib/price-extractor";
import { isValidWebFields } from "@/lib/web-price-sources";
import type { ResearchConfig } from "@/lib/web-pricing/service";
import type { SearxngFetch } from "@/lib/providers/searxng";

const ON: ResearchConfig = { enabled: true, baseUrl: "https://sx.example.test", secretHeader: null };
const FORBIDDEN = /confirmed|bookable|guaranteed|100%\s*accurate/i;

const PRICE_PHRASES = [
  "Entry fee is INR 120 per person for Indian visitors.",
  "Tickets cost Rs. 1,200 per person.",
  "Admission is Rs 50 for Indians and Rs 600 for foreigners.",
  "Foreign tourists pay USD 20 at the gate.",
  "Tickets cost INR 500 for two people.",
  "Entry is free for everyone.",
  "Free entry for all visitors.",
  "A thali costs about INR 350 per person.",
  "Parking is Rs 100 per vehicle.",
  "Tickets from INR 80 to INR 250 per person.",
  "Entry fee INR 99999999 per person.",
];
const DETAIL_PHRASES = [
  "Tip: arrive early to avoid crowds.",
  "Book tickets online in advance to skip the queue.",
  "The best time to visit is sunrise.",
  "Reservation is required on weekends.",
  "Dress code applies, wear modest clothes.",
  "Booking is confirmed instantly after payment.",
  "Guaranteed best time to visit is sunset.",
  "Bookable in advance, 100% accurate timings.",
  "Peak season runs from October to March.",
];
const FILLER = ["A popular place in the city.", "Open daily.", "Rated highly by visitors.", "Located near the old town."];

const phrase = fc.constantFrom(...PRICE_PHRASES, ...DETAIL_PHRASES, ...FILLER);
const contentArb = fc
  .array(phrase, { minLength: 1, maxLength: 7 })
  .chain((parts) => fc.constantFrom(" ", "  ", ". ").map((sep) => parts.join(sep)));

const resultArb = fc.record({
  host: fc.integer({ min: 1, max: 6 }),
  path: fc.integer({ min: 1, max: 9 }),
  scheme: fc.constantFrom("https", "https", "https", "http"),
  title: fc.constantFrom("Visitor guide", "Entry tickets and fees", "Travel tips", "Reviews"),
  content: contentArb,
});

const stopArb = fc.record({
  name: fc.constantFrom("Amber Fort", "City Palace", "Hawa Mahal", "Chokhi Dhani", "Nahargarh"),
  primaryType: fc.constantFrom<string | null>("tourist_attraction", "park", "museum", null, "restaurant"),
  kind: fc.constantFrom<"sight" | "meal">("sight", "meal"),
});

const scenarioArb = fc.record({
  stops: fc.array(stopArb, { minLength: 1, maxLength: 12 }),
  // One result list per query slot; the fetch cycles through them.
  bodies: fc.array(fc.array(resultArb, { minLength: 0, maxLength: 8 }), { minLength: 1, maxLength: 4 }),
  budgetLevel: fc.constantFrom<unknown>("budget", "mid", "luxury", undefined, "bogus"),
  failEvery: fc.constantFrom(0, 0, 0, 2, 3),
});

describe("Property 11: every enrichment value is valid and cited", () => {
  it("holds for generated SearXNG evidence", async () => {
    const seen = { prices: 0, freePrices: 0, excerpts: 0 };
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (sc) => {
        const retrieved: { url: string; text: string }[] = [];
        const rawContents: string[] = [];
        let calls = 0;
        const fetchImpl: SearxngFetch = async (url: string) => {
          // Only the configured SearXNG host is ever contacted.
          expect(new URL(String(url)).host).toBe("sx.example.test");
          const i = calls++;
          if (sc.failEvery > 0 && i % sc.failEvery === 1) throw new Error("down");
          const list = sc.bodies[i % sc.bodies.length];
          const results = list.map((r) => ({
            title: r.title,
            content: r.content,
            url: `${r.scheme}://host${r.host}.example.org/p${r.path}`,
            engine: "ddg",
          }));
          for (const r of results) {
            retrieved.push({ url: r.url, text: `${r.title} ${r.content}` });
            rawContents.push(r.content);
          }
          return { ok: true, status: 200, json: async () => ({ results }) };
        };

        const inputs: EnrichInput[] = sc.stops.map((s, i) => ({
          placeId: `p${i}`,
          name: `${s.name} ${i}`,
          primaryType: s.primaryType,
          kind: s.kind,
        }));

        const res = await enrichStops(
          inputs,
          { destination: "Jaipur", budgetLevel: sc.budgetLevel },
          { fetchImpl, config: ON, cache: createEvidenceCache(), limiter: createLimiter(5) },
        );

        // Query count
        expect(res.queries).toBeLessThanOrEqual(MAX_RESEARCH_QUERIES);
        expect(calls).toBeLessThanOrEqual(MAX_RESEARCH_QUERIES);
        expect(res.sources.length).toBeLessThanOrEqual(MAX_SOURCES);
        for (const s of res.sources) expect(s.url.startsWith("https://")).toBe(true);

        // One entry per input
        expect(res.stops.size).toBe(inputs.length);

        for (const stop of res.stops.values()) {
          const d = stop.webDetails;
          if (!d.checked) {
            expect(d.tip).toBeUndefined();
            expect(d.booking).toBeUndefined();
            expect(d.bestTime).toBeUndefined();
            expect(d.priceKind).toBeUndefined();
            expect(stop.price).toBeUndefined();
            continue;
          }

          // Price: cited from a retrieved snippet, amount present in that snippet.
          if (stop.price) {
            const p = stop.price;
            expect(isValidWebFields(p)).toBe(true);
            expect(d.priceKind).toBe(p.kind);
            const src = retrieved.filter((r) => r.url === p.sourceUrl);
            expect(src.length).toBeGreaterThan(0);
            const found = src.some((r) => {
              const ex = extractPrices(r.text);
              return p.inr === 0
                ? ex.freeEntry
                : ex.candidates.some((c) => c.min <= p.inr && p.inr <= c.max);
            });
            expect(found).toBe(true);
            expect(FORBIDDEN.test(p.basis)).toBe(false);
            seen.prices += 1;
            if (p.inr === 0) seen.freePrices += 1;
          } else {
            expect(d.priceKind).toBeUndefined();
          }

          for (const key of ["tip", "booking", "bestTime"] as const) {
            const x = d[key];
            if (!x) continue;
            expect(isValidWebFields(x)).toBe(true);
            expect(x.text.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS);
            expect(FORBIDDEN.test(x.text)).toBe(false);
            expect(x.sourceUrl.startsWith("https://")).toBe(true);
            // verbatim substring of a retrieved snippet from the same URL
            // (the sanitiser collapses runs of whitespace, so compare on collapsed text)
            const ws = (s: string) => s.replace(/\s+/g, " ").trim();
            expect(
              retrieved.some((r) => r.url === x.sourceUrl && ws(r.text).includes(ws(x.text))) &&
                rawContents.some((c) => ws(c).includes(ws(x.text))),
            ).toBe(true);
            seen.excerpts += 1;
          }
        }
        expect(bedrockSends.n).toBe(0);
      }),
      { numRuns: 100 },
    );
    // The generators must actually exercise accepted prices and excerpts.
    expect(seen.prices).toBeGreaterThan(0);
    expect(seen.excerpts).toBeGreaterThan(0);
  }, 120_000);
});
