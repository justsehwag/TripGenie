// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  createCandidateCache,
  createPlacesBudget,
  nearbyCacheKey,
  searchNearby,
  searchText,
  textCacheKey,
} from "@/lib/itinerary/candidate-search";

const ok = (places: unknown[]) => ({ ok: true, status: 200, json: async () => ({ places }) });
const fail = (status: number, body: unknown = {}) => ({ ok: false, status, json: async () => body, text: async () => JSON.stringify(body) });
const place = (id: string) => ({
  id,
  displayName: { text: `Place ${id}` },
  formattedAddress: "addr",
  location: { latitude: 1, longitude: 2 },
  types: ["museum"],
});

function setup(responder: (url: string, n: number) => unknown, opts: { max?: number; deadline?: number } = {}) {
  let clock = 1000;
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    return responder(url, calls.length);
  }) as never;
  const budget = createPlacesBudget({ maxRequests: opts.max ?? 8, deadlineMs: opts.deadline ?? 11_000, now: () => clock });
  const cache = createCandidateCache();
  return { calls, deps: { fetchImpl, cache, now: () => clock, budget }, budget, cache, setClock: (t: number) => (clock = t) };
}

describe("keys", () => {
  it("normalises text keys and sorts nearby types", () => {
    expect(textCacheKey("  Museums IN Goa ")).toBe("museums in goa");
    expect(nearbyCacheKey({ lat: 15.29961, lng: 74.12399 }, 6000, ["park", "museum"])).toBe(
      "nearby|15.300,74.124|6000|museum,park",
    );
    expect(nearbyCacheKey({ lat: 1, lng: 2 }, 6000, ["a"])).not.toBe(textCacheKey("a"));
  });
});

describe("createPlacesBudget", () => {
  it("stops at the cap, at the deadline and after rate limiting", () => {
    let t = 0;
    const b = createPlacesBudget({ maxRequests: 2, deadlineMs: 100, now: () => t });
    expect(b.tryReserve()).toBe(true);
    expect(b.tryReserve()).toBe(true);
    expect(b.tryReserve()).toBe(false);
    expect(b.sent).toBe(2);
    const d = createPlacesBudget({ maxRequests: 5, deadlineMs: 100, now: () => t });
    t = 100;
    expect(d.tryReserve()).toBe(false);
    t = 0;
    const r = createPlacesBudget({ maxRequests: 5, deadlineMs: 100, now: () => t });
    r.markRateLimited();
    expect(r.tryReserve()).toBe(false);
    expect(r.rateLimited).toBe(true);
  });
});

describe("createCandidateCache", () => {
  it("expires, evicts the oldest and stores empty lists", () => {
    const c = createCandidateCache(2, 100);
    c.set("a", [], 0);
    expect(c.get("a", 50)).toEqual([]);
    c.set("b", [], 10);
    c.set("c", [], 20);
    expect(c.get("a", 30)).toBeUndefined();
    expect(c.get("b", 30)).toEqual([]);
    expect(c.get("b", 110)).toBeUndefined();
  });
});

describe("searchText / searchNearby", () => {
  beforeEach(() => vi.stubEnv("GOOGLE_PLACES_API_KEY", "test-key"));
  afterEach(() => vi.unstubAllEnvs());

  it("serves a repeat from cache without using the budget", async () => {
    const s = setup(() => ok([place("p1")]));
    const first = await searchText("Museums in Goa", s.deps);
    const second = await searchText(" museums in goa ", s.deps);
    expect(first?.map((p) => p.placeId)).toEqual(["p1"]);
    expect(second).toEqual(first);
    expect(s.calls.length).toBe(1);
    expect(s.budget.sent).toBe(1);
    expect(s.budget.cacheHits).toBe(1);
  });

  it("caches an empty success but not a failure", async () => {
    const e = setup(() => ok([]));
    expect(await searchText("q", e.deps)).toEqual([]);
    expect(await searchText("q", e.deps)).toEqual([]);
    expect(e.calls.length).toBe(1);

    const f = setup(() => fail(500));
    expect(await searchText("q", f.deps)).toBeNull();
    expect(await searchText("q", f.deps)).toBeNull();
    expect(f.calls.length).toBe(2);
    expect(f.budget.sent).toBe(2);
    expect(f.budget.rateLimited).toBe(false);
  });

  it("de-duplicates concurrent identical queries", async () => {
    const s = setup(() => ok([place("p1")]));
    const [a, b] = await Promise.all([searchText("x", s.deps), searchText("X", s.deps)]);
    expect(a).toEqual(b);
    expect(s.calls.length).toBe(1);
    expect(s.budget.sent).toBe(1);
  });

  it("refuses the request past the cap and does not cache the refusal", async () => {
    const s = setup(() => ok([place("p1")]), { max: 1 });
    expect(await searchText("a", s.deps)).not.toBeNull();
    expect(await searchText("b", s.deps)).toBeNull();
    expect(await searchNearby({ lat: 1, lng: 2 }, 6000, ["museum"], s.deps)).toBeNull();
    expect(s.calls.length).toBe(1);
    expect(s.cache.get(textCacheKey("b"), 1000)).toBeUndefined();
  });

  it("refuses after the deadline", async () => {
    const s = setup(() => ok([]), { deadline: 2000 });
    s.setClock(2000);
    expect(await searchText("a", s.deps)).toBeNull();
    expect(s.calls.length).toBe(0);
  });

  it("stops the batch on a rate-limited answer", async () => {
    const s = setup(() => fail(429));
    expect(await searchText("a", s.deps)).toBeNull();
    expect(s.budget.rateLimited).toBe(true);
    expect(await searchText("b", s.deps)).toBeNull();
    expect(s.calls.length).toBe(1);
  });

  it("caches nearby results under the centre, radius and types key", async () => {
    const s = setup(() => ok([place("n1")]));
    const c = { lat: 15.2996, lng: 74.124 };
    expect((await searchNearby(c, 6000, ["park", "museum"], s.deps))?.length).toBe(1);
    expect((await searchNearby(c, 6000, ["museum", "park"], s.deps))?.length).toBe(1);
    expect(s.calls.length).toBe(1);
    await searchNearby(c, 12000, ["museum", "park"], s.deps);
    expect(s.calls.length).toBe(2);
  });
});
