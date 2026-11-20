import { describe, it, expect, vi, afterEach } from "vitest";
import fc from "fast-check";
import {
  MAX_ACTIVITIES,
  USD_INR_FALLBACK,
  categoryEstimateInr,
  inferKind,
  validatePricerRequest,
  buildPricingPrompt,
  handlePriceRequest,
  type ActivityKind,
  type PricerDeps,
} from "../lib/activity-pricer";
import { SYSTEM_PROMPT_PREFIX } from "../lib/planning-turn";
import { PriceCache } from "../lib/price-cache";

const MODEL_ID = "anthropic.claude-test-model-id-v1:0";
const KINDS: ActivityKind[] = ["entry-ticket", "meal", "local-transfer", "other"];

const kindArb = fc.constantFrom<ActivityKind>(...KINDS);
const activitiesArb = fc
  .uniqueArray(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 1, maxLength: 12 })
  .chain((ids) =>
    fc.tuple(
      ...ids.map((id) =>
        fc.record({
          id: fc.constant(id),
          title: fc.string({ maxLength: 40 }),
          time: fc.string({ maxLength: 10 }),
          kind: kindArb,
        }),
      ),
    ),
  );
const requestArb = fc.record({
  destination: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim() !== ""),
  activities: activitiesArb,
});
const rateArb = fc.double({ min: 1, max: 500, noNaN: true });

function makeDeps(
  invoke: PricerDeps["invoke"],
  rate: number,
  extra?: Partial<PricerDeps>,
): PricerDeps & { cache: PriceCache } {
  const cache = new PriceCache();
  return { invoke, cache, now: () => 1_000_000, usdInr: async () => rate, ...extra };
}

type Req = { destination: string; activities: { id: string; title: string; time: string; kind: ActivityKind }[] };

function expectAllEstimated(
  out: Awaited<ReturnType<typeof handlePriceRequest>>,
  req: Req,
  rate: number,
) {
  expect(out.status).toBe(200);
  if (out.status !== 200) return;
  expect(out.body.cached).toBe(false);
  expect(out.body.prices).toHaveLength(req.activities.length);
  req.activities.forEach((a, i) => {
    const p = out.body.prices[i];
    expect(p.id).toBe(a.id);
    expect(p.source).toBe("estimated");
    expect(p.inr).toBe(categoryEstimateInr(a.kind, req.destination, rate));
  });
}

function noLeak(out: unknown) {
  const s = JSON.stringify(out);
  expect(s).not.toContain(MODEL_ID);
  expect(s).not.toContain(SYSTEM_PROMPT_PREFIX);
}

afterEach(() => {
  vi.useRealTimers();
});

// Feature: trip-planning-v2, Property 11: Pricer request handling invariants
describe("Feature: trip-planning-v2, Property 11: Pricer request handling invariants", () => {
  it("cache miss makes exactly one model call; prompt has every id, INR and single JSON object", async () => {
    await fc.assert(
      fc.asyncProperty(requestArb, rateArb, async (req, rate) => {
        const invoke = vi.fn(async (p: { user: string; system: string }) => {
          const parsed = JSON.parse(p.user) as { activities: { id: string }[] };
          return JSON.stringify({
            prices: parsed.activities.map((a) => ({ id: a.id, inr: 100, basis: "typical fare" })),
          });
        });
        const deps = makeDeps(invoke as unknown as PricerDeps["invoke"], rate);
        const out = await handlePriceRequest(req, deps);
        expect(invoke).toHaveBeenCalledTimes(1);
        const prompt = invoke.mock.calls[0][0];
        const text = `${prompt.system}\n${prompt.user}`;
        for (const a of req.activities) expect(prompt.user).toContain(JSON.stringify(a.id));
        expect(text).toMatch(/INR/);
        expect(text).toMatch(/one JSON object/i);
        expect(buildPricingPrompt(req).user).toBe(prompt.user);
        expect(out.status).toBe(200);
        noLeak(out);
      }),
      { numRuns: 100 },
    );
  });

  it("a model that throws yields 200 with all estimated at categoryEstimateInr", async () => {
    await fc.assert(
      fc.asyncProperty(requestArb, rateArb, async (req, rate) => {
        const invoke = vi.fn(async () => {
          throw new Error(`boom ${MODEL_ID}`);
        });
        const out = await handlePriceRequest(req, makeDeps(invoke, rate));
        expect(invoke).toHaveBeenCalledTimes(1);
        expectAllEstimated(out, req, rate);
        noLeak(out);
      }),
      { numRuns: 100 },
    );
  });

  it("a model that returns empty or whitespace text yields 200 all estimated", async () => {
    await fc.assert(
      fc.asyncProperty(
        requestArb,
        rateArb,
        fc.constantFrom("", " ", "\n\t  "),
        async (req, rate, text) => {
          const out = await handlePriceRequest(req, makeDeps(async () => text, rate));
          expectAllEstimated(out, req, rate);
          noLeak(out);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("a never-resolving model times out and yields 200 all estimated", async () => {
    await fc.assert(
      fc.asyncProperty(requestArb, rateArb, async (req, rate) => {
        const deps = makeDeps(() => new Promise<string>(() => {}), rate, { timeoutMs: 1 });
        const out = await handlePriceRequest(req, deps);
        expectAllEstimated(out, req, rate);
        noLeak(out);
      }),
      { numRuns: 100 },
    );
  });

  it("never-resolving model with fake timers gives 200 all estimated", async () => {
    vi.useFakeTimers();
    const req: Req = {
      destination: "Jaipur",
      activities: [
        { id: "a1", title: "Amber Fort", time: "09:00", kind: "entry-ticket" },
        { id: "a2", title: "Lunch", time: "13:00", kind: "meal" },
      ],
    };
    const deps = makeDeps(() => new Promise<string>(() => {}), 90);
    const pending = handlePriceRequest(req, deps);
    await vi.advanceTimersByTimeAsync(15_000);
    const out = await pending;
    expectAllEstimated(out, req, 90);
    noLeak(out);
  });

  it("invalid bodies give 400 and zero model calls", async () => {
    const validReq = {
      destination: "Goa",
      activities: [{ id: "a", title: "t", time: "9", kind: "meal" }],
    };
    const badBodyArb = fc.oneof(
      fc.anything().filter((b) => !validatePricerRequest(b).ok),
      fc.constantFrom(null, undefined, 5, "x", [], {}),
      fc.record({ destination: fc.constantFrom("", "   ", 7) }).map((d) => ({ ...validReq, ...d })),
      fc.constant({ ...validReq, activities: [] }),
      fc.string().filter((k) => !KINDS.includes(k as ActivityKind)).map((kind) => ({
        ...validReq,
        activities: [{ id: "a", title: "t", time: "9", kind }],
      })),
      fc.constant({ ...validReq, activities: [{ id: "", title: "t", time: "9", kind: "meal" }] }),
      fc.constant({
        ...validReq,
        activities: Array.from({ length: MAX_ACTIVITIES + 1 }, (_, i) => ({
          id: `i${i}`,
          title: "t",
          time: "9",
          kind: "meal",
        })),
      }),
    );
    await fc.assert(
      fc.asyncProperty(badBodyArb, async (body) => {
        const invoke = vi.fn(async () => "{}");
        const deps = makeDeps(invoke, 90);
        const getSpy = vi.spyOn(deps.cache, "get");
        const out = await handlePriceRequest(body, deps);
        expect(out.status).toBe(400);
        expect(invoke).not.toHaveBeenCalled();
        expect(getSpy).not.toHaveBeenCalled();
        noLeak(out);
      }),
      { numRuns: 100 },
    );
  });
});

describe("activity pricer examples", () => {
  const mk = (n: number) => ({
    destination: "Goa",
    activities: Array.from({ length: n }, (_, i) => ({
      id: `id${i}`,
      title: `Activity ${i}`,
      time: "10:00",
      kind: "other",
    })),
  });

  it("accepts 60 activities", () => {
    expect(validatePricerRequest(mk(60)).ok).toBe(true);
  });

  it("rejects 61 activities", () => {
    expect(validatePricerRequest(mk(61)).ok).toBe(false);
  });

  it("inferKind maps categories directly", () => {
    expect(inferKind("x", "sight")).toBe("entry-ticket");
    expect(inferKind("x", "meal")).toBe("meal");
    expect(inferKind("x", "transfer")).toBe("local-transfer");
    expect(inferKind("x", "leisure")).toBe("other");
  });

  it("inferKind infers from title without a category", () => {
    expect(inferKind("Lunch at a cafe")).toBe("meal");
    expect(inferKind("Airport taxi")).toBe("local-transfer");
    expect(inferKind("Amber Fort visit")).toBe("entry-ticket");
    expect(inferKind("Free time")).toBe("other");
    expect(inferKind("")).toBe("other");
  });

  it("categoryEstimateInr falls back to the static rate for invalid FX", () => {
    expect(categoryEstimateInr("meal", "Goa", NaN)).toBe(categoryEstimateInr("meal", "Goa", USD_INR_FALLBACK));
  });

  it("categoryEstimateInr treats prototype-named destinations as unmapped", () => {
    for (const kind of ["entry-ticket", "meal", "local-transfer", "other"] as const) {
      const base = categoryEstimateInr(kind, "Nowhereville", 95);
      for (const dest of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
        const v = categoryEstimateInr(kind, dest, 95);
        expect(Number.isFinite(v)).toBe(true);
        expect(Number.isInteger(v) && v >= 0).toBe(true);
        expect(v).toBe(base);
      }
    }
  });
});

// ---- web-grounded-pricing (task 5.2) -------------------------------------------------------
import {
  PRICER_TIMEOUT_MS,
  ROUTE_BUDGET_MS,
  RESPONSE_MARGIN_MS,
  MIN_MODEL_MS,
  type PricerRequest,
} from "../lib/activity-pricer";
import { CAPPED_BASIS, capFor, webBoundFor, type CostClass } from "../lib/cost-caps";
import { classifyActivity } from "../lib/cost-classifier";
import { GROUNDING_OPEN } from "../lib/grounding/sanitize";
import { buildEvidenceSet } from "../lib/web-pricing/evidence";
import { placeKeyOf } from "../lib/web-pricing/query-planner";
import type { ResearchResult } from "../lib/web-pricing/service";

const ALL_CLASSES: CostClass[] = ["paid-sight", "free-sight", "meal", "local-transfer", "other"];
const maxBound = Math.max(
  ...ALL_CLASSES.flatMap((c) =>
    (["budget", "mid", "luxury"] as const).flatMap((b) =>
      (["metro", "tier2", "small"] as const).map((t) => webBoundFor(c, b, t)),
    ),
  ),
);

function evSet(key: string, kind: "entry-fee" | "meal" = "entry-fee") {
  return buildEvidenceSet(
    key,
    kind,
    [
      {
        title: "Fort entry ticket price",
        content: "Entry ticket costs Rs 500 per person for Indian adults, open daily.",
        url: "https://example.com/fort",
      },
    ],
    1_000_000,
  );
}

function researchFor(req: Req, status: ResearchResult["status"], withSets: boolean): ResearchResult {
  const targets: ResearchResult["plan"]["targets"] = {};
  const sets: ResearchResult["sets"] = {};
  if (withSets) {
    const a = req.activities[0];
    const key = placeKeyOf("entry-fee", a.id, req.destination);
    targets[a.id] = { key, kind: "entry-fee", name: a.id };
    sets[key] = evSet(key);
  }
  return {
    status,
    plan: { targets, queries: [], retries: {}, route: {} },
    sets,
    stats: { queries: 0, failed: 0, snippets: 0, candidates: 0, ms: 0 },
  };
}

// Feature: web-grounded-pricing, Property 6: Fallback totality
describe("Feature: web-grounded-pricing, Property 6: Fallback totality", () => {
  const outcomeArb = fc.constantFrom("absent", "off", "throws", "none", "ok", "ok-empty-set");
  const modelArb = fc.oneof(
    fc.constant<{ kind: "throw" } | { kind: "text"; text: string }>({ kind: "throw" }),
    fc.string({ maxLength: 60 }).map((text) => ({ kind: "text" as const, text })),
    fc.jsonValue().map((v) => ({ kind: "text" as const, text: JSON.stringify(v) })),
    fc
      .array(
        fc.record({
          idx: fc.nat(20),
          inr: fc.oneof(
            fc.double(),
            fc.integer({ min: -100, max: 1_000_000 }),
            fc.constantFrom("12", "abc", null),
          ),
          source: fc.constantFrom("web", "ai", "x"),
          sourceUrl: fc.constantFrom("https://example.com/fort", "https://evil.example/x", ""),
        }),
        { maxLength: 15 },
      )
      .map((items) => ({ kind: "text" as const, text: JSON.stringify({ items }) })),
  );

  it("always 200, one price per activity in order, finite, bounded; off => no web source", async () => {
    await fc.assert(
      fc.asyncProperty(requestArb, rateArb, outcomeArb, modelArb, async (req, rate, outcome, model) => {
        // Rebuild structured model output so ids belong to the request.
        let text: string | undefined;
        if (model.kind === "text") {
          try {
            const parsed = JSON.parse(model.text) as { items?: { idx: number }[] };
            if (Array.isArray(parsed?.items) && parsed.items.every((i) => typeof i?.idx === "number")) {
              text = JSON.stringify({
                prices: parsed.items.map((i: Record<string, unknown>) => ({
                  id: req.activities[(i.idx as number) % req.activities.length].id,
                  inr: i.inr,
                  basis: "from web",
                  source: i.source,
                  sourceUrl: i.sourceUrl,
                })),
              });
            }
          } catch {
            // plain text stays as is
          }
          text ??= model.text;
        }
        const invoke = vi.fn(async () => {
          if (model.kind === "throw") throw new Error("boom");
          return text as string;
        });
        const research = vi.fn(async (): Promise<ResearchResult> => {
          if (outcome === "throws") throw new Error("search down");
          if (outcome === "off") return researchFor(req, "off", false);
          if (outcome === "none") return researchFor(req, "none", false);
          if (outcome === "ok-empty-set") {
            const r = researchFor(req, "ok", true);
            for (const k of Object.keys(r.sets)) r.sets[k] = { ...r.sets[k], snippets: [] };
            return r;
          }
          return researchFor(req, "ok", true);
        });
        const extra: Partial<PricerDeps> = outcome === "absent" ? {} : { research };
        const out = await handlePriceRequest(req, makeDeps(invoke, rate, extra));
        expect(out.status).toBe(200);
        if (out.status !== 200) return;
        expect(out.body.prices.map((p) => p.id)).toEqual(req.activities.map((a) => a.id));
        for (const p of out.body.prices) {
          expect(Number.isFinite(p.inr)).toBe(true);
          expect(p.inr).toBeGreaterThanOrEqual(0);
          expect(p.inr).toBeLessThanOrEqual(maxBound);
          expect(["ai", "estimated", "web"]).toContain(p.source);
          if (outcome === "absent" || outcome === "off") expect(p.source).not.toBe("web");
        }
        if (outcome === "absent") expect(research).not.toHaveBeenCalled();
        noLeak(out);
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: web-grounded-pricing, Property 9: Research stays inside its time budget and the Bedrock timeout is the minimum
describe("Feature: web-grounded-pricing, Property 9: Bedrock timeout is the minimum and skip rule", () => {
  const req: Req = {
    destination: "Jaipur",
    activities: [{ id: "a1", title: "Amber Fort visit", time: "09:00", kind: "entry-ticket" }],
  };

  async function run(opts: {
    elapsed: number;
    status: ResearchResult["status"] | "absent";
    timeoutMs?: number;
  }) {
    let clock = 5_000_000;
    const spy = vi.spyOn(globalThis, "setTimeout");
    let seenDelay: number | undefined;
    const invoke = vi.fn(async () => {
      seenDelay = spy.mock.calls.at(-1)?.[1] as number | undefined;
      return JSON.stringify({ prices: [{ id: "a1", inr: 100, basis: "typical" }] });
    });
    const deps = makeDeps(invoke, 90, {
      now: () => clock,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.status === "absent"
        ? {}
        : {
            research: async () => {
              clock += opts.elapsed;
              return researchFor(req, opts.status as ResearchResult["status"], false);
            },
          }),
    });
    try {
      const out = await handlePriceRequest(req, deps);
      return { out, invoke, seenDelay };
    } finally {
      spy.mockRestore();
    }
  }

  it("with research the timeout is min(timeoutMs, deadline - now - margin); skipped below MIN_MODEL_MS", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 25_000 }),
        fc.constantFrom("none", "partial", "ok") as fc.Arbitrary<ResearchResult["status"]>,
        fc.option(fc.integer({ min: 1, max: 30_000 }), { nil: undefined }),
        async (elapsed, status, timeoutMs) => {
          const { out, invoke, seenDelay } = await run({ elapsed, status, timeoutMs });
          const expected = Math.min(timeoutMs ?? PRICER_TIMEOUT_MS, ROUTE_BUDGET_MS - elapsed - RESPONSE_MARGIN_MS);
          expect(out.status).toBe(200);
          if (expected < MIN_MODEL_MS) {
            expect(invoke).not.toHaveBeenCalled();
            if (out.status === 200) expect(out.body.prices[0].source).toBe("estimated");
          } else {
            expect(invoke).toHaveBeenCalledTimes(1);
            expect(seenDelay).toBe(expected);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("with research off or absent the timeout stays PRICER_TIMEOUT_MS regardless of elapsed time", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 60_000 }),
        fc.constantFrom<"off" | "absent">("off", "absent"),
        async (elapsed, status) => {
          const { invoke, seenDelay } = await run({ elapsed, status });
          expect(invoke).toHaveBeenCalledTimes(1);
          expect(seenDelay).toBe(PRICER_TIMEOUT_MS);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: web-grounded-pricing, Property 24: Old and new request payloads both validate
describe("Feature: web-grounded-pricing, Property 24: Old and new request payloads both validate", () => {
  it("original-field bodies validate; optional fields keep valid values and ignore invalid ones", () => {
    const optionalArb = fc.record(
      {
        origin: fc.oneof(fc.string({ maxLength: 40 }), fc.constantFrom(5, null, {}, [])),
        budgetLevel: fc.oneof(fc.constantFrom("budget", "mid", "luxury"), fc.string(), fc.constant(3)),
        cityTier: fc.oneof(fc.constantFrom("metro", "tier2", "small"), fc.string(), fc.constant(null)),
        routeFare: fc.oneof(fc.boolean(), fc.constantFrom("yes", 1, null)),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(requestArb, optionalArb, (req, opt) => {
        const plain = validatePricerRequest(req);
        expect(plain.ok).toBe(true);
        if (plain.ok) {
          expect(plain.value.budgetLevel).toBeUndefined();
          expect(plain.value.cityTier).toBeUndefined();
          expect(plain.value.routeFare).toBeUndefined();
          expect(plain.value.origin).toBeUndefined();
        }
        const r = validatePricerRequest({ ...req, ...opt });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const v = r.value;
        const o = opt as Record<string, unknown>;
        const okBudget = ["budget", "mid", "luxury"].includes(o.budgetLevel as string);
        const okTier = ["metro", "tier2", "small"].includes(o.cityTier as string);
        expect(v.budgetLevel).toBe(okBudget ? o.budgetLevel : undefined);
        expect(v.cityTier).toBe(okTier ? o.cityTier : undefined);
        expect(v.routeFare).toBe(typeof o.routeFare === "boolean" ? o.routeFare : undefined);
        if (v.origin !== undefined) expect(v.origin.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });

  it("a response without routeFare or research has neither key", async () => {
    const req: Req = {
      destination: "Goa",
      activities: [{ id: "a", title: "Lunch", time: "13:00", kind: "meal" }],
    };
    const out = await handlePriceRequest(req, makeDeps(async () => "", 90));
    expect(out.status).toBe(200);
    if (out.status === 200) {
      expect("routeFare" in out.body).toBe(false);
      expect("research" in out.body).toBe(false);
      expect(out.body.prices).toHaveLength(1);
    }
  });
});

describe("web-grounded-pricing pricer prompt and clamp examples", () => {
  const req: PricerRequest = {
    destination: "Jaipur",
    budgetLevel: "mid",
    cityTier: "metro",
    activities: [
      { id: "a1", title: "Amber Fort visit", time: "09:00", kind: "entry-ticket" },
      { id: "a2", title: "Lunch at a cafe", time: "13:00", kind: "meal" },
    ],
  };

  async function capturePrompt(research?: ResearchResult) {
    const invoke = vi.fn(async (_p: { system: string; user: string }) => "{}");
    const deps = makeDeps(invoke as unknown as PricerDeps["invoke"], 90, research ? { research: async () => research } : {});
    await handlePriceRequest(req, deps);
    return invoke.mock.calls[0][0];
  }

  it("the prompt carries cap numbers, per-vehicle sentence and the 120-character basis rule", async () => {
    const p = await capturePrompt();
    for (const c of ["paid-sight", "free-sight", "meal", "local-transfer", "other"] as const) {
      expect(p.system).toContain(String(capFor(c, "mid", "metro")));
    }
    expect(p.system).toContain("rupees per vehicle for up to four travellers");
    expect(p.system).toContain("at most 120 characters");
    expect(p.system).not.toContain("Use a quoted amount only");
  });

  it("with evidence the web-source rules and the untrusted marker appear", async () => {
    const r = researchFor(
      { destination: req.destination, activities: [{ ...req.activities[0] }] },
      "ok",
      true,
    );
    const p = await capturePrompt(r);
    expect(p.system).toContain("Use a quoted amount only");
    expect(p.user).toContain(GROUNDING_OPEN);
    expect(p.user).toContain('"evidence":"e1"');
  });

  it("without evidence there are no evidence lines and no marker", async () => {
    const none = await capturePrompt(researchFor({ destination: "Jaipur", activities: req.activities }, "none", false));
    const plain = buildPricingPrompt(req);
    for (const p of [none, plain]) {
      expect(p.user).not.toContain(GROUNDING_OPEN);
      expect(p.user).not.toContain('"evidence"');
      expect(p.system).not.toContain("Use a quoted amount only");
      expect(p.system).not.toContain("routeFare");
    }
  });

  it("a model price of INR 15,000 for a meal is clamped and labelled estimated", async () => {
    const cls = classifyActivity({ title: "Lunch at a cafe" }, { destination: "Jaipur" });
    expect(cls).toBe("meal");
    const invoke = async () =>
      JSON.stringify({ prices: [{ id: "a2", inr: 15000, basis: "model said so" }] });
    const out = await handlePriceRequest(
      { ...req, activities: [req.activities[1]] },
      makeDeps(invoke, 90),
    );
    expect(out.status).toBe(200);
    if (out.status !== 200) return;
    const p = out.body.prices[0];
    expect(p.inr).toBe(capFor("meal", "mid", "metro"));
    expect(p.inr).toBeLessThan(15000);
    expect(p.source).toBe("estimated");
    expect(p.basis).toBe(CAPPED_BASIS);
  });
});
