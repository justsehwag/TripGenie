import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  researchPricing,
  RESEARCH_BUDGET_MS,
  type ResearchConfig,
  type ResearchDeps,
} from "@/lib/web-pricing/service";
import { createEvidenceCache, type EvidenceCache } from "@/lib/web-pricing/evidence-cache";
import { createLimiter } from "@/lib/grounding/limiter";
import { MAX_RESEARCH_QUERIES, type ResearchInput } from "@/lib/web-pricing/query-planner";
import type { SearxngFetch } from "@/lib/providers/searxng";

const SECRET = "s3cret-header-value";
const CONFIG: ResearchConfig = {
  enabled: true,
  baseUrl: "https://sx.example.test",
  secretHeader: { name: "X-Key", value: SECRET },
};

function inputWith(n: number): ResearchInput {
  return {
    destination: "Goa",
    activities: Array.from({ length: n }, (_, i) => ({
      id: `a${i}`,
      title: `Visit Fort Alpha${String.fromCharCode(97 + (i % 26))}${i}`,
      costClass: "paid-sight" as const,
      costBasis: "person" as const,
    })),
  };
}

function okRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Results with no price, so entry-fee keys also try their retry query. */
function bodyFor(q: string, withPrice = false) {
  const tag = q.replace(/[^a-z0-9]/gi, "").slice(0, 12) || "x";
  return {
    results: [1, 2].map((i) => ({
      title: `${tag} page ${i}`,
      content: `A long enough description of ${tag} number ${i} for travellers${withPrice ? ", entry INR 50 per person" : ""}.`,
      url: `https://${tag}${i}.example.org/page`,
      engine: "ddg",
    })),
  };
}

function queryOf(url: string): string {
  return new URL(url).searchParams.get("q") ?? "";
}

function mk(over: Partial<ResearchDeps> = {}): ResearchDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    config: CONFIG,
    cache: createEvidenceCache(),
    limiter: createLimiter(5),
    logger: (l: string) => logs.push(l),
    logs,
    ...over,
  } as ResearchDeps & { logs: string[] };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("researchPricing examples", () => {
  it("flag off and missing base URL make zero requests", async () => {
    const fetchImpl = vi.fn();
    const f = fetchImpl as unknown as SearxngFetch;
    const logs: string[] = [];
    const a = await researchPricing(inputWith(2), mk({ fetchImpl: f, config: { ...CONFIG, enabled: false }, logger: (l) => logs.push(l) }));
    const b = await researchPricing(inputWith(2), mk({ fetchImpl: f, config: { ...CONFIG, baseUrl: "" } }));
    expect(a.status).toBe("off");
    expect(b.status).toBe("off");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it("a redirect gives none and caches nothing", async () => {
    const cache = createEvidenceCache();
    const fetchImpl: SearxngFetch = async () => okRes({}, 302);
    const r = await researchPricing(inputWith(2), mk({ fetchImpl, cache }));
    expect(r.status).toBe("none");
    expect(r.sets).toEqual({});
    expect(cache.size).toBe(0);
  });

  it("two concurrent identical requests send each query once", async () => {
    const seen: string[] = [];
    const fetchImpl: SearxngFetch = async (url) => {
      seen.push(queryOf(url));
      return okRes(bodyFor(queryOf(url), true));
    };
    const shared = mk({ fetchImpl });
    const p1 = researchPricing(inputWith(2), shared);
    const p2 = researchPricing(inputWith(2), { ...shared, logger: () => undefined });
    await vi.advanceTimersByTimeAsync(100);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe("ok");
    expect(r2.status).not.toBe("off");
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("a limiter at capacity makes queries fail after the budget", async () => {
    const limiter = createLimiter(1);
    const hold = limiter.tryAcquire();
    expect(hold).not.toBeNull();
    const fetchImpl = vi.fn();
    const cache = createEvidenceCache();
    const p = researchPricing(inputWith(2), mk({ fetchImpl: fetchImpl as unknown as SearxngFetch, limiter, cache, budgetMs: 1000 }));
    await vi.advanceTimersByTimeAsync(1300);
    const r = await p;
    expect(r.status).toBe("none");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(cache.size).toBe(0);
    expect(limiter.inFlight()).toBe(1);
  });

  it("a throwing cache is a miss and does not throw", async () => {
    const boom = () => {
      throw new Error("cache down");
    };
    const real = createEvidenceCache();
    const cache: EvidenceCache = {
      get: boom,
      set: boom,
      dedupe: (k, p) => real.dedupe(k, p),
      get size() {
        return 0;
      },
    };
    const fetchImpl: SearxngFetch = async (url) => okRes(bodyFor(queryOf(url), true));
    const p = researchPricing(inputWith(1), mk({ fetchImpl, cache }));
    await vi.advanceTimersByTimeAsync(100);
    const r = await p;
    expect(["ok", "partial", "none"]).toContain(r.status);
  });
});

describe("researchPricing properties", () => {
  // Feature: web-grounded-pricing, Property 9: Research stays inside its time budget and the Bedrock timeout is the minimum
  it("Property 9 (research part): resolves in budget + settle, at most 10 searches, no slot held", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 14 }),
        fc.array(fc.integer({ min: 0, max: 12000 }), { minLength: 1, maxLength: 8 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 5 }),
        async (n, latencies, fails, cap) => {
          let calls = 0;
          const fetchImpl: SearxngFetch = (url) => {
            const i = calls++;
            const lat = latencies[i % latencies.length];
            const fail = fails[i % fails.length];
            const q = queryOf(url);
            return new Promise((resolve) => {
              setTimeout(() => resolve(fail ? okRes({}, 500) : okRes(bodyFor(q))), lat);
            });
          };
          const limiter = createLimiter(cap);
          let settled = false;
          const p = researchPricing(inputWith(n), mk({ fetchImpl, limiter })).then((r) => {
            settled = true;
            return r;
          });
          await vi.advanceTimersByTimeAsync(RESEARCH_BUDGET_MS + 200 + 50);
          expect(settled).toBe(true);
          await p;
          expect(calls).toBeLessThanOrEqual(MAX_RESEARCH_QUERIES);
          expect(limiter.inFlight()).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
    // Fake clock: the cost is CPU (25 ms slot polling over an 8 s virtual budget x 100 runs), not waiting.
  }, 60_000);

  // Feature: web-grounded-pricing, Property 10: Research logging contains counts only
  it("Property 10: at most one count-only log line, no query text, URL or header", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 12 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }),
        async (n, fails) => {
          let calls = 0;
          const queries: string[] = [];
          const urls: string[] = [];
          const fetchImpl: SearxngFetch = async (url) => {
            const i = calls++;
            const q = queryOf(url);
            queries.push(q);
            if (fails[i % fails.length]) throw new Error(`boom ${url} ${SECRET}`);
            const body = bodyFor(q, i % 2 === 0);
            for (const r of body.results) urls.push(r.url);
            return okRes(body);
          };
          const d = mk({ fetchImpl });
          const p = researchPricing(inputWith(n), d);
          await vi.advanceTimersByTimeAsync(RESEARCH_BUDGET_MS + 300);
          await p;
          expect(d.logs.length).toBeLessThanOrEqual(1);
          for (const line of d.logs) {
            expect(line).toMatch(/^\[web-pricing\] status=(off|none|partial|ok) queries=\d+ snippets=\d+ candidates=\d+ ms=\d+$/);
            for (const q of queries) expect(line).not.toContain(q);
            for (const u of urls) expect(line).not.toContain(u);
            expect(line).not.toContain(SECRET);
            expect(line).not.toContain("X-Key");
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: web-grounded-pricing, Property 11: Evidence cache TTL, bound and failure rule (failure part)
  it("Property 11 (failure rule): a failed, skipped or abandoned query stores nothing for its key", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }),
        fc.array(fc.constantFrom("ok", "fail", "hang"), { minLength: 1, maxLength: 8 }),
        async (n, modes) => {
          const failedTexts = new Set<string>();
          let calls = 0;
          const fetchImpl: SearxngFetch = (url) => {
            const i = calls++;
            const q = queryOf(url);
            const mode = modes[i % modes.length];
            if (mode === "hang") {
              failedTexts.add(q);
              return new Promise(() => undefined);
            }
            if (mode === "fail") {
              failedTexts.add(q);
              return Promise.resolve(okRes({}, 500));
            }
            return Promise.resolve(okRes(bodyFor(q)));
          };
          const cache = createEvidenceCache();
          const p = researchPricing(inputWith(n), mk({ fetchImpl, cache }));
          await vi.advanceTimersByTimeAsync(RESEARCH_BUDGET_MS + 300);
          const r = await p;
          const anyFailure = failedTexts.size > 0;
          for (const q of r.plan.queries) {
            const retry = r.plan.retries[q.key];
            const bad = failedTexts.has(q.query) || (retry !== undefined && failedTexts.has(retry));
            if (bad) expect(cache.get(q.key, Date.now())).toBeUndefined();
          }
          if (anyFailure) expect(r.status).not.toBe("ok");
        },
      ),
      { numRuns: 100 },
    );
  });
});
