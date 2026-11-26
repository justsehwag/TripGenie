/**
 * Feature: knowmore-welcome-look
 * Properties 1-6 for the pure Day_Brief formatter (lib/know-more/brief.ts).
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  SECTION_CAPS,
  MAX_WORDS,
  parseBrief,
  fallbackBrief,
  factsText,
  type BriefFacts,
  type DayBrief,
} from "@/lib/know-more/brief";

const RUNS = { numRuns: 150 };
const KEYS = ["highlights", "bestTime", "tips", "gettingThere", "goodToKnow"] as const;

const wordArb = fc.stringMatching(/^[a-z]{3,9}$/);
const sentenceArb = (min: number, max: number) =>
  fc.array(wordArb, { minLength: min, maxLength: max }).map((w) => w.join(" "));

const factsArb: fc.Arbitrary<BriefFacts> = fc.record({
  destination: sentenceArb(1, 2),
  day: fc.integer({ min: 1, max: 10 }),
  places: fc.array(
    fc.record({
      title: sentenceArb(1, 4),
      time: fc.constant("09:00"),
      description: sentenceArb(1, 30),
      rating: fc.option(fc.double({ min: 1, max: 5, noNaN: true }), { nil: null }),
      ratingCount: fc.option(fc.integer({ min: 0, max: 5000 }), { nil: null }),
      reviewExcerpt: fc.option(sentenceArb(1, 25), { nil: null }),
    }),
    { minLength: 0, maxLength: 6 },
  ),
});

const wc = (s: string) => s.split(" ").filter(Boolean).length;
const stripEllipsis = (s: string) => s.replace(/\u2026$/, "");

function allBullets(b: DayBrief): string[] {
  return KEYS.flatMap((k) => b[k]);
}

/** Model JSON built from the facts' own vocabulary so grounding usually passes. */
function jsonFrom(items: Record<string, string[]>, extra = ""): string {
  return `${extra}${JSON.stringify(items)}`;
}

const itemsArb = fc.dictionary(
  fc.constantFrom(...KEYS, "unknownKey"),
  fc.array(sentenceArb(1, 40), { minLength: 0, maxLength: 12 }),
);

describe("Feature: knowmore-welcome-look, Property 1: Brief size bounds", () => {
  const rawArb = fc.oneof(
    fc.string({ maxLength: 400 }),
    itemsArb.map((i) => jsonFrom(i)),
    itemsArb.map((i) => jsonFrom(i, "Here you go: ")),
    fc.array(sentenceArb(1, 30), { maxLength: 15 }).map((s) => s.join(". ")),
  );
  it("respects section caps and the 15-word limit", () => {
    fc.assert(
      fc.property(rawArb, factsArb, (raw, facts) => {
        const b = parseBrief(raw, facts);
        expect(b.highlights.length).toBeLessThanOrEqual(SECTION_CAPS.highlights);
        expect(b.bestTime.length).toBeLessThanOrEqual(SECTION_CAPS.bestTime);
        expect(b.tips.length).toBeLessThanOrEqual(SECTION_CAPS.tips);
        expect(b.gettingThere.length).toBeLessThanOrEqual(SECTION_CAPS.gettingThere);
        expect(b.goodToKnow.length).toBeLessThanOrEqual(SECTION_CAPS.goodToKnow);
        for (const bullet of allBullets(b)) expect(wc(bullet)).toBeLessThanOrEqual(MAX_WORDS);
      }),
      RUNS,
    );
  });
});

describe("Feature: knowmore-welcome-look, Property 2: Plain text output", () => {
  const prefixArb = fc.constantFrom("", "**", "`", "# ", "## ", "- ", "* ", "1. ", "2) ");
  const suffixArb = fc.constantFrom("", "**", "`");
  it("returns bullets without markdown markers", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(prefixArb, sentenceArb(1, 20), suffixArb), { minLength: 1, maxLength: 8 }),
        factsArb,
        (parts, facts) => {
          // Make sure the facts contain the item words so bullets survive grounding.
          const items = parts.map(([p, s, x]) => `${p}${s}${x}`);
          const withFacts: BriefFacts = {
            ...facts,
            destination: `${facts.destination} ${parts.map((p) => p[1]).join(" ")}`,
          };
          const b = parseBrief(jsonFrom({ highlights: items, tips: items }), withFacts);
          for (const bullet of allBullets(b)) {
            expect(bullet).not.toContain("**");
            expect(bullet).not.toContain("`");
            expect(bullet).not.toMatch(/^\s*#/);
            expect(bullet).not.toMatch(/^\s*([-*+]|\d+[.)])\s/);
          }
        },
      ),
      RUNS,
    );
  });
});

describe("Feature: knowmore-welcome-look, Property 3: Words are preserved or trimmed only", () => {
  it("every bullet is an input item or a word prefix of one plus an ellipsis", () => {
    fc.assert(
      fc.property(itemsArb, factsArb, (items, facts) => {
        const vocab = Object.values(items).flat().join(" ");
        const withFacts: BriefFacts = { ...facts, destination: `${facts.destination} ${vocab}` };
        const b = parseBrief(jsonFrom(items), withFacts);
        const inputs = Object.entries(items)
          .filter(([k]) => (KEYS as readonly string[]).includes(k))
          .flatMap(([, v]) => v);
        for (const bullet of allBullets(b)) {
          const truncated = bullet.endsWith("\u2026");
          const bw = stripEllipsis(bullet).split(" ").filter(Boolean);
          const ok = inputs.some((inp) => {
            const iw = inp.split(" ").filter(Boolean);
            if (!truncated) return iw.join(" ") === bw.join(" ");
            return bw.length < iw.length && bw.every((w, i) => iw[i] === w);
          });
          expect(ok).toBe(true);
        }
      }),
      RUNS,
    );
  });
});

describe("Feature: knowmore-welcome-look, Property 4: Grounding filter", () => {
  it("every bullet shares a 4+ letter word with the facts", () => {
    fc.assert(
      fc.property(itemsArb, factsArb, (items, facts) => {
        const b = parseBrief(jsonFrom(items), facts);
        const fw = new Set(
          [...factsText(facts).toLowerCase().matchAll(/\p{L}{4,}/gu)].map((m) => m[0]),
        );
        for (const bullet of allBullets(b)) {
          const words = [...bullet.toLowerCase().matchAll(/\p{L}{4,}/gu)].map((m) => m[0]);
          expect(words.some((w) => fw.has(w))).toBe(true);
        }
      }),
      RUNS,
    );
  });
});

describe("Feature: knowmore-welcome-look, Property 5: Paragraph fallback", () => {
  it("a plain paragraph fills at most Highlights", () => {
    fc.assert(
      fc.property(
        // 4+ letter words so the grounding filter can accept the bullets.
        fc.array(
          fc.array(fc.stringMatching(/^[a-z]{4,9}$/), { minLength: 1, maxLength: 25 }).map((w) => w.join(" ")),
          { minLength: 1, maxLength: 12 },
        ),
        factsArb,
        (sentences, facts) => {
          const paragraph = sentences.map((s) => `${s}.`).join(" ");
          const withFacts: BriefFacts = { ...facts, destination: `${facts.destination} ${paragraph}` };
          const b = parseBrief(paragraph, withFacts);
          expect(b.bestTime).toEqual([]);
          expect(b.tips).toEqual([]);
          expect(b.gettingThere).toEqual([]);
          expect(b.goodToKnow).toEqual([]);
          expect(b.highlights.length).toBeLessThanOrEqual(SECTION_CAPS.highlights);
          expect(b.highlights.length).toBeGreaterThan(0);
        },
      ),
      RUNS,
    );
  });
});

describe("Feature: knowmore-welcome-look, Property 6: Fallback brief is bounded and sourced from the itinerary", () => {
  it("returns at most 5 trimmed copies of descriptions or titles", () => {
    fc.assert(
      fc.property(factsArb, (facts) => {
        const b = fallbackBrief(facts);
        expect(b.bestTime).toEqual([]);
        expect(b.tips).toEqual([]);
        expect(b.gettingThere).toEqual([]);
        expect(b.goodToKnow).toEqual([]);
        expect(b.highlights.length).toBeLessThanOrEqual(SECTION_CAPS.highlights);
        for (const bullet of b.highlights) {
          expect(wc(bullet)).toBeLessThanOrEqual(MAX_WORDS);
          const bw = stripEllipsis(bullet).split(" ").filter(Boolean);
          const ok = facts.places.some((p) =>
            [p.description, p.title].some((src) => {
              const sw = src.split(" ").filter(Boolean);
              return bw.length <= sw.length && bw.every((w, i) => sw[i] === w);
            }),
          );
          expect(ok).toBe(true);
        }
      }),
      RUNS,
    );
  });
});

describe("valid JSON that ends empty", () => {
  it("returns an empty brief, not the paragraph fallback", () => {
    const facts: BriefFacts = { destination: "Paris", day: 1, places: [] };
    const b = parseBrief('{"highlights":[],"tips":["zzzz qqqq"]}', facts);
    expect(allBullets(b)).toEqual([]);
  });
});
