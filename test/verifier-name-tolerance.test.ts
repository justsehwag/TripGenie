import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { placeMatches, placeMatchesTolerant } from "../lib/grounding/place-match";
import { runItineraryBatch, type BatchDeps } from "../lib/itinerary/batch-service";
import type { BatchRequest } from "../lib/itinerary/batch-wire";
import { clearGroundingMemo } from "../lib/itinerary/grounding-memo";
import { createVerificationCache } from "../lib/itinerary/verification-cache";
import { EMPTY_BUNDLE } from "../lib/grounding/types";
import type { PostFetchLike } from "../lib/providers/google-places";
import type { TripContext } from "../lib/types";

describe("placeMatchesTolerant", () => {
  it("accepts reordered names", () => {
    expect(placeMatchesTolerant("Aguada Fort", "Fort Aguada", "Goa")).toBe(true);
  });
  it("accepts a Google name that is a distinctive subset", () => {
    expect(placeMatchesTolerant("Fontainhas Latin Quarter", "Fontainhas", "Goa")).toBe(true);
  });
  it("treats honorific spellings as equivalent", () => {
    expect(placeMatchesTolerant("Shri Mangueshi Temple", "Shree Mangueshi Temple", "Goa")).toBe(true);
    expect(placeMatchesTolerant("St. Cajetan Church", "Cajetan Church", "Goa")).toBe(true);
  });
  it("is diacritic insensitive", () => {
    expect(placeMatchesTolerant("Sé Cathedral Goa Old", "Se Cathedral", "Goa")).toBe(true);
  });
  it("rejects unrelated names", () => {
    expect(placeMatchesTolerant("Aguada Fort", "Zzyzx Unrelated Landmark", "Goa")).toBe(false);
  });
  it("rejects generic-only overlap and different distinctive tokens", () => {
    expect(placeMatchesTolerant("Chapora Fort", "Fort", "Goa")).toBe(false);
    expect(placeMatchesTolerant("Chapora Fort", "Aguada Fort", "Goa")).toBe(false);
    expect(placeMatchesTolerant("Goa Beach", "Goa", "Goa")).toBe(false);
  });
  it("rejects empty input", () => {
    expect(placeMatchesTolerant("", "Fort Aguada", "Goa")).toBe(false);
    expect(placeMatchesTolerant("Aguada Fort", "", "Goa")).toBe(false);
  });

  it("property: any reordering of distinctive tokens matches", () => {
    const word = fc.stringMatching(/^[a-z]{4,9}$/).filter((w) => !["fort", "beach", "temple", "goa"].includes(w));
    fc.assert(
      fc.property(fc.uniqueArray(word, { minLength: 1, maxLength: 4 }), (ws) => {
        const a = ws.join(" ");
        const b = ws.slice().reverse().join(" ");
        expect(placeMatchesTolerant(a, b, "Goa")).toBe(true);
      }),
    );
  });
  it("property: a name sharing no tokens never matches", () => {
    const word = fc.stringMatching(/^[a-z]{5,9}$/);
    fc.assert(
      fc.property(word, word, (x, y) => {
        fc.pre(x !== y);
        expect(placeMatchesTolerant(`${x} Fort`, `${y} Fort`, "Goa")).toBe(false);
      }),
    );
  });
  it("existing placeMatches is unchanged for reordered names", () => {
    expect(placeMatches("Aguada Fort", ["Fort Aguada"])).toBe(false);
  });
});

// ---- batch-level: verifier name tolerance and reason classification ----

const DEST = "Goa";
const CENTRE = { lat: 15.4989, lng: 73.8278 };
const DETAILS_BASE = "https://places.googleapis.com/v1/places/";

type Mode = "match" | "nomatch" | "http429" | "throw";
const GOOGLE_NAME: Record<string, string> = {
  "Aguada Fort": "Fort Aguada",
  "Fontainhas Latin Quarter": "Fontainhas",
  "Shri Mangueshi Temple": "Shree Mangueshi Temple",
};

function makeFetch(mode: Mode): PostFetchLike {
  return async (url, init) => {
    if (mode === "throw") throw new Error("network down");
    if (mode === "http429") return { ok: false, status: 429, json: async () => ({}) };
    if (url.startsWith(DETAILS_BASE)) {
      const id = decodeURIComponent(url.slice(DETAILS_BASE.length));
      return { ok: true, status: 200, json: async () => ({ id, photos: [{ name: `places/${id}/photos/ph1` }] }) };
    }
    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      textQuery?: string;
      maxResultCount?: number;
    };
    const q = parsed.textQuery ?? "";
    if (typeof parsed.maxResultCount !== "number") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ places: [{ id: "centre", location: { latitude: CENTRE.lat, longitude: CENTRE.lng } }] }),
      };
    }
    if (mode === "nomatch") return { ok: true, status: 200, json: async () => ({}) };
    const place = q.slice(0, q.length - `, ${DEST}`.length);
    const id = `p-${place.replace(/\W+/g, "-").toLowerCase()}`;
    const shown = GOOGLE_NAME[place] ?? place;
    let n = 0;
    for (const ch of id) n += ch.charCodeAt(0);
    const loc = { latitude: CENTRE.lat + (n % 7) * 0.003, longitude: CENTRE.lng + (n % 5) * 0.003 };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        places: [{ id, displayName: { text: shown }, formattedAddress: `${shown}, Candolim, ${DEST}, India`, location: loc }],
      }),
    };
  };
}

const PLACES = [
  "Aguada Fort",
  "Fontainhas Latin Quarter",
  "Baga Beach",
  "Shri Mangueshi Temple",
  "Basilica of Bom Jesus",
  "Chapora Fort",
  "Anjuna Flea Market",
  "Palolem Beach",
  "Dudhsagar Falls",
  "Mapusa Market",
  "Reis Magos Fort",
];
const model = JSON.stringify({
  days: [
    PLACES.slice(0, 3),
    PLACES.slice(3, 6),
    PLACES.slice(6, 9),
  ].map((ps, i) => ({
    title: `Day ${i + 1}`,
    dayTrip: false,
    activities: ps.map((p, k) => ({
      time: `${9 + k * 3}:00`.padStart(5, "0"),
      place: p,
      area: "Goa",
      kind: "sight",
      description: `Visit ${p}`,
      cost: 100,
    })),
  })),
});

const REQ: BatchRequest = {
  action: "itinerary-batch",
  context: {
    origin: "Delhi",
    destination: DEST,
    durationDays: 3,
    budgetLevel: "mid",
    pace: "balanced",
    travellers: { adults: 2, children: 0 },
    interests: ["culture"],
  } as unknown as TripContext,
  fromDay: 1,
  dayCount: 3,
  usedPlaces: [],
};

async function run(mode: Mode) {
  const logs: string[] = [];
  const deps: BatchDeps = {
    invokeModel: async (p) => (p.system.includes("SLOTS TO REPLACE") ? '{"replacements":[]}' : model),
    fetchImpl: makeFetch(mode),
    ground: async () => EMPTY_BUNDLE("disabled"),
    verificationCache: createVerificationCache(),
    logger: (l) => logs.push(l),
  };
  return { resp: await runItineraryBatch(REQ, 3, deps), logs };
}

describe("batch verification with name variants and failure reasons", () => {
  beforeEach(() => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", "test-key");
    clearGroundingMemo();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    clearGroundingMemo();
  });

  it("verifies reordered / honorific variants returned by Places", async () => {
    const { resp } = await run("match");
    expect(resp.source).toBe("model");
    const shown = resp.days.flatMap((d) => d.activities.map((a) => String(a.placeName ?? a.title)));
    expect(shown).toContain("Fort Aguada");
    expect(shown).toContain("Fontainhas");
    expect(shown).toContain("Shree Mangueshi Temple");
    for (const d of resp.days) for (const a of d.activities) expect(a.placeId).toBeTruthy();
  });

  it.each(["http429", "throw"] as const)("all lookups failing (%s) gives reason unavailable", async (mode) => {
    const { resp, logs } = await run(mode);
    expect(resp.days).toEqual([]);
    expect(resp.reason).toBe("unavailable");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^\[itinerary-batch\] days=1-3 proposed=\d+ verified=0 removed=\d+ ms=\d+ outcome=unavailable$/);
  });

  it("no Places match gives reason unverified", async () => {
    const { resp } = await run("nomatch");
    expect(resp.days).toEqual([]);
    expect(resp.reason).toBe("unverified");
  });
});
