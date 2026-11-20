import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelPrompt } from "@/lib/bedrock-model";

// Task 9.15: orchestrator and route example tests. No live network: fetch,
// invokeModel, research and the clock are all injected or faked.

const state = vi.hoisted(() => ({ hangBatch: false }));

// Spy on the Places adapter without changing its behaviour.
vi.mock("@/lib/providers/google-places", async () => {
  const actual = await vi.importActual<typeof import("@/lib/providers/google-places")>("@/lib/providers/google-places");
  return {
    ...actual,
    resolveLocation: vi.fn(actual.resolveLocation),
    searchPlaceForVerification: vi.fn(actual.searchPlaceForVerification),
  };
});

// Pass through, except when a test makes the batch hang (route backstop test).
vi.mock("@/lib/itinerary/places-first-batch", async () => {
  const actual = await vi.importActual<typeof import("@/lib/itinerary/places-first-batch")>(
    "@/lib/itinerary/places-first-batch",
  );
  return {
    ...actual,
    runPlacesFirstBatch: ((...args: Parameters<typeof actual.runPlacesFirstBatch>) =>
      state.hangBatch ? new Promise(() => undefined) : actual.runPlacesFirstBatch(...args)) as typeof actual.runPlacesFirstBatch,
  };
});

vi.mock("@/lib/bedrock-model", async () => {
  const actual = await vi.importActual<typeof import("@/lib/bedrock-model")>("@/lib/bedrock-model");
  return { ...actual, createBedrockInvoke: () => async () => "" };
});

import { POST } from "@/app/api/ai/route";
import type { BatchRequest } from "@/lib/itinerary/batch-wire";
import { createCandidateCache } from "@/lib/itinerary/candidate-search";
import { enrichStops } from "@/lib/itinerary/enrichment";
import { BATCH_REQUEST_BUDGET_MS, LOOKUP_TIMEOUT_MS, POLISH_TIMEOUT_MS } from "@/lib/itinerary/constants";
import { runPlacesFirstBatch, type PlacesFirstDeps } from "@/lib/itinerary/places-first-batch";
import { clearPolishMemo } from "@/lib/itinerary/polish";
import { resolveLocation, searchCandidatesText, searchPlaceForVerification } from "@/lib/providers/google-places";
import { RESEARCH_BUDGET_MS, type ResearchConfig } from "@/lib/web-pricing/service";

const TEST_KEY = "unit-test-places-key";
const SEARX_ON: ResearchConfig = { enabled: true, baseUrl: "https://sx.example.test", secretHeader: null };
const START = 1_000_000;

function reqFor(destination: string, fromDay = 1, dayCount = 4): BatchRequest {
  return {
    action: "itinerary-batch",
    context: { destination, durationDays: 8, pace: "balanced", interests: [] },
    fromDay,
    dayCount,
    usedPlaces: [],
  };
}

// ---- injected Places JSON --------------------------------------------------

const CENTRE = { lat: 15.4989, lng: 73.8278 };
interface Spec {
  id: string;
  name: string;
  type: string;
}
const spec = (prefix: string, names: string[], type: string): Spec[] =>
  names.map((n, i) => ({ id: `${prefix}${i}`, name: n, type }));

const ATTRACTIONS = spec(
  "att",
  ["Chapora Fort Lookout", "Basilica of Bom Jesus", "Se Cathedral Old Goa", "Fort Aguada Lighthouse", "Reis Magos Fort", "Mangueshi Temple", "Dudhsagar Falls View", "Cabo de Rama Fort"],
  "tourist_attraction",
);
const MUSEUMS = spec("mus", ["Goa State Museum", "Naval Aviation Museum", "Big Foot Cross Museum", "Houses of Goa Museum", "Christian Art Museum", "Archaeological Museum Old Goa"], "museum");
const PARKS = spec("prk", ["Salim Ali Bird Sanctuary", "Carambolim Lake Park", "Mayem Lake Garden", "Bhagwan Mahavir Wildlife Park", "Panjim Waterfront Park", "Campal Garden"], "park");
const FOOD = spec("rst", ["Fisherman Wharf Kitchen", "Gunpowder Table", "Vinayak Family Restaurant", "Mum Kitchen Panjim", "Bomras Seafood", "Pousada by the Beach", "Ritz Classic Thali", "Cafe Bhonsle"], "restaurant");
const NEARBY = spec("nby", ["Baga Beach Shack Row", "Anjuna Flea Market", "Vagator Cliff Point", "Palolem Beach Walk", "Colva Beach Stretch", "Miramar Beach Edge"], "tourist_attraction");
const ALL_IDS = new Set([...ATTRACTIONS, ...MUSEUMS, ...PARKS, ...FOOD, ...NEARBY].map((s) => s.id));

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
const body = (list: Spec[]) => ({ places: list.map(place) });
function textSet(query: string): Spec[] {
  const q = query.toLowerCase();
  if (q.includes("restaurants")) return FOOD;
  if (q.includes("museums")) return MUSEUMS;
  if (q.includes("parks")) return PARKS;
  return ATTRACTIONS;
}
const res = (status: number, json: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

type Fetch = NonNullable<PlacesFirstDeps["fetchImpl"]>;

/** Serves centre, text and nearby requests. `onCall` sees every request in order. */
function placesFetch(onCall: (kind: "centre" | "text" | "nearby") => void = () => undefined): Fetch {
  return async (url, init) => {
    const mask = init?.headers?.["X-Goog-FieldMask"] ?? "";
    const payload = init?.body ? (JSON.parse(init.body) as { textQuery?: string }) : {};
    if (url.endsWith(":searchNearby")) {
      onCall("nearby");
      return res(200, body(NEARBY));
    }
    if (mask === "places.id,places.location") {
      onCall("centre");
      return res(200, { places: [{ id: "centre", location: { latitude: CENTRE.lat, longitude: CENTRE.lng } }] });
    }
    onCall("text");
    return res(200, body(textSet(payload.textQuery ?? "")));
  };
}

/** A fetch that never answers; it fails only when its AbortSignal fires. */
function hangingFetch(aborted: { count: number } = { count: 0 }): Fetch {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted.count += 1;
        reject(new Error("aborted"));
      });
    });
}

interface PlannerIn {
  days: Array<{ day: number; earliestStart: string; minStops: number; maxStops: number }>;
  candidates: Array<{ placeId: string; primaryType: string | null }>;
}
/**
 * Valid planner output in the planner schema (planner.ts PlannerOut): each day gets
 * `minStops` non-restaurant candidates in input order (no meal window to fit), the
 * day's earliestStart as startTime, and the given title.
 */
function plannerWith(prompt: ModelPrompt, titles: string[]): string {
  const input = JSON.parse(prompt.user) as PlannerIn;
  const sights = input.candidates.filter((c) => c.primaryType !== "restaurant");
  let next = 0;
  return JSON.stringify({
    days: input.days.map((d, i) => ({
      day: d.day,
      startTime: d.earliestStart,
      title: titles[i % titles.length],
      stops: sights.slice(next, (next += d.minStops)).map((s) => ({ placeId: s.placeId, sentence: "A good place to spend a relaxed while." })),
    })),
  });
}

function deps(extra: Partial<PlacesFirstDeps> = {}, lines: string[] = []): PlacesFirstDeps {
  return {
    hasKey: () => true,
    now: () => START,
    logger: (l) => void lines.push(l),
    diagLogger: () => undefined,
    candidateCache: createCandidateCache(),
    enrichment: { config: { enabled: false, baseUrl: "", secretHeader: null } },
    ...extra,
  };
}

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.GOOGLE_PLACES_API_KEY;
  process.env.GOOGLE_PLACES_API_KEY = TEST_KEY;
  clearPolishMemo();
  state.hangBatch = false;
  vi.mocked(resolveLocation).mockClear();
  vi.mocked(searchPlaceForVerification).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (savedKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
  else process.env.GOOGLE_PLACES_API_KEY = savedKey;
});

describe("places-first orchestrator: ordering and calls", () => {
  it("makes every Places call before the first invokeModel and never calls searchPlaceForVerification", async () => {
    const order: string[] = [];
    const fetchImpl = placesFetch(() => order.push("places"));
    const invokeModel = vi.fn(async (p: ModelPrompt) => {
      order.push("bedrock");
      return plannerWith(p, ["Coastal wander", "Old town trail", "Hills and spice", "Last stretch"]);
    });
    const r = await runPlacesFirstBatch(reqFor("Goa"), 4, deps({ fetchImpl, invokeModel }));
    expect(r.days.length).toBeGreaterThanOrEqual(1);
    expect(invokeModel).toHaveBeenCalledTimes(1);
    const first = order.indexOf("bedrock");
    expect(first).toBeGreaterThan(0);
    expect(order.slice(first)).toEqual(["bedrock"]);
    expect(searchPlaceForVerification).not.toHaveBeenCalled();
  });

  it("makes no Places and no Bedrock call when no key is configured", async () => {
    const fetchImpl = vi.fn(placesFetch());
    const invokeModel = vi.fn(async () => "{}");
    const research = vi.fn();
    const r = await runPlacesFirstBatch(
      reqFor("Goa"),
      4,
      deps({ hasKey: () => false, fetchImpl, invokeModel, enrichment: { config: SEARX_ON, research: research as never } }),
    );
    expect(r.source).toBe("unavailable");
    expect(r.reason).toBe("not-configured");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(invokeModel).not.toHaveBeenCalled();
    expect(research).not.toHaveBeenCalled();
    expect(resolveLocation).not.toHaveBeenCalled();
    expect(searchPlaceForVerification).not.toHaveBeenCalled();
  });

  it("makes one resolveLocation call for concurrent batches of the same destination", async () => {
    const kinds: string[] = [];
    const fetchImpl = placesFetch((k) => kinds.push(k));
    const [a, b] = await Promise.all([
      runPlacesFirstBatch(reqFor("Zanzibar Town", 1, 4), 8, deps({ fetchImpl })),
      runPlacesFirstBatch(reqFor("Zanzibar Town", 5, 4), 8, deps({ fetchImpl })),
    ]);
    expect(a.days.length).toBeGreaterThanOrEqual(1);
    expect(b.days.length).toBeGreaterThanOrEqual(1);
    expect(resolveLocation).toHaveBeenCalledTimes(1);
    expect(kinds.filter((k) => k === "centre")).toHaveLength(1);
    expect(searchPlaceForVerification).not.toHaveBeenCalled();
  });
});

describe("places-first orchestrator: timeouts on a fake clock", () => {
  it("aborts a Places request at 2,500 ms, not before", async () => {
    vi.useFakeTimers();
    expect(LOOKUP_TIMEOUT_MS).toBe(2_500);
    const aborted = { count: 0 };
    let result: unknown;
    const p = searchCandidatesText("sights in Goa", hangingFetch(aborted)).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(2_499);
    expect(aborted.count).toBe(0);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(aborted.count).toBe(1);
    expect(result).toEqual({ kind: "failed", cause: "error" });
  });

  it("gives every searched request in a batch the 2,500 ms bound and then reports unavailable", async () => {
    vi.useFakeTimers();
    const aborted = { count: 0 };
    const fetchImpl = hangingFetch(aborted);
    let r: Awaited<ReturnType<typeof runPlacesFirstBatch>> | undefined;
    const p = runPlacesFirstBatch(reqFor("Hangville"), 4, {
      hasKey: () => true,
      fetchImpl,
      logger: () => undefined,
      diagLogger: () => undefined,
      candidateCache: createCandidateCache(),
    }).then((x) => (r = x));
    // Centre lookup is bounded at 5,000 ms. The searches then abort at 2,500 ms,
    // and the one widening text search (no centre, so no Nearby step) at 2,500 ms
    // more. It starts at 7,500 ms, inside the 11,000 ms Places phase.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(r).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_499);
    expect(r).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(2_499);
    expect(r).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(r?.source).toBe("unavailable");
    expect(r?.days).toEqual([]);
    expect(aborted.count).toBeGreaterThanOrEqual(2);
  });

  it("caps enrichment at 8,000 ms and the planner call at 7,000 ms, with the planner call shrinking near the 25,000 ms batch deadline", async () => {
    expect(RESEARCH_BUDGET_MS).toBe(8_000);
    expect(POLISH_TIMEOUT_MS).toBe(8_000);
    expect(BATCH_REQUEST_BUDGET_MS).toBe(25_000);

    // Direct: the enrichment budget is min(8,000, remaining).
    const seen: number[] = [];
    const research = vi.fn(async (_input: unknown, d: { budgetMs?: number }) => {
      seen.push(d.budgetMs ?? -1);
      throw new Error("stop here");
    });
    const one = [{ placeId: "p1", name: "Fort", primaryType: "tourist_attraction", kind: "sight" as const }];
    await enrichStops(one, { destination: "Goa" }, { config: SEARX_ON, research: research as never, budgetMs: 20_000 });
    await enrichStops(one, { destination: "Goa" }, { config: SEARX_ON, research: research as never, budgetMs: 3_000 });
    expect(seen).toEqual([8_000, 3_000]);

    // Orchestrator, fresh batch: enrichment 8,000 and polish 8,000.
    const timeouts: number[] = [];
    const budgets: number[] = [];
    const fetchImpl = placesFetch();
    const model = async (p: ModelPrompt) => {
      timeouts.push(p.timeoutMs);
      return plannerWith(p, ["A", "B", "C", "D"]);
    };
    const research1 = vi.fn(async (_i: unknown, d: { budgetMs?: number }) => {
      budgets.push(d.budgetMs ?? -1);
      throw new Error("down");
    });
    await runPlacesFirstBatch(reqFor("Goa"), 4, deps({ fetchImpl, invokeModel: model, enrichment: { config: SEARX_ON, research: research1 as never } }));
    expect(budgets).toEqual([8_000]);
    expect(timeouts).toEqual([7_000]);

    // Orchestrator, clock at 15,000 ms into the batch when the planner starts (the last Places
    // fetch moves it; enrichment runs after the planner): the planner gets
    // min(7,000, 25,000 - 15,000 - ENRICH_RESERVE 3,000 - FINALIZE 500 - MARGIN 500) = 6,000.
    clearPolishMemo();
    let clock = START;
    const lateFetch: Fetch = async (url, init) => {
      const r = await fetchImpl(url, init);
      if (url.endsWith(":searchNearby")) clock = START + 15_000;
      return r;
    };
    const research2 = vi.fn(async () => {
      throw new Error("down");
    });
    timeouts.length = 0;
    await runPlacesFirstBatch(
      reqFor("Goa"),
      4,
      deps({ now: () => clock, fetchImpl: lateFetch, invokeModel: model, enrichment: { config: SEARX_ON, research: research2 as never } }),
    );
    expect(timeouts).toEqual([6_000]);
  });

  it("answers unavailable at 25,000 ms when the batch never finishes", async () => {
    vi.useFakeTimers();
    state.hangBatch = true;
    const res1 = await (async () => {
      const p = POST(
        new Request("http://localhost/api/ai", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "itinerary-batch",
            context: { destination: "Goa", durationDays: 3 },
            fromDay: 1,
            dayCount: 1,
            usedPlaces: [],
          }),
        }),
      );
      let done = false;
      void p.then(() => (done = true));
      await vi.advanceTimersByTimeAsync(24_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      return p;
    })();
    expect(res1.status).toBe(200);
    const json = await res1.json();
    expect(json.source).toBe("unavailable");
    expect(json.days).toEqual([]);
  });
});

describe("places-first orchestrator: Planner output examples", () => {
  const TITLES = ["Coastal wander", "Old town trail", "Hills and spice", "Last stretch"];

  it("valid output: accepted, titles and sentences come from the Planner", async () => {
    const lines: string[] = [];
    const invokeModel = vi.fn(async (p: ModelPrompt) => plannerWith(p, TITLES));
    const r = await runPlacesFirstBatch(reqFor("Goa"), 4, deps({ fetchImpl: placesFetch(), invokeModel }, lines));
    expect(invokeModel).toHaveBeenCalledTimes(1);
    expect(lines[0]).toMatch(/ planner=accepted repaired=0 /);
    expect(r.days.some((d) => TITLES.includes(d.title))).toBe(true);
    for (const d of r.days) for (const a of d.activities) expect(ALL_IDS.has(a.placeId as string)).toBe(true);
  });

  it("rejected output (unknown place id): plain itinerary, no Planner text", async () => {
    const lines: string[] = [];
    const invokeModel = vi.fn(async () =>
      JSON.stringify({
        days: [{ day: 1, startTime: "09:30", title: "Invented", stops: [{ placeId: "not-a-candidate", sentence: "Made up." }] }],
      }),
    );
    const r = await runPlacesFirstBatch(reqFor("Goa"), 4, deps({ fetchImpl: placesFetch(), invokeModel }, lines));
    expect(invokeModel).toHaveBeenCalledTimes(2);
    expect(lines[0]).toMatch(/ planner=rejected repaired=1 /);
    expect(r.days.length).toBeGreaterThanOrEqual(1);
    for (const d of r.days) {
      expect(d.title).not.toBe("Invented");
      for (const a of d.activities) {
        expect(ALL_IDS.has(a.placeId as string)).toBe(true);
        expect(a.description).toBe("");
      }
    }
  });

  it("partially valid output (duplicate and Arrival Day titles): accepted, only those titles replaced", async () => {
    const lines: string[] = [];
    const r = await runPlacesFirstBatch(
      reqFor("Goa"),
      4,
      deps(
        { fetchImpl: placesFetch(), invokeModel: async (p) => plannerWith(p, ["Old town", "Old town", "Arrival Day", "Last stretch"]) },
        lines,
      ),
    );
    expect(lines[0]).toMatch(/ planner=accepted repaired=0 /);
    const titles = r.days.map((d) => d.title);
    expect(new Set(titles.map((t) => t.toLowerCase())).size).toBe(titles.length);
    for (const t of titles) expect(t).not.toMatch(/arrival day|departure day/i);
    expect(r.days.length).toBeGreaterThanOrEqual(1);
  });
});

describe("repository hygiene", () => {
  // Built from parts so this file does not name the environment files itself.
  const FORBIDDEN = [[".env", ".local"].join(""), [".env", ".deploy"].join("")];
  const ROOT = path.resolve(__dirname, "..");

  function walk(dir: string, exts: RegExp, out: string[] = []): string[] {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, exts, out);
      else if (exts.test(e.name)) out.push(p);
    }
    return out;
  }

  it("scripts and itinerary sources never mention the environment files", () => {
    const files = [
      ...walk(path.join(ROOT, "scripts"), /\.(mjs|cjs|js|ts)$/),
      ...walk(path.join(ROOT, "lib", "itinerary"), /\.ts$/),
      path.join(ROOT, "lib", "wiki-image.ts"),
    ].filter((f) => fs.existsSync(f));
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      for (const name of FORBIDDEN) if (text.includes(name)) offenders.push(`${path.relative(ROOT, f)} mentions ${name}`);
    }
    expect(offenders).toEqual([]);
  });
});
