import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BatchRequest } from "@/lib/itinerary/batch-wire";
import { createCandidateCache } from "@/lib/itinerary/candidate-search";
import { runPlacesFirstBatch, type PlacesFirstDeps } from "@/lib/itinerary/places-first-batch";
import { clearPolishMemo } from "@/lib/itinerary/polish";
import type { ModelPrompt } from "@/lib/bedrock-model";
import type { ResearchConfig } from "@/lib/web-pricing/service";

const TEST_KEY = "unit-test-places-key";
const SEARX_ON: ResearchConfig = { enabled: true, baseUrl: "https://sx.example.test", secretHeader: null };
const SEARX_OFF: ResearchConfig = { enabled: false, baseUrl: "", secretHeader: null };

const REQ: BatchRequest = {
  action: "itinerary-batch",
  context: { destination: "Goa", durationDays: 4, pace: "balanced", interests: [] },
  fromDay: 1,
  dayCount: 4,
  usedPlaces: [],
};

// ---- injected Places JSON (Goa) -------------------------------------------

const CENTRE = { lat: 15.4989, lng: 73.8278 };

interface Spec {
  id: string;
  name: string;
  type: string;
}

function spec(prefix: string, names: string[], type: string): Spec[] {
  return names.map((n, i) => ({ id: `${prefix}${i}`, name: n, type }));
}

const ATTRACTIONS = spec(
  "att",
  ["Chapora Fort Lookout", "Basilica of Bom Jesus", "Se Cathedral Old Goa", "Fort Aguada Lighthouse", "Reis Magos Fort", "Mangueshi Temple", "Dudhsagar Falls View", "Cabo de Rama Fort"],
  "tourist_attraction",
);
const MUSEUMS = spec("mus", ["Goa State Museum", "Naval Aviation Museum", "Big Foot Cross Museum", "Houses of Goa Museum", "Christian Art Museum", "Archaeological Museum Old Goa"], "museum");
const PARKS = spec("prk", ["Salim Ali Bird Sanctuary", "Carambolim Lake Park", "Mayem Lake Garden", "Bhagwan Mahavir Wildlife Park", "Panjim Waterfront Park", "Campal Garden"], "park");
const FOOD = spec("rst", ["Fisherman Wharf Kitchen", "Gunpowder Table", "Vinayak Family Restaurant", "Mum Kitchen Panjim", "Bomras Seafood", "Pousada by the Beach", "Ritz Classic Thali", "Cafe Bhonsle"], "restaurant");
const NEARBY = spec("nby", ["Baga Beach Shack Row", "Anjuna Flea Market", "Vagator Cliff Point", "Palolem Beach Walk", "Colva Beach Stretch", "Miramar Beach Edge"], "tourist_attraction");

const ALL_SPECS = [...ATTRACTIONS, ...MUSEUMS, ...PARKS, ...FOOD, ...NEARBY];
const ALL_IDS = new Set(ALL_SPECS.map((s) => s.id));
const ALL_NAMES = ALL_SPECS.map((s) => s.name);

function place(s: Spec, i: number) {
  return {
    id: s.id,
    displayName: { text: s.name },
    formattedAddress: `Main Road, ${["Calangute", "Panaji", "Old Goa", "Candolim"][i % 4]}, Goa 403001, India`,
    location: { latitude: CENTRE.lat + (i % 7) * 0.004, longitude: CENTRE.lng + (i % 5) * 0.004 },
    businessStatus: "OPERATIONAL",
    types: [s.type, "point_of_interest", "establishment"],
    primaryType: s.type,
    rating: 4.3,
    userRatingCount: 1200 - i * 10,
  };
}

function body(list: Spec[]) {
  return { places: list.map(place) };
}

function textSet(query: string): Spec[] {
  const q = query.toLowerCase();
  if (q.includes("restaurants")) return FOOD;
  if (q.includes("museums")) return MUSEUMS;
  if (q.includes("parks")) return PARKS;
  return ATTRACTIONS;
}

interface Call {
  kind: "centre" | "text" | "nearby";
  query: string;
}

function res(status: number, json: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => json };
}

function placesFetch(mode: "ok" | "only-attractions" | "all-fail" = "ok", order: string[] = []) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    const mask = init?.headers?.["X-Goog-FieldMask"] ?? "";
    const payload = init?.body ? (JSON.parse(init.body) as { textQuery?: string }) : {};
    if (url.endsWith(":searchNearby")) {
      calls.push({ kind: "nearby", query: "" });
      order.push("places");
      if (mode === "all-fail") return res(500, {});
      if (mode === "only-attractions") return res(429, { error: { status: "RESOURCE_EXHAUSTED" } });
      return res(200, body(NEARBY));
    }
    if (mask === "places.id,places.location") {
      calls.push({ kind: "centre", query: "" });
      return res(200, { places: [{ id: "centre", location: { latitude: CENTRE.lat, longitude: CENTRE.lng } }] });
    }
    const q = payload.textQuery ?? "";
    calls.push({ kind: "text", query: q });
    order.push("places");
    if (mode === "all-fail") return res(500, {});
    if (mode === "only-attractions") {
      return q.toLowerCase().includes("tourist attractions")
        ? res(200, body(ATTRACTIONS.slice(0, 3)))
        : res(429, { error: { status: "RESOURCE_EXHAUSTED" } });
    }
    return res(200, body(textSet(q)));
  };
  return { fetchImpl, calls };
}

/** A well-formed plan: per day minStops sent non-restaurant places, in sent order, each used once. */
function goodPlan(prompt: ModelPrompt): string {
  const input = JSON.parse(prompt.user) as {
    days: Array<{ day: number; earliestStart: string; minStops: number }>;
    candidates: Array<{ placeId: string; primaryType: string | null }>;
  };
  const titles = ["Coastal wander", "Old town trail", "Hills and spice", "Last stretch"];
  const pool = input.candidates.filter((c) => c.primaryType !== "restaurant");
  let next = 0;
  return JSON.stringify({
    days: input.days.map((d, i) => ({
      day: d.day,
      startTime: d.earliestStart,
      title: titles[i % titles.length],
      stops: pool
        .slice(next, (next += Math.max(1, d.minStops)))
        .map((c) => ({ placeId: c.placeId, sentence: "A good place to spend a relaxed while." })),
    })),
  });
}

function baseDeps(extra: Partial<PlacesFirstDeps> = {}, lines: string[] = [], diag: string[] = []): PlacesFirstDeps {
  return {
    hasKey: () => true,
    now: () => 1_000_000,
    logger: (l) => void lines.push(l),
    diagLogger: (l) => void diag.push(l),
    candidateCache: createCandidateCache(),
    enrichment: { config: SEARX_OFF },
    ...extra,
  };
}

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.GOOGLE_PLACES_API_KEY;
  process.env.GOOGLE_PLACES_API_KEY = TEST_KEY;
  clearPolishMemo();
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
  else process.env.GOOGLE_PLACES_API_KEY = savedKey;
});

describe("runPlacesFirstBatch", () => {
  it("returns unavailable not-configured with no Places or Bedrock call", async () => {
    const places = placesFetch();
    const invokeModel = vi.fn(async () => "{}");
    const lines: string[] = [];
    const r = await runPlacesFirstBatch(REQ, 4, baseDeps({ hasKey: () => false, fetchImpl: places.fetchImpl, invokeModel }, lines));
    expect(r.source).toBe("unavailable");
    expect(r.reason).toBe("not-configured");
    expect(r.days).toEqual([]);
    expect(r.withheldDays).toEqual([1, 2, 3, 4]);
    expect(places.calls).toHaveLength(0);
    expect(invokeModel).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/outcome=not-configured$/);
  });

  it("builds Goa days from injected Places JSON, finishing Places before the first Bedrock call", async () => {
    const order: string[] = [];
    const places = placesFetch("ok", order);
    const invokeModel = vi.fn(async (p: ModelPrompt) => {
      order.push("bedrock");
      return goodPlan(p);
    });
    const lines: string[] = [];
    const diag: string[] = [];
    const r = await runPlacesFirstBatch(REQ, 4, baseDeps({ fetchImpl: places.fetchImpl, invokeModel }, lines, diag));

    expect(r.source).toBe("model");
    expect(r.days.length).toBeGreaterThanOrEqual(1);
    expect(r.verifiedDays).toEqual(r.days.map((d) => d.day));
    const requested = [1, 2, 3, 4];
    expect([...r.verifiedDays, ...r.withheldDays].sort()).toEqual(requested);
    const seenIds = new Set<string>();
    for (const d of r.days) {
      expect(d.activities.length).toBeGreaterThanOrEqual(1);
      for (const a of d.activities) {
        expect(ALL_IDS.has(a.placeId as string)).toBe(true);
        expect(seenIds.has(a.placeId as string)).toBe(false);
        seenIds.add(a.placeId as string);
        expect(a.verified).toBe(true);
        expect(a.cost).toBe(0); // no accepted web price, no invented estimate
      }
    }
    // One distinct candidate per place id: 8 + 6 + 6 + 8 + 6.
    expect(r.stats.proposed).toBe(ALL_IDS.size);
    expect(r.stats.verified).toBe(seenIds.size);
    // Planner accepted: day titles come from the Planner.
    expect(r.days.some((d) => ["Coastal wander", "Old town trail", "Hills and spice", "Last stretch"].includes(d.title))).toBe(true);
    // All Places requests precede the first Bedrock call.
    const firstBedrock = order.indexOf("bedrock");
    expect(firstBedrock).toBeGreaterThan(0);
    expect(order.slice(firstBedrock)).not.toContain("places");
    expect(invokeModel).toHaveBeenCalledTimes(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/ planner=accepted repaired=0 outcome=(ok|partial)$/);
    expect(diag).toHaveLength(0);
  });

  it("keeps built days and withholds the rest after a 429 mid-batch", async () => {
    const places = placesFetch("only-attractions");
    const lines: string[] = [];
    const r = await runPlacesFirstBatch(REQ, 4, baseDeps({ fetchImpl: places.fetchImpl }, lines));
    expect(r.source).toBe("model");
    // Only 3 candidates exist, so at most 3 days hold a Stop and the rest are withheld.
    expect(r.verifiedDays.length).toBeGreaterThanOrEqual(1);
    expect(r.withheldDays.length).toBeGreaterThanOrEqual(1);
    expect([...r.verifiedDays, ...r.withheldDays].sort()).toEqual([1, 2, 3, 4]);
    expect(r.days.flatMap((d) => d.activities.map((a) => a.placeId as string)).sort()).toEqual(["att0", "att1", "att2"]);
    // No widening after a rate limit: at most the 4 text searches and 1 nearby.
    expect(places.calls.filter((c) => c.kind !== "centre").length).toBeLessThanOrEqual(5);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/outcome=partial$/);
  });

  it("falls back to the plain itinerary when the planner is rejected after one repair", async () => {
    const places = placesFetch();
    const invokeModel = vi.fn(async () =>
      JSON.stringify({
        days: [{ day: 1, startTime: "09:30", title: "Invented", stops: [{ placeId: "not-a-candidate", sentence: "Made up." }] }],
      }),
    );
    const lines: string[] = [];
    const r = await runPlacesFirstBatch(REQ, 4, baseDeps({ fetchImpl: places.fetchImpl, invokeModel }, lines));
    expect(invokeModel).toHaveBeenCalledTimes(2);
    expect(r.source).toBe("model");
    expect(r.days.length).toBeGreaterThanOrEqual(1);
    for (const d of r.days) {
      expect(d.title).not.toBe("Invented");
      for (const a of d.activities) {
        expect(ALL_IDS.has(a.placeId as string)).toBe(true);
        expect(a.description).toBe("");
      }
    }
    expect(lines[0]).toMatch(/ planner=rejected repaired=1 /);
  });

  it("falls back when no model is injected and still builds the plain itinerary", async () => {
    const places = placesFetch();
    const lines: string[] = [];
    const r = await runPlacesFirstBatch(REQ, 4, baseDeps({ fetchImpl: places.fetchImpl }, lines));
    expect(r.days.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toMatch(/ planner=fallback repaired=0 /);
  });

  it("does not withhold a day when enrichment fails", async () => {
    const places = placesFetch();
    const research = vi.fn(async () => {
      throw new Error("searxng down");
    });
    const lines: string[] = [];
    const r = await runPlacesFirstBatch(
      REQ,
      4,
      baseDeps({ fetchImpl: places.fetchImpl, enrichment: { config: SEARX_ON, research } }, lines),
    );
    expect(research).toHaveBeenCalledTimes(1);
    expect(r.source).toBe("model");
    expect(r.days.length).toBeGreaterThanOrEqual(1);
    for (const d of r.days) {
      for (const a of d.activities) {
        expect(a.cost).toBe(0);
        expect(a.priceSource).toBeUndefined();
        expect(a.webDetails?.checked ?? false).toBe(false);
      }
    }
    expect(lines[0]).toMatch(/ enrich=0 /);
  });

  it("reports unavailable and writes one diagnostic line when every Places request fails", async () => {
    const places = placesFetch("all-fail");
    const lines: string[] = [];
    const diag: string[] = [];
    const r = await runPlacesFirstBatch(REQ, 4, baseDeps({ fetchImpl: places.fetchImpl }, lines, diag));
    expect(r.source).toBe("unavailable");
    expect(r.reason).toBe("unavailable");
    expect(r.days).toEqual([]);
    expect(r.withheldDays).toEqual([1, 2, 3, 4]);
    expect(lines).toHaveLength(1);
    expect(diag).toHaveLength(1);
    expect(diag[0]).toMatch(/^\[itinerary-batch-diag\] /);
  });

  it("writes one counts-only log line with no names, queries, URLs or keys, and survives a throwing logger", async () => {
    const places = placesFetch();
    const lines: string[] = [];
    const diag: string[] = [];
    const invokeModel = async (p: ModelPrompt) => goodPlan(p);
    await runPlacesFirstBatch(REQ, 4, baseDeps({ fetchImpl: places.fetchImpl, invokeModel }, lines, diag));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\[itinerary-batch\] days=1-4 proposed=\d+ verified=\d+ removed=\d+ ms=\d+ places=\d+ cached=\d+ enrich=\d+ planner=(accepted|rejected|fallback) repaired=(0|1) outcome=(ok|partial|unavailable|not-configured|timeout)$/,
    );
    for (const text of [...ALL_NAMES, "Goa", "http", TEST_KEY, "tourist attractions"]) {
      expect(lines[0]).not.toContain(text);
    }

    const throwing: PlacesFirstDeps = baseDeps({
      fetchImpl: places.fetchImpl,
      logger: () => {
        throw new Error("logger down");
      },
      diagLogger: () => {
        throw new Error("diag down");
      },
    });
    const r = await runPlacesFirstBatch(REQ, 4, throwing);
    expect(r.days.length).toBeGreaterThanOrEqual(1);
  });
});
