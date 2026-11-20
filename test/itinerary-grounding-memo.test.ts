import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runItineraryBatch, type BatchDeps } from "../lib/itinerary/batch-service";
import type { BatchRequest } from "../lib/itinerary/batch-wire";
import { clearGroundingMemo } from "../lib/itinerary/grounding-memo";
import { createVerificationCache } from "../lib/itinerary/verification-cache";
import { GROUNDING_OPEN } from "../lib/grounding/sanitize";
import type { GroundingBundle } from "../lib/grounding/types";
import type { PostFetchLike } from "../lib/providers/google-places";
import type { TripContext } from "../lib/types";

const KEY_ENV = "GOOGLE_PLACES_API_KEY";
const DETAILS_BASE = "https://places.googleapis.com/v1/places/";
const CENTRE = { lat: 38.7, lng: -9.1 };
const TOTAL = 9;

const FIRSTS = ["Aurelia", "Brightwater", "Cedar", "Dunmore", "Eastgate", "Fernhill"];
const NOUNS = ["Fort", "Museum", "Gardens", "Cathedral", "Lighthouse", "Observatory"];
const POOL: string[] = FIRSTS.flatMap((f) => NOUNS.map((n) => `${f} ${n}`));

const snippet = {
  title: "Hidden miradouros of Lisbon",
  snippet: "Locals favour the viewpoints above the old quarter.",
  url: "https://example.com/lisbon",
  host: "example.com",
};
const BUNDLE: GroundingBundle = { status: "ok", snippets: [snippet], droppedCount: 0 };

let seq = 0;
let destination = "";
let cursor = 0;
let savedKey: string | undefined;

function makeFetch(dest: string): PostFetchLike {
  return async (url, init) => {
    if (url.startsWith(DETAILS_BASE)) {
      const id = decodeURIComponent(url.slice(DETAILS_BASE.length));
      return { ok: true, status: 200, json: async () => ({ id, photos: [{ name: `places/${id}/photos/ph1` }] }) };
    }
    let parsed: { textQuery?: unknown; maxResultCount?: unknown } = {};
    try {
      parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as typeof parsed;
    } catch {
      parsed = {};
    }
    const textQuery = typeof parsed.textQuery === "string" ? parsed.textQuery : "";
    if (typeof parsed.maxResultCount !== "number") {
      if (textQuery !== dest) return { ok: false, status: 500, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ places: [{ id: "memo-centre", location: { latitude: CENTRE.lat, longitude: CENTRE.lng } }] }),
      };
    }
    const suffix = `, ${dest}`;
    if (!textQuery.endsWith(suffix)) return { ok: false, status: 400, json: async () => ({}) };
    const place = textQuery.slice(0, textQuery.length - suffix.length);
    const id = `memo-${place.toLowerCase().replace(/[^a-z]+/g, "-")}`;
    let n = 0;
    for (const ch of id) n += ch.charCodeAt(0);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        places: [
          {
            id,
            displayName: { text: place },
            formattedAddress: `${place}, Alfama, ${dest}, Portugal`,
            location: { latitude: CENTRE.lat + (n % 7) * 0.004, longitude: CENTRE.lng + (n % 5) * 0.004 },
          },
        ],
      }),
    };
  };
}

/** Batch-shaped answer with `dayCount` days of 3 distinct sights. */
function modelAnswer(dayCount: number): string {
  const days = Array.from({ length: dayCount }, (_, d) => ({
    title: `${FIRSTS[(cursor + d) % FIRSTS.length]} quarter day`,
    dayTrip: false,
    activities: Array.from({ length: 3 }, (_, s) => ({
      time: `${String(9 + s * 2).padStart(2, "0")}:00`,
      place: POOL[(cursor + d * 3 + s) % POOL.length],
      area: "Alfama",
      kind: "sight",
      description: "A visit to the place.",
      cost: 150,
    })),
  }));
  cursor += dayCount * 3;
  return JSON.stringify({ days });
}

interface Rig {
  deps: BatchDeps;
  ground: ReturnType<typeof vi.fn>;
  prompts: string[];
}

function rig(): Rig {
  const ground = vi.fn(async (): Promise<GroundingBundle> => BUNDLE);
  const prompts: string[] = [];
  const deps: BatchDeps = {
    invokeModel: async (p) => {
      const text = `${p.system}\n${p.user}`;
      // A repair round (arrival days over their stop limit) is not a batch prompt.
      if (text.includes("SLOTS TO REPLACE")) return JSON.stringify({ replacements: [] });
      prompts.push(text);
      return modelAnswer(3);
    },
    fetchImpl: makeFetch(destination),
    hasKey: () => true,
    ground,
    verificationCache: createVerificationCache(),
    logger: () => {},
  };
  return { deps, ground, prompts };
}

function request(fromDay: number): BatchRequest {
  const context: TripContext = { destination, durationDays: TOTAL };
  return { action: "itinerary-batch", context, fromDay, dayCount: 3, usedPlaces: [] };
}

beforeEach(() => {
  seq += 1;
  cursor = 0;
  destination = `Lisbon Memotest${"abcdefghij"[seq % 10]}${"abcdefghij"[Math.floor(seq / 10) % 10]}`;
  savedKey = process.env[KEY_ENV];
  process.env[KEY_ENV] = "test-key-not-real";
  clearGroundingMemo();
});

afterEach(() => {
  if (savedKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = savedKey;
  clearGroundingMemo();
});

describe("grounding memo across the batches of one trip", () => {
  it("grounds once on the first batch and reuses the bundle on batches 2 and 3", async () => {
    const { deps, ground, prompts } = rig();

    const first = await runItineraryBatch(request(1), TOTAL, deps);
    expect(ground).toHaveBeenCalledTimes(1);
    expect(first.source).toBe("model");
    expect(first.sources).toHaveLength(1);
    expect(prompts[0]).toContain(GROUNDING_OPEN);
    expect(prompts[0]).toContain(snippet.title);

    const second = await runItineraryBatch(request(4), TOTAL, deps);
    const third = await runItineraryBatch(request(7), TOTAL, deps);
    expect(ground).toHaveBeenCalledTimes(1);
    expect(second.source).toBe("model");
    expect(third.source).toBe("model");
    // The memoised bundle still reaches the prompt of the later batches.
    expect(prompts[1]).toContain(GROUNDING_OPEN);
    expect(prompts[1]).toContain(snippet.title);
    expect(prompts[2]).toContain(GROUNDING_OPEN);
    expect(prompts[2]).toContain(snippet.title);
    // Sources belong to the first batch only.
    expect(second.sources).toBeUndefined();
    expect(third.sources).toBeUndefined();
  });

  it("gives a later batch an empty bundle and starts no search when there is no memo", async () => {
    const { deps, ground, prompts } = rig();

    const later = await runItineraryBatch(request(4), TOTAL, deps);
    expect(ground).not.toHaveBeenCalled();
    expect(later.source).toBe("model");
    expect(later.sources).toBeUndefined();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain(GROUNDING_OPEN);
    expect(prompts[0]).not.toContain(snippet.title);
  });
});
