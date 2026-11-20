// Feature: misc-web-pricing, core guarantees (properties 1, 3, 4, 11).
// No live Bedrock or SearXNG: invokeModel and research are mocked.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fc from "fast-check";

import { MiscLine } from "@/components/misc-line";
import { formatInr } from "@/lib/itinerary-inr";
import {
  estimateMisc,
  buildMiscResearch,
  MISC_WINDOW_CHARS,
  type MiscDeps,
  type MiscInput,
} from "@/lib/itinerary/misc-estimate";
import {
  MISC_MAX_ITEMS,
  parseMiscNames,
  type MiscCategory,
  type MiscItem,
  type MiscResult,
} from "@/lib/itinerary/misc-estimate-shared";
import { extractPrices } from "@/lib/price-extractor";
import { isValidWebFields } from "@/lib/web-price-sources";
import { evidenceText, type EvidenceSet, type EvidenceSnippet } from "@/lib/web-pricing/evidence";
import { planQueries } from "@/lib/web-pricing/query-planner";
import type { ResearchResult } from "@/lib/web-pricing/service";
import type { TripDay } from "@/lib/types";

const RUNS = { numRuns: 100 };
const CONFIG = { enabled: true, baseUrl: "https://searx.test", secretHeader: null };
const CATEGORIES: MiscCategory[] = ["transport", "parking", "water-snacks", "tips", "entry"];
const CERTAINTY = /confirmed|guaranteed|bookable|100% accurate/i;

const INPUT: MiscInput = {
  destination: "Jaipur",
  travellers: 2,
  stops: [{ name: "Amber Fort" }, { name: "City Palace" }, { name: "Hawa Mahal" }],
};

// ---------- generators ----------

const word = fc.constantFrom("Parking", "Water", "Snacks", "Cab", "Guide tip", "Entry", "Auto", "Bottle");
const nameArb = fc.record({
  w: word,
  category: fc.constantFrom(...CATEGORIES),
  hint: fc.constantFrom("parking charges", "water bottle snacks", "local taxi fare", "guide tip", ""),
  stopIndex: fc.option(fc.integer({ min: 0, max: 2 }), { nil: undefined }),
});
const namesArb = fc
  .array(nameArb, { minLength: 1, maxLength: 8 })
  .map((a) => a.map((n, i) => ({ ...n, label: `${n.w} ${String.fromCharCode(97 + i)}` })));

const junkValue = fc.oneof(fc.integer(), fc.string({ maxLength: 12 }), fc.boolean(), fc.constant(null));
const amountFields = fc.record(
  {
    amountInr: fc.integer({ min: 0, max: 99999 }),
    price: junkValue,
    cost: junkValue,
    note: fc.string({ maxLength: 20 }),
    currency: fc.constantFrom("INR", "USD", "₹"),
    amount: junkValue,
    inr: junkValue,
  },
  { requiredKeys: [] },
);

/** A Bedrock reply with names plus amount-like fields, as text (optionally fenced) or object. */
const replyArb = fc
  .tuple(namesArb, fc.array(amountFields, { minLength: 8, maxLength: 8 }), fc.constantFrom("plain", "fenced", "object", "array"))
  .map(([names, extras, form]) => {
    const items = names.map((n, i) => ({
      label: n.w + " " + String.fromCharCode(97 + i),
      category: n.category,
      hint: n.hint,
      ...(n.stopIndex !== undefined ? { stopIndex: n.stopIndex } : {}),
      ...extras[i],
    }));
    if (form === "object") return { items };
    if (form === "array") return JSON.stringify(items);
    const text = JSON.stringify({ items });
    return form === "fenced" ? "Here:\n```json\n" + text + "\n```" : text;
  });

// ---------- research mock ----------

type SnippetMode = "near" | "far" | "noprice";

const TERMS_TEXT = "parking water snacks cab taxi fare ticket entry tip guide";
const FILLER = "lorem ipsum dolor sit amet ".repeat(8); // > MISC_WINDOW_CHARS chars, no item terms

function snippetFor(mode: SnippetMode, amount: number, n: number): EvidenceSnippet {
  const url = `https://site${n}.example.com/page${n}`;
  let text: string;
  if (mode === "near") text = `${TERMS_TEXT} charges Rs ${amount} per visit`;
  else if (mode === "far") text = `${TERMS_TEXT} ${FILLER} Rs ${amount} ${FILLER}`;
  else text = `${TERMS_TEXT} price not listed on this page`;
  return { title: "Price list", text, url, host: `site${n}.example.com` };
}

interface Supplied {
  snippets: EvidenceSnippet[];
}

/** A mock `research` that plans like the real one and answers every target from `modes`. */
function mockResearch(modes: SnippetMode[], amounts: number[], supplied: Supplied): NonNullable<MiscDeps["research"]> {
  return async (input) => {
    const plan = planQueries(input);
    const sets: Record<string, EvidenceSet> = {};
    let n = 0;
    for (const t of Object.values(plan.targets)) {
      const mode = modes[n % modes.length];
      const sn = snippetFor(mode, amounts[n % amounts.length], n);
      supplied.snippets.push(sn);
      sets[t.key] = { key: t.key, kind: t.kind, snippets: [sn], checkedAtMs: 1_700_000_000_000 };
      n++;
    }
    const result: ResearchResult = {
      status: "ok",
      plan,
      sets,
      stats: { queries: plan.queries.length, failed: 0, snippets: n, candidates: n, ms: 1 },
    };
    return result;
  };
}

function deps(reply: unknown, research: MiscDeps["research"]): MiscDeps {
  return {
    invokeModel: async () => (typeof reply === "string" ? reply : JSON.stringify(reply)),
    research,
    config: CONFIG,
    now: () => 1_700_000_000_000,
    healthLogger: () => undefined,
  };
}

// ---------- Property 1 ----------

describe("misc-web-pricing core: name parser", () => {
  it("Feature: misc-web-pricing, Property 1: Name parser never yields amounts and caps at 6", () => {
    fc.assert(
      fc.property(fc.oneof(replyArb, fc.jsonValue().map((v) => JSON.stringify(v)), fc.string()), (reply) => {
        const out = parseMiscNames(reply);
        expect(out.length).toBeLessThanOrEqual(MISC_MAX_ITEMS);
        const labels = new Set<string>();
        for (const item of out) {
          expect(Object.keys(item).every((k) => ["label", "category", "hint", "stopIndex"].includes(k))).toBe(true);
          expect(item.label.length).toBeGreaterThanOrEqual(1);
          expect(item.label.length).toBeLessThanOrEqual(60);
          expect(item.hint.length).toBeLessThanOrEqual(120);
          expect(CERTAINTY.test(item.label + " " + item.hint)).toBe(false);
          const key = item.label.toLowerCase();
          expect(labels.has(key)).toBe(false);
          labels.add(key);
        }
        expect(JSON.stringify(out)).not.toMatch(/amountInr|"price"|"cost"|"note"|"currency"/);
      }),
      RUNS,
    );
  });

  it("drops amounts from a concrete reply", () => {
    const out = parseMiscNames(
      '{"items":[{"label":"Parking","category":"parking","hint":"parking charges","amountInr":50,"price":"₹50","cost":50,"note":"cheap"}]}',
    );
    expect(out).toEqual([{ label: "Parking", category: "parking", hint: "parking charges" }]);
  });
});

// ---------- Properties 3 and 4 ----------

describe("misc-web-pricing core: estimateMisc", () => {
  it("shows a priced item for a near, cited snippet (sanity example)", async () => {
    const supplied: Supplied = { snippets: [] };
    const r = await estimateMisc(
      deps({ items: [{ label: "Parking fee", category: "parking", hint: "parking charges" }] }, mockResearch(["near"], [80], supplied)),
      INPUT,
    );
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.items[0].amountInr).toBe(80);
      expect(r.sumInr).toBe(80);
    }
  });

  it("Feature: misc-web-pricing, Property 3: Every shown item has a valid cited source and a near term", async () => {
    let okRuns = 0;
    await fc.assert(
      fc.asyncProperty(
        replyArb,
        fc.array(fc.constantFrom<SnippetMode>("near", "far", "noprice"), { minLength: 1, maxLength: 6 }),
        fc.array(fc.integer({ min: 20, max: 400 }), { minLength: 1, maxLength: 6 }),
        async (reply, modes, amounts) => {
          const supplied: Supplied = { snippets: [] };
          const r = await estimateMisc(deps(reply, mockResearch(modes, amounts, supplied)), INPUT);
          if (r.status !== "ok") return;
          okRuns++;
          expect(r.items.length).toBeGreaterThan(0);
          for (const item of r.items) {
            expect(isValidWebFields(item)).toBe(true);
            expect(item.sourceUrl.startsWith("https://")).toBe(true);
            const sn = supplied.snippets.find((s) => s.url === item.sourceUrl);
            expect(sn).toBeDefined();
            const text = evidenceText(sn!);
            const lower = text.toLowerCase();
            const cands = extractPrices(text).candidates.filter((c) => c.min === item.amountInr || c.max === item.amountInr);
            expect(cands.length).toBeGreaterThan(0);
            const near = cands.some((c) => {
              const win =
                lower.slice(Math.max(0, c.index - MISC_WINDOW_CHARS), c.index) + " " + lower.slice(c.end, c.end + MISC_WINDOW_CHARS);
              return TERMS_TEXT.split(" ").some((t) => win.includes(t));
            });
            expect(near).toBe(true);
          }
          expect(r.sumInr).toBe(r.items.reduce((s, i) => s + i.amountInr, 0));
        },
      ),
      RUNS,
    );
    // Not vacuous: a good share of runs actually show priced items.
    expect(okRuns).toBeGreaterThan(10);
  });

  it("Feature: misc-web-pricing, Property 4: No Bedrock amount is ever shown", async () => {
    await fc.assert(
      fc.asyncProperty(
        replyArb,
        fc.array(fc.constantFrom<SnippetMode>("far", "noprice"), { minLength: 1, maxLength: 6 }),
        fc.array(fc.integer({ min: 20, max: 400 }), { minLength: 1, maxLength: 6 }),
        async (reply, modes, amounts) => {
          // No accepted price anywhere: no amount may appear, whatever the model said.
          const supplied: Supplied = { snippets: [] };
          const r = await estimateMisc(deps(reply, mockResearch(modes, amounts, supplied)), INPUT);
          expect(r.status).not.toBe("ok");
          expect(JSON.stringify(r)).not.toMatch(/amountInr|sumInr|items/);

          // With accepted prices, every amount comes from a supplied snippet, not from the reply.
          const supplied2: Supplied = { snippets: [] };
          const r2 = await estimateMisc(deps(reply, mockResearch(["near"], amounts, supplied2)), INPUT);
          if (r2.status === "ok") {
            const candidateAmounts = new Set<number>();
            for (const s of supplied2.snippets) for (const c of extractPrices(evidenceText(s)).candidates) candidateAmounts.add(c.min);
            for (const it of r2.items) expect(candidateAmounts.has(it.amountInr)).toBe(true);
          }
        },
      ),
      RUNS,
    );
  });

  it("buildMiscResearch maps names without amounts", () => {
    const { research } = buildMiscResearch([{ label: "Parking", category: "parking", hint: "parking charges" }], INPUT);
    expect(JSON.stringify(research)).not.toMatch(/amount|price"/i);
  });
});

// ---------- Property 11 ----------

const day = { day: 1, activities: [{ time: "09:00", title: "Fort", description: "d", cost: 0 }] } as unknown as TripDay;
const render = (result: MiscResult | "loading" | undefined) =>
  renderToStaticMarkup(createElement(MiscLine, { day, result }));

const itemsArb = fc.array(fc.integer({ min: 10, max: 9000 }), { minLength: 2, maxLength: 4 }).map((amts) =>
  amts.map<MiscItem>((a, i) => ({
    label: `Zqx${i}item`,
    amountInr: a * 10 + i,
    sourceUrl: `https://src${i}.example.com/p`,
    sourceHost: `src${i}.example.com`,
    checkedAt: "2026-05-01T10:00:00.000Z",
  })),
);

const resultArb: fc.Arbitrary<MiscResult> = fc.oneof(
  itemsArb.chain((items) =>
    fc.constantFrom(["Zqmiss0"], [] as string[]).map<MiscResult>((missing) => ({
      status: "ok",
      items,
      sumInr: items.reduce((s, i) => s + i.amountInr, 0),
      missing,
    })),
  ),
  fc.constantFrom(["Zqmiss0", "Zqmiss1"], [] as string[]).map<MiscResult>((missing) => ({ status: "none", missing })),
  fc.constant<MiscResult>({ status: "unavailable" }),
);

describe("misc-web-pricing core: MiscLine", () => {
  it("Feature: misc-web-pricing, Property 11: Collapsed by default and detail hidden", () => {
    fc.assert(
      fc.property(resultArb, (result) => {
        const html = render(result);
        if (html.includes("<button")) expect(html).toContain('aria-expanded="false"');
        expect(html).not.toContain('aria-expanded="true"');
        expect(html).not.toMatch(/Zq/);
        expect(html).not.toContain("No web price found");
        expect(html).not.toMatch(/https:\/\/|href=|src\d\.example/i);
        expect(html).not.toContain("2026");
        if (result.status === "ok") {
          const sumText = formatInr(result.sumInr);
          for (const it of result.items) {
            const t = formatInr(it.amountInr);
            if (!sumText.includes(t)) expect(html).not.toContain(t);
          }
        }
        expect(html).not.toMatch(/AI estimate|Rough AI estimate/i);
        expect(CERTAINTY.test(html)).toBe(false);
      }),
      RUNS,
    );
  });

  it("renders no certainty or AI wording for loading and undefined", () => {
    for (const r of ["loading", undefined] as const) {
      const html = render(r);
      expect(html).not.toMatch(/AI estimate|Rough AI estimate/i);
      expect(CERTAINTY.test(html)).toBe(false);
    }
  });
});
