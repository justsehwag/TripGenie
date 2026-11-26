// Rewritten for the places-first flow. Since task 9.3, /api/ai calls
// `runPlacesFirstBatch`: stops come from Google Places (New) candidates, SearXNG
// only enriches them, and the model only polishes titles and sentences. The old
// flow (Bedrock proposes places, Places verifies them, `groundItinerary` feeds a
// GROUNDING_OPEN prompt block) is retired, so the five tests that mocked it were
// rewritten to keep their intent against the new flow. The user approved this
// exception for this file only (task 10). The last test (model failure with no
// Places answer) is unchanged.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ground = vi.fn();
const invoke = vi.fn();

vi.mock("@/lib/bedrock-model", async () => {
  const actual = await vi.importActual<typeof import("@/lib/bedrock-model")>(
    "@/lib/bedrock-model",
  );
  return {
    ...actual,
    createBedrockInvoke: () => (p: unknown) => invoke(p),
  };
});
vi.mock("@/lib/grounding/service", () => ({
  groundItinerary: (...a: unknown[]) => ground(...a),
}));

import { POST } from "@/app/api/ai/route";
import { clearGroundingMemo } from "@/lib/itinerary/grounding-memo";
import { clearPolishMemo } from "@/lib/itinerary/polish";
import { GROUNDING_OPEN } from "@/lib/grounding/sanitize";

const KEY_ENV = "GOOGLE_PLACES_API_KEY";
const ENRICH_ENVS = ["TRIPGENIE_WEB_PRICING_ENABLED", "TRIPGENIE_SEARXNG_ENABLED", "SEARXNG_BASE_URL"] as const;
const DETAILS_BASE = "https://places.googleapis.com/v1/places/";
const SEARX_HOST = "sx.example.test";
const CENTRE = { lat: 15.4, lng: 73.8 };

const snippet = {
  title: "Best beaches in Goa",
  snippet: "Baga and Palolem are popular beaches in Goa.",
  url: "https://example.com/goa",
  host: "example.com",
};

const FIRSTS = ["Aurelia", "Brightwater", "Cedar", "Dunmore", "Eastgate", "Fernhill"];
const NOUNS = ["Fort", "Museum", "Gardens", "Cathedral", "Lighthouse", "Observatory"];
const POOL: string[] = FIRSTS.flatMap((f) => NOUNS.map((n) => `${f} ${n}`));

let destination = "";
let seq = 0;
let nameCursor = 0;
let placeSearches = 0;
let savedKey: string | undefined;
let savedEnrich: Record<string, string | undefined> = {};

/** Batch-shaped model answer for the retired proposal flow (only the unchanged last test uses it). */
function modelAnswer(dayCount: number, stops: number): string {
  const days = Array.from({ length: dayCount }, (_, d) => ({
    title: `${FIRSTS[(nameCursor + d) % FIRSTS.length]} district day`,
    dayTrip: false,
    activities: Array.from({ length: stops }, (_, s) => ({
      time: `${String(9 + s * 2).padStart(2, "0")}:00`,
      place: POOL[(nameCursor + d * stops + s) % POOL.length],
      area: "Old Town",
      kind: "sight",
      description: "A visit to the place.",
      cost: 200,
    })),
  }));
  nameCursor += dayCount * stops;
  return JSON.stringify({ days });
}

/** Old fake Places. Candidate searches (`<place>, <dest>`) are answered 400 by design. */
function fakePlaces(dest: string) {
  return async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const reply = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith(DETAILS_BASE)) {
      const id = decodeURIComponent(url.slice(DETAILS_BASE.length));
      return reply({ id, photos: [{ name: `places/${id}/photos/ph1` }] });
    }
    let parsed: { textQuery?: unknown; maxResultCount?: unknown } = {};
    try {
      parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    } catch {
      parsed = {};
    }
    const textQuery = typeof parsed.textQuery === "string" ? parsed.textQuery : "";
    if (typeof parsed.maxResultCount !== "number") {
      if (textQuery !== dest) return reply({}, 500);
      return reply({ places: [{ id: "route-centre", location: { latitude: CENTRE.lat, longitude: CENTRE.lng } }] });
    }
    const suffix = `, ${dest}`;
    if (!textQuery.endsWith(suffix)) return reply({}, 400);
    placeSearches += 1;
    const place = textQuery.slice(0, textQuery.length - suffix.length);
    const id = `route-${place.toLowerCase().replace(/[^a-z]+/g, "-")}`;
    let n = 0;
    for (const ch of id) n += ch.charCodeAt(0);
    return reply({
      places: [
        {
          id,
          displayName: { text: place },
          formattedAddress: `${place}, Old Town, ${dest}, India`,
          location: { latitude: CENTRE.lat + (n % 7) * 0.004, longitude: CENTRE.lng + (n % 5) * 0.004 },
        },
      ],
    });
  };
}

// ---- places-first fake: candidate searches, centre lookup, SearXNG ---------

interface Spec {
  id: string;
  name: string;
  type: string;
}

function specs(prefix: string, names: string[], type: string): Spec[] {
  return names.map((n, i) => ({ id: `${prefix}${i}`, name: n, type }));
}

const ATTRACTIONS = specs(
  "att",
  ["Chapora Fort Lookout", "Basilica of Bom Jesus", "Se Cathedral Old Goa", "Fort Aguada Lighthouse", "Reis Magos Fort", "Mangueshi Temple", "Dudhsagar Falls View", "Cabo de Rama Fort"],
  "tourist_attraction",
);
const MUSEUMS = specs("mus", ["Goa State Museum", "Naval Aviation Museum", "Big Foot Cross Museum", "Houses of Goa Museum", "Christian Art Museum", "Archaeological Museum Old Goa"], "museum");
const PARKS = specs("prk", ["Salim Ali Bird Sanctuary", "Carambolim Lake Park", "Mayem Lake Garden", "Bhagwan Mahavir Wildlife Park", "Panjim Waterfront Park", "Campal Garden"], "park");
const FOOD = specs("rst", ["Fisherman Wharf Kitchen", "Gunpowder Table", "Vinayak Family Restaurant", "Mum Kitchen Panjim", "Bomras Seafood", "Pousada by the Beach", "Ritz Classic Thali", "Cafe Bhonsle"], "restaurant");
const NEARBY = specs("nby", ["Baga Beach Shack Row", "Anjuna Flea Market", "Vagator Cliff Point", "Palolem Beach Walk", "Colva Beach Stretch", "Miramar Beach Edge"], "tourist_attraction");
const ALL_IDS = new Set([...ATTRACTIONS, ...MUSEUMS, ...PARKS, ...FOOD, ...NEARBY].map((s) => s.id));

/**
 * Centre for this test's destination. It differs per test (and never equals
 * CENTRE), so the process-wide candidate cache, keyed on the Nearby centre,
 * cannot carry candidates into another test, including the unchanged last one.
 */
function testCentre() {
  return { lat: CENTRE.lat + seq * 0.01, lng: CENTRE.lng };
}

/** A candidate in the Places API (New) shape that `parseCandidates` reads. */
function candidate(s: Spec, i: number, dest: string) {
  const c = testCentre();
  return {
    id: s.id,
    displayName: { text: s.name },
    formattedAddress: `Main Road, ${["Calangute", "Panaji", "Old Goa", "Candolim"][i % 4]}, ${dest}, India`,
    location: { latitude: c.lat + (i % 7) * 0.004, longitude: c.lng + (i % 5) * 0.004 },
    businessStatus: "OPERATIONAL",
    types: [s.type, "point_of_interest", "establishment"],
    primaryType: s.type,
    rating: 4.3,
    userRatingCount: 1200 - i * 10,
    photos: [{ name: `places/${s.id}/photos/ph1` }],
  };
}

function textSet(query: string): Spec[] {
  const q = query.toLowerCase();
  if (q.includes("restaurants")) return FOOD;
  if (q.includes("museums")) return MUSEUMS;
  if (q.includes("parks")) return PARKS;
  return ATTRACTIONS;
}

type Searx = "off" | "unavailable" | "empty" | "throws";

/**
 * Global fetch for the places-first flow. `places:searchText` with
 * `maxResultCount` and `places:searchNearby` return candidates, a searchText
 * without `maxResultCount` is the centre lookup, and the SearXNG host answers
 * according to `searx`.
 */
function fakeCandidates(dest: string, searx: Searx, counts: { searx: number; candidateCalls: number }) {
  return async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const reply = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes(SEARX_HOST)) {
      counts.searx += 1;
      if (searx === "throws") throw new Error("searxng down");
      if (searx === "empty") return reply({ results: [] });
      return reply({}, 500);
    }
    if (url.startsWith(DETAILS_BASE)) return reply({}, 404);
    let parsed: { textQuery?: unknown; maxResultCount?: unknown } = {};
    try {
      parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    } catch {
      parsed = {};
    }
    if (url.endsWith(":searchNearby")) {
      counts.candidateCalls += 1;
      return reply({ places: NEARBY.map((s, i) => candidate(s, i, dest)) });
    }
    const textQuery = typeof parsed.textQuery === "string" ? parsed.textQuery : "";
    if (typeof parsed.maxResultCount !== "number") {
      const c = testCentre();
      return reply({ places: [{ id: "route-centre", location: { latitude: c.lat, longitude: c.lng } }] });
    }
    counts.candidateCalls += 1;
    return reply({ places: textSet(textQuery).map((s, i) => candidate(s, i, dest)) });
  };
}

/** A well-formed polish that keeps the Scheduler's stops and groups them by day. */
function goodPolish(prompt: { user: string }): string {
  const input = JSON.parse(prompt.user) as {
    days: Array<{ day: number; minStops: number }>;
    candidates: Array<{ placeId: string }>;
  };
  const titles = ["Coastal wander", "Old town trail", "Hills and spice", "Last stretch"];
  let next = 0;
  return JSON.stringify({
    days: input.days.map((d, i) => {
      const picked = input.candidates.slice(next, next + Math.max(1, d.minStops));
      next += picked.length;
      return {
        day: d.day,
        startTime: "09:30",
        title: titles[i % titles.length],
        stops: picked.map((s) => ({ placeId: s.placeId, sentence: "A good place to spend a relaxed while." })),
      };
    }),
  });
}

function legacyPost(): Request {
  return new Request("http://localhost/api/ai", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "itinerary", context: { destination, durationDays: 1 } }),
  });
}

function batchPost(): Request {
  return new Request("http://localhost/api/ai", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "itinerary-batch",
      context: { destination, durationDays: 9 },
      fromDay: 1,
      dayCount: 3,
      usedPlaces: [],
    }),
  });
}

function promptText(call: number): string {
  const p = invoke.mock.calls[call][0] as { system: string; user: string };
  return `${p.system}\n${p.user}`;
}

type Act = { placeId?: string; verified?: boolean; cost: number; description?: string; priceSource?: unknown };
type DayLike = { title: string; activities: Act[] };

function stopsOf(days: DayLike[]): Act[] {
  return days.flatMap((d) => d.activities);
}

/** Every stop is a Places candidate: a known id, verified, no invented price. */
function expectCandidateStops(acts: Act[]): void {
  expect(acts.length).toBeGreaterThan(0);
  for (const a of acts) {
    expect(ALL_IDS.has(a.placeId as string)).toBe(true);
    expect(a.verified).toBe(true);
    expect(a.cost).toBe(0);
    expect(a.priceSource).toBeUndefined();
  }
  const ids = acts.map((a) => a.placeId);
  expect(new Set(ids).size).toBe(ids.length);
}

function useFetch(searx: Searx) {
  const counts = { searx: 0, candidateCalls: 0 };
  vi.stubGlobal("fetch", fakeCandidates(destination, searx, counts));
  if (searx !== "off") {
    process.env.TRIPGENIE_WEB_PRICING_ENABLED = "true";
    process.env.TRIPGENIE_SEARXNG_ENABLED = "true";
    process.env.SEARXNG_BASE_URL = `https://${SEARX_HOST}`;
  }
  return counts;
}

beforeEach(() => {
  seq += 1;
  destination = `Goa Routetest${"abcdefghij"[seq % 10]}${"abcdefghij"[Math.floor(seq / 10) % 10]}`;
  placeSearches = 0;
  nameCursor = 0;
  ground.mockReset();
  invoke.mockReset();
  clearGroundingMemo();
  clearPolishMemo();
  savedKey = process.env[KEY_ENV];
  process.env[KEY_ENV] = "test-key-not-real";
  savedEnrich = {};
  for (const k of ENRICH_ENVS) {
    savedEnrich[k] = process.env[k];
    delete process.env[k];
  }
  vi.stubGlobal("fetch", fakePlaces(destination));
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = savedKey;
  for (const k of ENRICH_ENVS) {
    if (savedEnrich[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnrich[k];
  }
  clearGroundingMemo();
  clearPolishMemo();
});

describe("itinerary route (places-first)", () => {
  for (const [label, searx] of [
    ["disabled", "off"],
    ["unavailable", "unavailable"],
    ["empty", "empty"],
  ] as const) {
    it(`returns the legacy body without sources when enrichment is ${label}`, async () => {
      const counts = useFetch(searx);
      invoke.mockImplementation(async (p: { user: string }) => goodPolish(p));
      const body = await (await POST(legacyPost())).json();
      expect(Object.keys(body).sort()).toEqual(["completeness", "itinerary", "source"]);
      expect(body.source).toBe("model");
      expect(body.sources).toBeUndefined();
      expect(body.itinerary.sources).toBeUndefined();
      expect(body.completeness).toEqual({ requestedDays: 1, verifiedDays: [1], withheldDays: [] });
      expectCandidateStops(stopsOf(body.itinerary.days));
      expect(counts.candidateCalls).toBeGreaterThan(0);
      if (searx === "off") expect(counts.searx).toBe(0);
      // Retired: the grounding service and its prompt block are never used.
      expect(ground).not.toHaveBeenCalled();
      expect(promptText(0)).not.toContain(GROUNDING_OPEN);

      // The batch action returns the same candidate-only stops and no sources.
      invoke.mockClear();
      clearPolishMemo();
      const batch = await (await POST(batchPost())).json();
      expect(batch.source).toBe("model");
      expect(batch.sources).toBeUndefined();
      expectCandidateStops(stopsOf(batch.days));
      expect(ground).not.toHaveBeenCalled();
      expect(promptText(0)).not.toContain(GROUNDING_OPEN);
    });
  }

  it("treats a thrown enrichment error and a failing model as unavailable extras, not as a failed trip", async () => {
    const counts = useFetch("throws");
    invoke.mockRejectedValue(new Error("model down"));
    const body = await (await POST(legacyPost())).json();
    expect(Object.keys(body).sort()).toEqual(["completeness", "itinerary", "source"]);
    expect(body.source).toBe("model");
    expect(body.sources).toBeUndefined();
    expect(counts.searx).toBeGreaterThan(0);
    // Plain itinerary: the days still come from the candidates, with no polish text.
    const acts = stopsOf(body.itinerary.days);
    expectCandidateStops(acts);
    expect(acts.every((a) => a.description === "")).toBe(true);
    expect(body.completeness.verifiedDays).toEqual([1]);
    expect(ground).not.toHaveBeenCalled();
  });

  it("uses the model only to polish candidate stops, and sources come only from enrichment", async () => {
    // Closest new-flow assertion: with SearXNG answering nothing there are no sources,
    // and the model's output changes titles and sentences but never the stops.
    useFetch("empty");
    invoke.mockImplementation(async (p: { user: string }) => goodPolish(p));
    const body = await (await POST(legacyPost())).json();
    expect(body.sources).toBeUndefined();
    // One polish call; any other call is a price-estimate call from price-fallback.ts
    // (one per day, temperature 0.1). Estimates never contribute sources.
    const isEstimate = (c: unknown[]): boolean => {
      const p = c[0] as { system: string; temperature?: number };
      return p.temperature === 0.1 && p.system.includes("estimate a typical price in Indian rupees");
    };
    const estimateCalls = invoke.mock.calls.filter(isEstimate).length;
    const polishCalls = invoke.mock.calls.length - estimateCalls;
    expect(polishCalls).toBe(1);
    expect(estimateCalls).toBeLessThanOrEqual(1); // durationDays: 1
    const prompt = promptText(0);
    expect(prompt).not.toContain(GROUNDING_OPEN);
    const days = body.itinerary.days as DayLike[];
    const acts = stopsOf(days);
    expectCandidateStops(acts);
    expect(days.every((d) => ["Coastal wander", "Old town trail", "Hills and spice", "Last stretch"].includes(d.title))).toBe(true);
    expect(acts.every((a) => a.description === "A good place to spend a relaxed while.")).toBe(true);
    // The prompt carries only candidate ids that the answer then uses.
    for (const a of acts) expect(prompt).toContain(a.placeId as string);

    // A polish naming a place that is not a candidate is rejected: the stops stay candidates.
    clearPolishMemo();
    invoke.mockReset();
    invoke.mockImplementation(async () =>
      JSON.stringify({ days: [{ day: 1, title: "Invented", stops: [{ placeId: "not-a-candidate", sentence: "Made up." }] }] }),
    );
    const again = await (await POST(legacyPost())).json();
    const plain = again.itinerary.days as DayLike[];
    expectCandidateStops(stopsOf(plain));
    expect(plain.some((d) => d.title === "Invented")).toBe(false);
    expect(again.sources).toBeUndefined();
    expect(ground).not.toHaveBeenCalled();
  });

  it("returns unavailable with no itinerary when the model fails", async () => {
    ground.mockResolvedValue({ status: "partial", snippets: [snippet], droppedCount: 0 });
    invoke.mockRejectedValue(new Error("model down"));
    const body = await (await POST(legacyPost())).json();
    expect(body.source).toBe("unavailable");
    expect(typeof body.reason).toBe("string");
    expect(body.itinerary).toBeUndefined();
    expect(placeSearches).toBe(0);
  });
});
