// Feature: chat-images-bedrock-planner, Property 18: Logs are counts-only
// Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.8
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fc from "fast-check";
import type { BatchRequest } from "@/lib/itinerary/batch-wire";
import { createCandidateCache } from "@/lib/itinerary/candidate-search";
import { runPlacesFirstBatch, type PlacesFirstDeps } from "@/lib/itinerary/places-first-batch";
import { clearPolishMemo } from "@/lib/itinerary/polish";

const BATCH_RE =
  /^\[itinerary-batch\] days=\d+-\d+ proposed=\d+ verified=\d+ removed=\d+ ms=\d+ places=\d+ cached=\d+ enrich=\d+ planner=(accepted|rejected|fallback) repaired=(0|1) outcome=(ok|partial|unavailable|not-configured|timeout)$/;
const DIAG_RE =
  /^\[itinerary-batch-diag\] cause=(parse|verify|lookup) prefilter=\d+ duplicate=\d+ lookupFailed=\d+ noMatch=\d+ outside=\d+ tooFew=\d+ parseLen=\d+ truncated=(true|false)$/;

const CENTRE = { lat: 15.4989, lng: 73.8278 };
const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789".split("");

/** Adversarial token: an uppercase marker no fixed log text contains, then random characters. */
const token = (tag: string) =>
  fc
    .array(fc.constantFrom(...ALNUM), { minLength: 6, maxLength: 14 })
    .map((cs) => `ZQX${tag}${cs.join("")}`);

type PlacesMode = "ok" | "http500" | "throw";
type ModelMode = "none" | "throw" | "garbage" | "plan";
type Loggers = "normal" | "throwing";

const scenario = fc.record({
  names: fc.array(token("N"), { minLength: 14, maxLength: 14 }),
  destination: token("D"),
  modelText: token("M"),
  errorText: token("E"),
  key: token("K"),
  places: fc.constantFrom<PlacesMode>("ok", "ok", "http500", "throw"),
  model: fc.constantFrom<ModelMode>("none", "throw", "garbage", "plan", "plan"),
  days: fc.integer({ min: 1, max: 3 }),
});
type Scenario = typeof scenario extends fc.Arbitrary<infer T> ? T : never;

function res(status: number, json: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => json };
}

function makeDeps(s: Scenario, lines: string[], diag: string[], loggers: Loggers): PlacesFirstDeps {
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    const mask = init?.headers?.["X-Goog-FieldMask"] ?? "";
    if (mask === "places.id,places.location") {
      return res(200, { places: [{ id: "centre", location: { latitude: CENTRE.lat, longitude: CENTRE.lng } }] });
    }
    if (s.places === "throw") throw new Error(`${s.errorText} ${s.key} ${url}`);
    if (s.places === "http500") return res(500, { error: { message: s.errorText } });
    const list = s.names.map((name, i) => ({
      id: `pid${i}`,
      displayName: { text: name },
      formattedAddress: `${name} Road, ${s.destination}`,
      location: { latitude: CENTRE.lat + (i % 7) * 0.004, longitude: CENTRE.lng + (i % 5) * 0.004 },
      businessStatus: "OPERATIONAL",
      types: [i % 4 === 3 ? "restaurant" : "tourist_attraction", "point_of_interest"],
      primaryType: i % 4 === 3 ? "restaurant" : "tourist_attraction",
      rating: 4.4,
      userRatingCount: 900 - i * 10,
    }));
    return res(200, { places: list });
  };

  let invokeModel: PlacesFirstDeps["invokeModel"];
  if (s.model === "throw") {
    invokeModel = async () => {
      throw new Error(`${s.errorText} ${s.key}`);
    };
  } else if (s.model === "garbage") {
    invokeModel = async () => `${s.modelText} {not json ${s.key}`;
  } else if (s.model === "plan") {
    invokeModel = async (prompt) => {
      try {
        const input = JSON.parse(prompt.user) as {
          days: Array<{ day: number; earliestStart: string; minStops: number }>;
          candidates: Array<{ placeId: string; primaryType: string | null }>;
        };
        const pool = input.candidates.filter((c) => c.primaryType !== "restaurant");
        let next = 0;
        return JSON.stringify({
          days: input.days.map((d) => ({
            day: d.day,
            startTime: d.earliestStart,
            title: s.modelText,
            stops: pool
              .slice(next, (next += Math.max(1, d.minStops)))
              .map((c) => ({ placeId: c.placeId, sentence: `${s.modelText} ${s.key}` })),
          })),
        });
      } catch {
        return s.modelText;
      }
    };
  }

  const throwing = loggers === "throwing";
  return {
    hasKey: () => true,
    now: () => 1_000_000,
    logger: (l) => {
      lines.push(l);
      if (throwing) throw new Error(`${s.errorText} logger`);
    },
    diagLogger: (l) => {
      diag.push(l);
      if (throwing) throw new Error(`${s.errorText} diag`);
    },
    candidateCache: createCandidateCache(),
    enrichment: { config: { enabled: false, baseUrl: "", secretHeader: null } },
    fetchImpl,
    invokeModel,
  };
}

function request(s: Scenario): BatchRequest {
  return {
    action: "itinerary-batch",
    context: { destination: s.destination, durationDays: s.days, pace: "balanced", interests: [] },
    fromDay: 1,
    dayCount: s.days,
    usedPlaces: [],
  };
}

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.GOOGLE_PLACES_API_KEY;
  clearPolishMemo();
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
  else process.env.GOOGLE_PLACES_API_KEY = savedKey;
});

describe("Property 18: Logs are counts-only", () => {
  it("writes one strict batch line, at most one diag line, no generated text, and survives throwing loggers", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        process.env.GOOGLE_PLACES_API_KEY = s.key;
        const lines: string[] = [];
        const diag: string[] = [];
        const resp = await runPlacesFirstBatch(request(s), s.days, makeDeps(s, lines, diag, "normal"));

        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(BATCH_RE);
        expect(diag.length).toBeLessThanOrEqual(1);
        for (const d of diag) expect(d).toMatch(DIAG_RE);

        const generated = [...s.names, s.destination, s.modelText, s.errorText, s.key];
        for (const line of [...lines, ...diag]) {
          for (const g of generated) expect(line.includes(g)).toBe(false);
          expect(line).not.toMatch(/https?:|ZQX/);
        }

        const lines2: string[] = [];
        const diag2: string[] = [];
        const resp2 = await runPlacesFirstBatch(request(s), s.days, makeDeps(s, lines2, diag2, "throwing"));
        expect(JSON.stringify(resp2)).toBe(JSON.stringify(resp));
      }),
      { numRuns: 100 },
    );
  });
});
