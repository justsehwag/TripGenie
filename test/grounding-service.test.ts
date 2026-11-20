import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groundItinerary, GROUNDING_BUDGET_MS, LOG_TAG, type GroundingDeps } from "@/lib/grounding/service";
import { createGroundingCache } from "@/lib/grounding/cache";
import { createLimiter } from "@/lib/grounding/limiter";
import type { SearxngFetch } from "@/lib/providers/searxng";

const CONFIG = { enabled: true, baseUrl: "https://sx.example.test", secretHeader: { name: "X-Key", value: "s3cret" } };
const INPUT = { destination: "Goa", durationDays: 3, vibe: "beach", budgetLevel: "mid" };

function resultsFor(tag: string) {
  return {
    results: [1, 2].map((i) => ({
      title: `${tag} place ${i}`,
      content: `A long enough description of ${tag} place ${i} for travellers.`,
      url: `https://${tag}${i}.example.org/page`,
      engine: "ddg",
    })),
  };
}

function okRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function deps(over: Partial<GroundingDeps> = {}): GroundingDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    config: CONFIG,
    cache: createGroundingCache(),
    limiter: createLimiter(5),
    logger: (l) => logs.push(l),
    logs,
    ...over,
  } as GroundingDeps & { logs: string[] };
}

describe("groundItinerary", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("disabled when flag off or base URL missing, with 0 requests", async () => {
    const fetchImpl = vi.fn();
    const a = await groundItinerary(INPUT, deps({ fetchImpl: fetchImpl as unknown as SearxngFetch, config: { ...CONFIG, enabled: false } }));
    const b = await groundItinerary(INPUT, deps({ fetchImpl: fetchImpl as unknown as SearxngFetch, config: { ...CONFIG, baseUrl: "" } }));
    expect(a.status).toBe("disabled");
    expect(b.status).toBe("disabled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("empty with 0 requests for an empty destination", async () => {
    const fetchImpl = vi.fn();
    const r = await groundItinerary({ destination: "  " }, deps({ fetchImpl: fetchImpl as unknown as SearxngFetch }));
    expect(r.status).toBe("empty");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("ok when all queries succeed with snippets", async () => {
    let n = 0;
    const fetchImpl: SearxngFetch = async () => okRes(resultsFor(`q${n++}`));
    const r = await groundItinerary(INPUT, deps({ fetchImpl }));
    expect(r.status).toBe("ok");
    expect(r.snippets.length).toBeGreaterThan(0);
  });

  it("empty when all queries succeed with no usable results", async () => {
    const fetchImpl: SearxngFetch = async () => okRes({ results: [] });
    const r = await groundItinerary(INPUT, deps({ fetchImpl }));
    expect(r.status).toBe("empty");
    expect(r.snippets).toEqual([]);
  });

  it("partial when one query fails, unavailable when all fail", async () => {
    let n = 0;
    const partial: SearxngFetch = async () => {
      const i = n++;
      if (i === 1) throw new Error("boom https://leak.example");
      return okRes(resultsFor(`p${i}`));
    };
    expect((await groundItinerary(INPUT, deps({ fetchImpl: partial }))).status).toBe("partial");
    const down: SearxngFetch = async () => okRes({}, 500);
    expect((await groundItinerary(INPUT, deps({ fetchImpl: down }))).status).toBe("unavailable");
  });

  it("starts all three queries in parallel", async () => {
    const started: number[] = [];
    const fetchImpl: SearxngFetch = (url) =>
      new Promise(() => {
        started.push(started.length);
        void url;
      });
    const p = groundItinerary(INPUT, deps({ fetchImpl }));
    await vi.advanceTimersByTimeAsync(0);
    expect(started.length).toBe(3);
    await vi.advanceTimersByTimeAsync(GROUNDING_BUDGET_MS + 10);
    await p;
  });

  it("stops at the 3000 ms budget with a fetch that ignores abort, keeps collected snippets, releases slots", async () => {
    let n = 0;
    const fetchImpl: SearxngFetch = () => {
      const i = n++;
      if (i === 0) return Promise.resolve(okRes(resultsFor("fast")));
      return new Promise(() => undefined); // never settles, ignores signal
    };
    const limiter = createLimiter(5);
    const p = groundItinerary(INPUT, deps({ fetchImpl, limiter, budgetMs: 1000 }));
    await vi.advanceTimersByTimeAsync(1001);
    const r = await p;
    expect(r.status).toBe("partial");
    expect(r.snippets.length).toBeGreaterThan(0);
    expect(limiter.inFlight()).toBe(0);
  });

  it("unavailable when the whole budget passes with no results", async () => {
    const fetchImpl: SearxngFetch = () => new Promise(() => undefined);
    const limiter = createLimiter(5);
    const p = groundItinerary(INPUT, deps({ fetchImpl, limiter }));
    await vi.advanceTimersByTimeAsync(GROUNDING_BUDGET_MS + 1);
    expect((await p).status).toBe("unavailable");
    expect(limiter.inFlight()).toBe(0);
  });

  it("returns unavailable at once when no slot is free", async () => {
    const limiter = createLimiter(0);
    const fetchImpl = vi.fn();
    const r = await groundItinerary(INPUT, deps({ fetchImpl: fetchImpl as unknown as SearxngFetch, limiter }));
    expect(r.status).toBe("unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips queries without a slot and marks the bundle partial", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => okRes(resultsFor(`s${n++}`)));
    const r = await groundItinerary(INPUT, deps({ fetchImpl: fetchImpl as unknown as SearxngFetch, limiter: createLimiter(2) }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(r.status).toBe("partial");
  });

  it("a cache hit makes 0 requests; unavailable is not cached", async () => {
    const cache = createGroundingCache();
    let n = 0;
    const fetchImpl = vi.fn(async () => okRes(resultsFor(`c${n++}`)));
    const first = await groundItinerary(INPUT, deps({ fetchImpl: fetchImpl as unknown as SearxngFetch, cache }));
    expect(first.status).toBe("ok");
    const calls = fetchImpl.mock.calls.length;
    const second = await groundItinerary({ ...INPUT, destination: " GOA " }, deps({ fetchImpl: fetchImpl as unknown as SearxngFetch, cache }));
    expect(second.status).toBe("ok");
    expect(fetchImpl.mock.calls.length).toBe(calls);

    const cache2 = createGroundingCache();
    const down = vi.fn(async () => okRes({}, 500));
    await groundItinerary(INPUT, deps({ fetchImpl: down as unknown as SearxngFetch, cache: cache2 }));
    await groundItinerary(INPUT, deps({ fetchImpl: down as unknown as SearxngFetch, cache: cache2 }));
    expect(down).toHaveBeenCalledTimes(6);
  });

  it("any redirect gives unavailable with no snippets", async () => {
    let n = 0;
    const fetchImpl: SearxngFetch = async () => {
      const i = n++;
      return i === 0 ? okRes({}, 302) : okRes(resultsFor(`r${i}`));
    };
    const r = await groundItinerary(INPUT, deps({ fetchImpl }));
    expect(r.status).toBe("unavailable");
    expect(r.snippets).toEqual([]);
  });

  it("logs one line with tag, status, count and ms, and no query text or secrets", async () => {
    const fetchImpl: SearxngFetch = async () => okRes(resultsFor("log"));
    const d = deps({ fetchImpl });
    await groundItinerary(INPUT, d);
    expect(d.logs).toHaveLength(1);
    expect(LOG_TAG).toBe("[searxng-grounding]");
    expect(d.logs[0]).toMatch(/^\[searxng-grounding\] status=\w+ snippets=\d+ ms=\d+$/);
    for (const secret of ["Goa", "beach", "sx.example.test", "s3cret", "X-Key"]) {
      expect(d.logs[0]).not.toContain(secret);
    }
  });

  it("never throws when a dependency throws", async () => {
    const cache = createGroundingCache();
    const r = await groundItinerary(INPUT, deps({ cache, now: () => { throw new Error("x"); }, fetchImpl: (async () => { throw new Error("y"); }) as SearxngFetch }));
    expect(["unavailable", "empty", "partial", "ok"]).toContain(r.status);
  });
});
