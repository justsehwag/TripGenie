import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  MAX_MEAL_QUERIES,
  MAX_QUERY_CHARS,
  MAX_RESEARCH_QUERIES,
  planQueries,
  type PriceKind,
  type ResearchActivity,
  type ResearchInput,
} from "../lib/web-pricing/query-planner";

const CLASSES = [
  "stay-checkin",
  "route-transport",
  "shopping",
  "free-sight",
  "paid-sight",
  "meal",
  "local-transfer",
  "other",
] as const;

const RANK: Record<PriceKind, number> = { "entry-fee": 0, "cab-fare": 1, "route-fare": 2, meal: 3 };
const FIXED = new Set([
  "entry", "fee", "ticket", "price", "cab", "fare", "to", "average", "meal", "cost", "bus", "train",
]);

const len = (s: string) => Array.from(s).length;

// ---- generators -----------------------------------------------------------

const wordArb = fc.oneof(
  fc.constantFrom("Fort", "Falls", "Temple", "Lake", "Museum", "Palace", "Market", "Garden", "Hotel", "Saravana"),
  fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")), { minLength: 1, maxLength: 14 }).map((c) => c.join("")),
);
const nameArb = fc.array(wordArb, { minLength: 1, maxLength: 4 }).map((w) => w.join(" "));
const destArb = fc.constantFrom("Yelagiri", "Chennai", "Goa", "Ooty", "New Delhi", "Vaniyambadi");

const titleArb = fc.oneof(
  nameArb.map((n) => `Visit ${n}`),
  nameArb.map((n) => `${n} Exploration`),
  nameArb.map((n) => `Dinner at ${n}`),
  fc.constantFrom("Lunch", "Breakfast", "Dinner"),
  fc.tuple(nameArb, nameArb).map(([a, b]) => `Private Cab from ${a} to ${b}`),
  nameArb.map((n) => `Taxi to ${n}`),
  nameArb.map((n) => `Metro ride to ${n}`),
  nameArb,
  fc.string({ maxLength: 40 }),
);

const rawActivityArb = fc.record({
  title: titleArb,
  costClass: fc.constantFrom(...CLASSES),
  costBasis: fc.constantFrom("person" as const, "group" as const),
});

const inputArb: fc.Arbitrary<ResearchInput> = fc
  .record({
    destination: destArb,
    origin: fc.option(destArb, { nil: undefined }),
    routeFare: fc.boolean(),
    raw: fc.array(rawActivityArb, { maxLength: 30 }),
  })
  .map(({ destination, origin, routeFare, raw }) => ({
    destination,
    origin,
    routeFare,
    activities: raw.map((a, i): ResearchActivity => ({ id: `a${i}`, ...a })),
  }));

// Hostile text: control characters, newlines, emoji, accents, CJK.
const hostileArb = fc
  .array(fc.constantFrom("a", "b", "Z", "é", "\n", "\t", "\u0000", "\u0007", " ", " ", "😀", "中", "-"), { maxLength: 200 })
  .map((c) => c.join(""));

// ---- Property 7 -------------------------------------------------------------

describe("Feature: web-grounded-pricing, Property 7: Query plans respect the cap, the grouping and the priority order", () => {
  it("never exceeds the cap, keeps keys unique, orders by priority and drops only the lowest priority", () => {
    fc.assert(
      fc.property(inputArb, fc.integer({ min: -3, max: 14 }), fc.integer({ min: 0, max: 3 }), (input, max, mod) => {
        const isCached = (k: string) => mod > 0 && k.length % (mod + 1) === 0;
        const plan = planQueries(input, { max, isCached });
        const cap = Math.max(0, Math.min(MAX_RESEARCH_QUERIES, max));

        expect(plan.queries.length).toBeLessThanOrEqual(cap);
        expect(plan.queries.length).toBeLessThanOrEqual(MAX_RESEARCH_QUERIES);

        // at most one first-attempt query per Place_Key and Price_Kind
        const seen = new Set(plan.queries.map((q) => `${q.kind}|${q.key}`));
        expect(seen.size).toBe(plan.queries.length);
        expect(new Set(plan.queries.map((q) => q.key)).size).toBe(plan.queries.length);
        for (const q of plan.queries) expect(q.attempt).toBe(1);

        // kind limits
        expect(plan.queries.filter((q) => q.kind === "meal").length).toBeLessThanOrEqual(MAX_MEAL_QUERIES);
        expect(plan.queries.filter((q) => q.kind === "route-fare").length).toBeLessThanOrEqual(2);
        expect(plan.queries.filter((q) => q.kind === "cab-fare").length).toBeLessThanOrEqual(1);

        // priority order: entry-fee < cab-fare < route-fare < meal
        for (let i = 1; i < plan.queries.length; i++) {
          expect(RANK[plan.queries[i - 1].kind]).toBeLessThanOrEqual(RANK[plan.queries[i].kind]);
        }

        // cached keys are never queried
        for (const q of plan.queries) expect(isCached(q.key)).toBe(false);

        // no target for person-basis local transfers or non-researchable classes
        const byId = new Map(input.activities.map((a) => [a.id, a]));
        for (const id of Object.keys(plan.targets)) {
          const a = byId.get(id)!;
          expect(["free-sight", "paid-sight", "meal", "local-transfer"]).toContain(a.costClass);
          if (a.costClass === "local-transfer") expect(a.costBasis).toBe("group");
        }

        // every target has a query or a cached set
        const queried = new Set(plan.queries.map((q) => q.key));
        for (const t of Object.values(plan.targets)) expect(queried.has(t.key) || isCached(t.key)).toBe(true);

        // retries and route keys point at live keys only
        for (const k of Object.keys(plan.retries)) expect(queried.has(k) || isCached(k)).toBe(true);
        for (const k of Object.values(plan.route)) expect(queried.has(k!) || isCached(k!)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("truncation keeps the highest-priority queries: a smaller cap yields a prefix of the full plan", () => {
    fc.assert(
      fc.property(inputArb, fc.integer({ min: 0, max: 10 }), (input, m) => {
        const isCached = (k: string) => k.length % 4 === 0;
        const full = planQueries(input, { isCached });
        const part = planQueries(input, { max: m, isCached });
        expect(part.queries).toEqual(full.queries.slice(0, m));
      }),
      { numRuns: 150 },
    );
  });

  it("clamps max to 0..10 and treats non-finite max as the default", () => {
    const input: ResearchInput = {
      destination: "Goa",
      activities: Array.from({ length: 15 }, (_, i) => ({
        id: `s${i}`,
        title: `Visit Place${String.fromCharCode(97 + i)}`,
        costClass: "paid-sight" as const,
        costBasis: "person" as const,
      })),
    };
    expect(planQueries(input, { max: 99 }).queries).toHaveLength(MAX_RESEARCH_QUERIES);
    expect(planQueries(input, { max: -5 }).queries).toHaveLength(0);
    expect(planQueries(input, { max: 2.9 }).queries).toHaveLength(2);
    expect(planQueries(input, { max: Number.NaN }).queries).toHaveLength(MAX_RESEARCH_QUERIES);
    expect(planQueries(input, { max: Number.POSITIVE_INFINITY }).queries).toHaveLength(MAX_RESEARCH_QUERIES);
    expect(planQueries(input).queries).toHaveLength(MAX_RESEARCH_QUERIES);
    // targets of dropped queries are pruned
    expect(Object.keys(planQueries(input, { max: 2 }).targets)).toHaveLength(2);
  });

  it("drops the lowest-priority queries first when the cap truncates", () => {
    const sights = Array.from({ length: 6 }, (_, i) => ({
      id: `s${i}`,
      title: `Visit Spot${String.fromCharCode(97 + i)}`,
      costClass: "paid-sight" as const,
      costBasis: "person" as const,
    }));
    const meals = ["Dinner at Alpha", "Lunch at Beta", "Breakfast at Gamma"].map((title, i) => ({
      id: `m${i}`,
      title,
      costClass: "meal" as const,
      costBasis: "person" as const,
    }));
    const cab = { id: "c", title: "Cab from Chennai to Goa", costClass: "local-transfer" as const, costBasis: "group" as const };
    const plan = planQueries({ destination: "Goa", origin: "Chennai", routeFare: true, activities: [...meals, cab, ...sights] });
    const kinds = plan.queries.map((q) => q.kind);
    expect(plan.queries).toHaveLength(10);
    expect(kinds.slice(0, 6)).toEqual(Array(6).fill("entry-fee"));
    expect(kinds.slice(6, 9)).toEqual(["cab-fare", "route-fare", "route-fare"]);
    expect(kinds[9]).toBe("meal");
    // the two dropped meals lose their targets
    expect(plan.targets.m0).toBeDefined();
    expect(plan.targets.m1).toBeUndefined();
    expect(plan.targets.m2).toBeUndefined();
  });

  it("shares one query per Place_Key and one cab query per request", () => {
    const plan = planQueries({
      destination: "Yelagiri",
      activities: [
        { id: "a", title: "Visit Jalagamparai Falls", costClass: "paid-sight", costBasis: "person" },
        { id: "b", title: "jalagamparai falls Exploration", costClass: "free-sight", costBasis: "person" },
        { id: "c1", title: "Cab from Chennai Airport to Yelagiri", costClass: "local-transfer", costBasis: "group" },
        { id: "c2", title: "Taxi from Yelagiri to Punganoor Lake", costClass: "local-transfer", costBasis: "group" },
        { id: "m1", title: "Lunch", costClass: "meal", costBasis: "person" },
        { id: "m2", title: "Dinner", costClass: "meal", costBasis: "person" },
        { id: "t", title: "Metro ride to Station", costClass: "local-transfer", costBasis: "person" },
      ],
    });
    expect(plan.targets.a.key).toBe(plan.targets.b.key);
    expect(plan.targets.c1.key).toBe(plan.targets.c2.key);
    expect(plan.targets.m1.key).toBe(plan.targets.m2.key);
    expect(plan.targets.t).toBeUndefined();
    expect(plan.queries.map((q) => q.kind)).toEqual(["entry-fee", "cab-fare", "meal"]);
  });

  it("keeps cached targets, skips their queries, and survives a throwing isCached", () => {
    const input: ResearchInput = {
      destination: "Goa",
      activities: [{ id: "a", title: "Visit Fort Aguada", costClass: "paid-sight", costBasis: "person" }],
    };
    const cached = planQueries(input, { isCached: () => true });
    expect(cached.queries).toHaveLength(0);
    expect(cached.targets.a).toBeDefined();
    const thrown = planQueries(input, {
      isCached: () => {
        throw new Error("boom");
      },
    });
    expect(thrown.queries).toHaveLength(1);
  });

  it("returns an empty plan for malformed input", () => {
    for (const bad of [null, undefined, {}, { destination: 5 }, { destination: "  " }, { destination: "Goa", activities: "x" }]) {
      const plan = planQueries(bad as unknown as ResearchInput);
      expect(plan.queries).toEqual([]);
      expect(plan.targets).toEqual({});
    }
  });
});

// ---- Property 8 -------------------------------------------------------------

describe("Feature: web-grounded-pricing, Property 8: Query text is clean and derived only from titles and the destination", () => {
  it("every query is within 120 code points, free of control characters and built from known words", () => {
    fc.assert(
      fc.property(
        hostileArb,
        hostileArb,
        hostileArb,
        hostileArb,
        fc.constantFrom(...CLASSES),
        fc.boolean(),
        (title, title2, destination, origin, costClass, routeFare) => {
          const input: ResearchInput = {
            destination,
            origin,
            routeFare,
            activities: [
              { id: "a", title, costClass, costBasis: "person" },
              { id: "b", title: title2, costClass: "paid-sight", costBasis: "person" },
              { id: "c", title: `Cab from ${title} to ${title2}`, costClass: "local-transfer", costBasis: "group" },
              { id: "d", title: `Dinner at ${title2}`, costClass: "meal", costBasis: "person" },
            ],
          };
          const plan = planQueries(input);
          const clean = (s: string) => s.replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim();
          const sources = [...input.activities.map((a) => a.title), destination, origin]
            .flatMap((s) => clean(s).split(" "))
            .filter(Boolean);
          const all = [...plan.queries.map((q) => q.query), ...Object.values(plan.retries)];
          for (const q of all) {
            expect(len(q)).toBeLessThanOrEqual(MAX_QUERY_CHARS);
            expect(/\p{Cc}/u.test(q)).toBe(false);
            expect(q).toBe(q.trim());
            expect(/\s{2}/u.test(q)).toBe(false);
            expect(q.length).toBeGreaterThan(0);
            for (const w of q.split(" ")) {
              const ok = FIXED.has(w) || sources.some((s) => s.startsWith(w));
              expect(ok).toBe(true);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("produces no query or target for a place name that is empty after cleaning", () => {
    const plan = planQueries({
      destination: "Goa",
      activities: [
        { id: "a", title: "", costClass: "paid-sight", costBasis: "person" },
        { id: "b", title: "\n\t\u0000  ", costClass: "free-sight", costBasis: "person" },
        { id: "c", title: "Visit Goa", costClass: "paid-sight", costBasis: "person" },
      ],
    });
    expect(plan.targets.a).toBeUndefined();
    expect(plan.targets.b).toBeUndefined();
    for (const q of plan.queries) expect(q.query.length).toBeGreaterThan(0);
  });

  it("returns no queries when the destination is empty after cleaning", () => {
    const plan = planQueries({
      destination: " \n\u0000 ",
      activities: [{ id: "a", title: "Visit Fort", costClass: "paid-sight", costBasis: "person" }],
    });
    expect(plan.queries).toEqual([]);
  });

  it("cuts a very long place to 120 code points, shortening the place first and keeping the fixed words", () => {
    const place = "A".repeat(300);
    const plan = planQueries({
      destination: "Chennai",
      activities: [{ id: "a", title: place, costClass: "paid-sight", costBasis: "person" }],
    });
    const q = plan.queries[0].query;
    expect(len(q)).toBe(MAX_QUERY_CHARS);
    expect(q.endsWith(" entry fee Chennai")).toBe(true);
    const retry = plan.retries[plan.queries[0].key];
    expect(len(retry)).toBe(MAX_QUERY_CHARS);
    expect(retry.endsWith(" ticket price Chennai")).toBe(true);
  });

  it("counts code points, not UTF-16 units, at the 120 boundary", () => {
    // 'entry fee ' + ' Goa' = 14 chars; 106 emoji + 14 = exactly 120 code points.
    const exact = "😀".repeat(106);
    const over = "😀".repeat(107);
    const make = (title: string) =>
      planQueries({
        destination: "Goa",
        activities: [{ id: "a", title, costClass: "paid-sight", costBasis: "person" }],
      }).queries[0].query;
    const qExact = make(exact);
    expect(len(qExact)).toBe(120);
    expect(qExact).toBe(`${exact} entry fee Goa`);
    const qOver = make(over);
    expect(len(qOver)).toBeLessThanOrEqual(120);
    expect(qOver.endsWith(" entry fee Goa")).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(qOver)).toBe(false);
  });

  it("drops whole words from a long multi-word place on a word boundary", () => {
    const title = Array.from({ length: 30 }, (_, i) => `Word${i}`).join(" ");
    const q = planQueries({
      destination: "Goa",
      activities: [{ id: "a", title, costClass: "paid-sight", costBasis: "person" }],
    }).queries[0].query;
    expect(len(q)).toBeLessThanOrEqual(120);
    const place = q.replace(/ entry fee Goa$/, "");
    expect(title.startsWith(place)).toBe(true);
    expect(title.charAt(place.length)).toBe(" ");
  });

  it("shortens a very long destination after the place and never exceeds 120", () => {
    const dest = "Dest".repeat(60); // 240 chars, one word
    const plan = planQueries({
      destination: dest,
      origin: "Chennai",
      routeFare: true,
      activities: [
        { id: "a", title: "Visit Fort", costClass: "paid-sight", costBasis: "person" },
        { id: "m", title: "Lunch", costClass: "meal", costBasis: "person" },
      ],
    });
    // Regression: an over-long destination used to drop every query except the generic meal.
    expect(plan.queries.map((q) => q.kind)).toEqual(["entry-fee", "route-fare", "route-fare", "meal"]);
    for (const q of plan.queries) {
      expect(len(q.query)).toBeLessThanOrEqual(120);
      expect(q.query.length).toBeGreaterThan(0);
    }
    const entry = plan.queries[0].query;
    expect(entry).toMatch(/^F\S* entry fee (?:Dest)+\S*$/);
    expect(dest.startsWith(entry.replace(/^\S+ entry fee /, ""))).toBe(true);
    expect(plan.queries[3].query).toMatch(/^average meal cost (?:Dest)+\S*$/);
    expect(len(plan.queries[3].query)).toBe(120);
  });

  it("builds the documented query formats", () => {
    const plan = planQueries({
      destination: "Yelagiri",
      origin: "Chennai",
      routeFare: true,
      activities: [
        { id: "a", title: "Visit Jalagamparai Falls", costClass: "paid-sight", costBasis: "person" },
        { id: "c", title: "Cab from Chennai Airport to Yelagiri", costClass: "local-transfer", costBasis: "group" },
        { id: "m1", title: "Dinner at Hotel Saravana Bhavan", costClass: "meal", costBasis: "person" },
        { id: "m2", title: "Lunch", costClass: "meal", costBasis: "person" },
      ],
    });
    expect(plan.queries.map((q) => q.query)).toEqual([
      "Jalagamparai Falls entry fee Yelagiri",
      "cab fare Chennai Airport to Yelagiri",
      "bus fare Chennai to Yelagiri",
      "train fare Chennai to Yelagiri",
      "average meal cost Hotel Saravana Bhavan Yelagiri",
      "average meal cost Yelagiri",
    ]);
    const entryKey = plan.targets.a.key;
    expect(plan.retries[entryKey]).toBe("Jalagamparai Falls ticket price Yelagiri");
    expect(plan.queries.filter((q) => q.kind === "route-fare").map((q) => q.variant)).toEqual(["bus", "train"]);
    expect(plan.route.bus).toBeDefined();
    expect(plan.route.train).toBeDefined();
  });

  it("sends no route queries without the flag or without an origin", () => {
    const base = { destination: "Yelagiri", activities: [] as ResearchActivity[] };
    expect(planQueries({ ...base, origin: "Chennai" }).queries).toEqual([]);
    expect(planQueries({ ...base, routeFare: true }).queries).toEqual([]);
  });
});
