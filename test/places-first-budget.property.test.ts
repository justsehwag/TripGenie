import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { BatchRequest } from "@/lib/itinerary/batch-wire";
import { createCandidateCache, type CandidateCache } from "@/lib/itinerary/candidate-search";
import { BATCH_DAYS, MAX_PLACES_REQUESTS_PER_BATCH, MAX_PLACES_REQUESTS_PER_TRIP, PLACES_PHASE_END_MS } from "@/lib/itinerary/constants";
import { planCandidateQueries } from "@/lib/itinerary/interests";
import { batchRanges } from "@/lib/itinerary/pace";
import { runPlacesFirstBatch, type PlacesFirstDeps } from "@/lib/itinerary/places-first-batch";
import { clearPolishMemo } from "@/lib/itinerary/polish";
import type { ResearchConfig } from "@/lib/web-pricing/service";

// Feature: places-first-itinerary, Property 9: Places requests stay within the budget and failures are never cached
// **Validates: Requirements 1.10, 5.1, 5.2, 5.5, 5.6, 5.10, 5.11, 9.1, 9.3, 9.4**

const SEARX_OFF: ResearchConfig = { enabled: false, baseUrl: "", secretHeader: null };
const NUM_RUNS = 120;
const PLANNED_FLOW_CAP = 7; // 4 text + 1 nearby + 2 widening steps (the centre lookup is not counted)
const CENTRE = { lat: 15.4989, lng: 73.8278 };
const T0 = 5_000_000;

type Mode = "ok" | "throw" | "http500" | "malformed" | "badjson" | "429";

interface CandidateCall {
  kind: "text" | "nearby";
  startedAt: number;
  mode: Mode;
  /** a 429 had already been returned in this batch when this request started */
  afterRateLimit: boolean;
}

/** Fake Places backend. Counts candidate requests apart from the destination-centre lookup. */
class World {
  clock = T0;
  centreCalls = 0;
  candidate: CandidateCall[] = [];
  bodies: string[] = [];
  rateLimitSeen = false;
  constructor(
    public step: number,
    public modes: Mode[],
    public poolSize: number,
    public centreOk: boolean,
  ) {}

  now = (): number => this.clock;

  startBatch(): void {
    this.rateLimitSeen = false;
  }

  fetchImpl = async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    const startedAt = this.clock;
    this.clock += this.step;
    const mask = init?.headers?.["X-Goog-FieldMask"] ?? "";
    const nearby = url.endsWith(":searchNearby");
    if (!nearby && mask === "places.id,places.location") {
      this.centreCalls += 1;
      if (!this.centreOk) return res(500, {});
      return res(200, { places: [{ id: "centre", location: { latitude: CENTRE.lat, longitude: CENTRE.lng } }] });
    }
    const idx = this.candidate.length;
    this.bodies.push(init?.body ?? "");
    const mode: Mode = this.modes[idx % Math.max(1, this.modes.length)] ?? "ok";
    const effective: Mode = this.modes.length === 0 ? "ok" : mode;
    this.candidate.push({ kind: nearby ? "nearby" : "text", startedAt, mode: effective, afterRateLimit: this.rateLimitSeen });
    if (this.settled === 0) this.firstGroup.push(init?.body ?? "");
    try {
      return await this.answer(effective, init?.body ?? "");
    } finally {
      this.settled += 1;
    }
  };

  /** Candidate requests sent before any candidate response came back (the parallel first group). */
  firstGroup: string[] = [];
  settled = 0;

  private answer = async (effective: Mode, requestBody: string) => {
    switch (effective) {
      case "throw":
        throw new Error("timeout");
      case "http500":
        return res(500, {});
      case "malformed":
        return res(200, { places: "not-an-array" });
      case "badjson":
        return { ok: true, status: 200, json: async () => null };
      case "429":
        await Promise.resolve(); // the 429 counts as seen once it has been delivered, not when the sibling requests were sent
        this.rateLimitSeen = true;
        return res(429, { error: { status: "RESOURCE_EXHAUSTED" } });
      default:
        return res(200, { places: makePlaces(requestBody, this.poolSize) });
    }
  };

  get fetchCount(): number {
    return this.candidate.length;
  }
}

function res(status: number, json: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => json };
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h.toString(36);
}

/** Distinct places per request body, so every query adds new candidates. */
function makePlaces(body: string, n: number) {
  const h = hash(body);
  const types = ["tourist_attraction", "museum", "park", "restaurant"];
  const out = [];
  for (let i = 0; i < n; i++) {
    const type = types[i % types.length];
    out.push({
      id: `p-${h}-${i}`,
      displayName: { text: `Spot ${h} ${i} ${type}` },
      formattedAddress: `Road ${i}, Goa 403001, India`,
      location: { latitude: CENTRE.lat + (i % 7) * 0.004, longitude: CENTRE.lng + (i % 5) * 0.004 },
      businessStatus: "OPERATIONAL",
      types: [type, "point_of_interest", "establishment"],
      primaryType: type,
      rating: 4.3,
      userRatingCount: 900 - i,
    });
  }
  return out;
}

/** A cache that records what is stored. */
function spyCache(): { cache: CandidateCache; sets: string[] } {
  const inner = createCandidateCache();
  const sets: string[] = [];
  return {
    sets,
    cache: {
      get: (k, t) => inner.get(k, t),
      set: (k, v, t) => {
        sets.push(k);
        inner.set(k, v, t);
      },
    },
  };
}

let destCounter = 0;

function requestFor(
  s: { interests: string[]; pace: "relaxed" | "balanced" | "packed"; totalDays: number },
  dest: string,
  range: { fromDay: number; dayCount: number },
): BatchRequest {
  return {
    action: "itinerary-batch",
    context: { destination: dest, durationDays: s.totalDays, pace: s.pace, interests: s.interests },
    fromDay: range.fromDay,
    dayCount: range.dayCount,
    usedPlaces: [],
  } as BatchRequest;
}

function depsFor(world: World, cache: CandidateCache, lines: string[]): PlacesFirstDeps {
  return {
    hasKey: () => true,
    now: world.now,
    logger: (l) => void lines.push(l),
    diagLogger: () => undefined,
    candidateCache: cache,
    fetchImpl: world.fetchImpl,
    enrichment: { config: SEARX_OFF },
  };
}

function logCount(line: string, field: "places" | "cached"): number {
  const m = new RegExp(` ${field}=(\\d+)`).exec(line);
  if (!m) throw new Error(`log line has no ${field}=: ${line}`);
  return Number(m[1]);
}

const INTERESTS = ["culture", "food", "nature", "history", "beaches", "nightlife", "shopping", "art", "free text xyzzy"];
const modeArb: fc.Arbitrary<Mode> = fc.constantFrom<Mode>("ok", "ok", "ok", "throw", "http500", "malformed", "badjson", "429");
const scenarioArb = fc.record({
  interests: fc.array(fc.constantFrom(...INTERESTS), { maxLength: 4 }),
  pace: fc.constantFrom<"relaxed" | "balanced" | "packed">("relaxed", "balanced", "packed"),
  totalDays: fc.integer({ min: 1, max: 14 }),
  batchPick: fc.nat(4),
  poolSize: fc.integer({ min: 0, max: 20 }),
  modes: fc.array(modeArb, { maxLength: 9 }),
  step: fc.integer({ min: 0, max: 4500 }),
  centreOk: fc.constantFrom(true, true, true, false),
});
type ArbValue<A> = A extends fc.Arbitrary<infer T> ? T : never;
type Scenario = ArbValue<typeof scenarioArb>;

function rangeOf(s: Scenario) {
  const ranges = batchRanges(s.totalDays);
  return ranges[s.batchPick % ranges.length];
}

function plannedCount(s: Scenario, range: { fromDay: number }, centreOk: boolean, dest: string): number {
  const plan = planCandidateQueries({
    destination: dest,
    interests: s.interests,
    batchIndex: Math.max(0, Math.floor((range.fromDay - 1) / BATCH_DAYS)),
  });
  return plan.textQueries.length + (centreOk ? 1 : 0);
}

beforeEach(() => {
  vi.stubEnv("GOOGLE_PLACES_API_KEY", "unit-test-places-key");
  clearPolishMemo();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Property 9: Places budget and failures", () => {
  // Feature: places-first-itinerary, Property 9: Places requests stay within the budget and failures are never cached
  it("one batch: cap, deadline, 429, widening, cache writes and day partition hold under random failures", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (s) => {
        const dest = `Dest${++destCounter}`;
        const world = new World(s.step, s.modes, s.poolSize, s.centreOk);
        const { cache, sets } = spyCache();
        const lines: string[] = [];
        const range = rangeOf(s);
        const resp = await runPlacesFirstBatch(requestFor(s, dest, range), s.totalDays, depsFor(world, cache, lines));

        // cap 8 per batch, and 7 in the planned flow; widening runs at most twice
        expect(world.fetchCount).toBeLessThanOrEqual(MAX_PLACES_REQUESTS_PER_BATCH);
        expect(world.fetchCount).toBeLessThanOrEqual(PLANNED_FLOW_CAP);
        expect(world.fetchCount).toBeLessThanOrEqual(plannedCount(s, range, s.centreOk, dest) + 2);

        // the log counts exactly the uncached candidate requests
        expect(lines).toHaveLength(1);
        expect(logCount(lines[0], "places")).toBe(world.fetchCount);

        // no request after a 429, none at or after the phase deadline
        for (const c of world.candidate) {
          if (c.afterRateLimit) throw new Error(`request after 429: ${JSON.stringify(world.candidate)}`);
          expect(c.startedAt).toBeLessThan(T0 + PLACES_PHASE_END_MS);
        }

        // failures add nothing to the cache; every success is kept
        const okFetches = world.candidate.filter((c) => c.mode === "ok").length;
        expect(sets).toHaveLength(okFetches);
        expect(new Set(sets).size).toBe(sets.length);

        // days built are returned, every other requested day is withheld
        const requested = Array.from({ length: range.dayCount }, (_, i) => range.fromDay + i);
        expect([...resp.verifiedDays, ...resp.withheldDays].sort((a, b) => a - b)).toEqual(requested);
        expect(resp.days.map((d) => d.day).sort((a, b) => a - b)).toEqual([...resp.verifiedDays].sort((a, b) => a - b));
        for (const d of resp.days) expect(d.activities.length).toBeGreaterThanOrEqual(1);
        if (resp.source === "unavailable") expect(resp.days).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: places-first-itinerary, Property 9: Places requests stay within the budget and failures are never cached
  it("a 429 at any position stops every later request and withholds the unbuilt days", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, fc.integer({ min: 0, max: 7 }), async (s, k) => {
        const dest = `Dest${++destCounter}`;
        const modes: Mode[] = Array.from({ length: 8 }, (_, i) => (i === k ? "429" : "ok"));
        const world = new World(0, modes, s.poolSize, s.centreOk);
        const { cache, sets } = spyCache();
        const lines: string[] = [];
        const range = rangeOf(s);
        const resp = await runPlacesFirstBatch(requestFor(s, dest, range), s.totalDays, depsFor(world, cache, lines));

        const n = world.fetchCount;
        // requests started before the 429 was returned (the parallel first group) may exist; none after it
        expect(world.candidate.every((c) => !c.afterRateLimit)).toBe(true);
        // a 429 returned at index k means at most the first group plus nothing more
        const firstGroup = plannedCount(s, range, s.centreOk, dest);
        if (k < n) expect(n).toBeLessThanOrEqual(Math.max(firstGroup, k + 1));
        // the 429 itself is never cached; successes are
        expect(sets).toHaveLength(world.candidate.filter((c) => c.mode === "ok").length);
        const requested = Array.from({ length: range.dayCount }, (_, i) => range.fromDay + i);
        expect([...resp.verifiedDays, ...resp.withheldDays].sort((a, b) => a - b)).toEqual(requested);
        if (world.candidate.some((c) => c.mode === "429") && resp.source === "model") {
          expect(resp.days.map((d) => d.day).sort((a, b) => a - b)).toEqual([...resp.verifiedDays].sort((a, b) => a - b));
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: places-first-itinerary, Property 9: Places requests stay within the budget and failures are never cached
  it("a rich pool never widens", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (s) => {
        const dest = `Dest${++destCounter}`;
        const world = new World(0, [], 20, true);
        const lines: string[] = [];
        const range = rangeOf(s);
        // no interest filter: the fixture's place types are general sights and restaurants
        const resp = await runPlacesFirstBatch(requestFor({ ...s, interests: [] }, dest, range), s.totalDays, depsFor(world, createCandidateCache(), lines));
        const planned = plannedCount({ ...s, interests: [] }, range, true, dest);
        // 20 distinct places per request: every day reaches its minimum from the first group, so widening stops at once
        expect(resp.withheldDays).toEqual([]);
        expect(resp.days).toHaveLength(range.dayCount);
        expect(world.fetchCount).toBeLessThanOrEqual(planned);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: places-first-itinerary, Property 9: Places requests stay within the budget and failures are never cached
  it("five batches of one trip with a fresh cache send at most 40", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (s) => {
        const dest = `Dest${++destCounter}`;
        const world = new World(s.step, s.modes, s.poolSize, s.centreOk);
        const { cache } = spyCache();
        const lines: string[] = [];
        const totalDays = 14;
        const ranges = batchRanges(totalDays);
        expect(ranges).toHaveLength(5);
        let logged = 0;
        for (const range of ranges) {
          world.startBatch();
          const before = world.fetchCount;
          await runPlacesFirstBatch(requestFor({ ...s, totalDays }, dest, range), totalDays, depsFor(world, cache, lines));
          expect(world.fetchCount - before).toBeLessThanOrEqual(MAX_PLACES_REQUESTS_PER_BATCH);
          logged += logCount(lines[lines.length - 1], "places");
        }
        expect(world.fetchCount).toBeLessThanOrEqual(MAX_PLACES_REQUESTS_PER_TRIP);
        expect(logged).toBe(world.fetchCount);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: places-first-itinerary, Property 9: Places requests stay within the budget and failures are never cached
  it("cache hits are free and an identical repeat batch sends zero uncached requests", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (s) => {
        const dest = `Dest${++destCounter}`;
        const world = new World(0, [], s.poolSize, s.centreOk);
        const { cache } = spyCache();
        const lines: string[] = [];
        const range = rangeOf(s);
        const req = requestFor(s, dest, range);
        const first = await runPlacesFirstBatch(req, s.totalDays, depsFor(world, cache, lines));
        const sentFirst = world.fetchCount;
        expect(logCount(lines[0], "places")).toBe(sentFirst);

        const second = await runPlacesFirstBatch(req, s.totalDays, depsFor(world, cache, lines));
        expect(world.fetchCount).toBe(sentFirst); // zero new candidate requests
        expect(logCount(lines[1], "places")).toBe(0);
        // every request of the first run is a free cache hit now
        expect(logCount(lines[1], "cached")).toBeGreaterThanOrEqual(sentFirst);
        expect(second.verifiedDays).toEqual(first.verifiedDays);
        expect(second.withheldDays).toEqual(first.withheldDays);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: places-first-itinerary, Property 9: Places requests stay within the budget and failures are never cached
  it("a failed request is retried on the next batch instead of being served from the cache", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, fc.constantFrom<Mode>("throw", "http500", "malformed", "badjson", "429"), async (s, bad) => {
        const dest = `Dest${++destCounter}`;
        const range = rangeOf(s);
        const req = requestFor(s, dest, range);
        const { cache, sets } = spyCache();
        const lines: string[] = [];
        // run 1: every candidate request fails
        const w1 = new World(0, [bad], s.poolSize, s.centreOk);
        const r1 = await runPlacesFirstBatch(req, s.totalDays, depsFor(w1, cache, lines));
        expect(sets).toHaveLength(0);
        expect(r1.days).toEqual([]);
        expect(r1.verifiedDays).toEqual([]);
        // run 2: the same requests are sent again (nothing was cached)
        const w2 = new World(0, [], s.poolSize, s.centreOk);
        await runPlacesFirstBatch(req, s.totalDays, depsFor(w2, cache, lines));
        expect(w2.fetchCount).toBeGreaterThanOrEqual(1);
        // every request of the first group that failed is sent again
        expect(w1.firstGroup.length).toBeGreaterThanOrEqual(1);
        const resent = new Set(w2.bodies);
        for (const b of w1.firstGroup) expect(resent.has(b)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
