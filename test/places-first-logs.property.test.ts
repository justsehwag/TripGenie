import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { BatchRequest } from "@/lib/itinerary/batch-wire";
import { createCandidateCache } from "@/lib/itinerary/candidate-search";
import { runPlacesFirstBatch, type PlacesFirstDeps } from "@/lib/itinerary/places-first-batch";
import { clearPolishMemo } from "@/lib/itinerary/polish";
import type { ModelPrompt } from "@/lib/bedrock-model";
import type { ResearchConfig } from "@/lib/web-pricing/service";

// Feature: places-first-itinerary, Property 27: Logs contain only counts and fixed words

const SEARX_ON: ResearchConfig = { enabled: true, baseUrl: "https://sx.example.test", secretHeader: null };
const SEARX_OFF: ResearchConfig = { enabled: false, baseUrl: "", secretHeader: null };

const BATCH_RE =
  /^\[itinerary-batch\] days=\d+-\d+ proposed=\d+ verified=\d+ removed=\d+ ms=\d+ places=\d+ cached=\d+ enrich=\d+ planner=(accepted|rejected|fallback) repaired=(0|1) outcome=(ok|partial|unavailable|not-configured|timeout)$/;
const BATCH_GENERIC_RE = /^\[itinerary-batch\]( [a-z]+=[0-9a-z-]+)+$/;
const DIAG_RE =
  /^\[itinerary-batch-diag\] cause=(parse|verify|lookup) prefilter=\d+ duplicate=\d+ lookupFailed=\d+ noMatch=\d+ outside=\d+ tooFew=\d+ parseLen=\d+ truncated=(true|false)$/;

const CENTRE = { lat: 15.4989, lng: 73.8278 };
const TYPES = ["tourist_attraction", "museum", "park", "restaurant"];

/** Adversarial text. The fixed prefix makes an accidental match with a fixed log word impossible. */
const tokenArb = fc.stringMatching(/^[A-Za-z0-9 \[\]=.\/:_-]{5,20}$/).map((s) => `Zq~${s}`);
const keyArb = fc.stringMatching(/^[A-Za-z0-9]{12,30}$/).map((s) => `AIzaFake${s}`);

const fetchModeArb = fc.constantFrom("ok", "ok", "ok", "throw", "http500", "429", "badjson");
const modelModeArb = fc.constantFrom("none", "good", "garbage", "throw");

const scenarioArb = fc.record({
  key: keyArb,
  destination: tokenArb,
  names: fc.array(tokenArb, { maxLength: 14 }),
  modelText: tokenArb,
  errorText: tokenArb,
  fetchMode: fetchModeArb,
  modelMode: modelModeArb,
  enrich: fc.constantFrom("off", "off", "throws"),
  dayCount: fc.integer({ min: 1, max: 4 }),
  interests: fc.array(fc.constantFrom("culture", "food", "nature", "history", "beaches"), { maxLength: 3 }),
  tick: fc.constantFrom(0, 0, 40, 2000),
});
type ArbValue<A> = A extends fc.Arbitrary<infer T> ? T : never;
type Scenario = ArbValue<typeof scenarioArb>;

function res(status: number, json: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => json };
}

function place(id: string, name: string, i: number) {
  return {
    id,
    displayName: { text: name },
    formattedAddress: `Main Road, Calangute, Goa 403001, India`,
    location: { latitude: CENTRE.lat + (i % 7) * 0.004, longitude: CENTRE.lng + (i % 5) * 0.004 },
    businessStatus: "OPERATIONAL",
    types: [TYPES[i % TYPES.length], "point_of_interest", "establishment"],
    primaryType: TYPES[i % TYPES.length],
    rating: 4.3,
    userRatingCount: 1000 - i * 10,
  };
}

function goodPolish(prompt: ModelPrompt): string {
  const input = JSON.parse(prompt.user) as { days: number[]; stops: Array<{ placeId: string; day: number }> };
  return JSON.stringify({
    days: input.days.map((d) => ({
      day: d,
      title: "A good day",
      stops: input.stops.filter((s) => s.day === d).map((s) => ({ placeId: s.placeId, sentence: "A good place to spend a relaxed while." })),
    })),
  });
}

function buildDeps(s: Scenario, lines: string[], diag: string[], throwingLoggers: boolean): PlacesFirstDeps {
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    if (s.fetchMode === "throw") throw new Error(`${s.errorText} ${url} ${s.key}`);
    if (s.fetchMode === "http500") return res(500, { error: { message: `${s.errorText} ${s.key}` } });
    if (s.fetchMode === "429") return res(429, { error: { status: "RESOURCE_EXHAUSTED", message: s.errorText } });
    if (s.fetchMode === "badjson") {
      return { ok: true, status: 200, json: async () => { throw new Error(`${s.errorText} ${s.key}`); } };
    }
    const mask = init?.headers?.["X-Goog-FieldMask"] ?? "";
    if (mask === "places.id,places.location") {
      return res(200, { places: [{ id: "centre", location: { latitude: CENTRE.lat, longitude: CENTRE.lng } }] });
    }
    return res(200, { places: s.names.map((n, i) => place(`p${i}`, n, i)) });
  };
  const invokeModel =
    s.modelMode === "none"
      ? undefined
      : async (p: ModelPrompt) => {
          if (s.modelMode === "throw") throw new Error(`${s.errorText} ${s.modelText}`);
          if (s.modelMode === "garbage") return `${s.modelText} {"days":[{"day":1,"title":"${s.modelText}","stops":[{"placeId":"${s.modelText}"}]}]}`;
          return goodPolish(p);
        };
  let t = 1_000_000;
  const logger = (l: string) => {
    if (throwingLoggers) throw new Error(`${s.errorText} logger down`);
    lines.push(l);
  };
  const diagLogger = (l: string) => {
    if (throwingLoggers) throw new Error(`${s.errorText} diag down`);
    diag.push(l);
  };
  return {
    now: () => {
      t += s.tick;
      return t;
    },
    logger,
    diagLogger,
    candidateCache: createCandidateCache(),
    fetchImpl,
    ...(invokeModel ? { invokeModel } : {}),
    enrichment:
      s.enrich === "throws"
        ? {
            config: SEARX_ON,
            research: async () => {
              throw new Error(`${s.errorText} ${s.key}`);
            },
          }
        : { config: SEARX_OFF },
  };
}

function requestOf(s: Scenario): BatchRequest {
  return {
    action: "itinerary-batch",
    context: { destination: s.destination, durationDays: s.dayCount, pace: "balanced", interests: s.interests },
    fromDay: 1,
    dayCount: s.dayCount,
    usedPlaces: [],
  };
}

/** Response without the elapsed-time field. */
function stable(resp: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(resp)) as { stats?: { ms?: number } };
  if (copy.stats) delete copy.stats.ms;
  return copy;
}

beforeEach(() => {
  clearPolishMemo();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Property 27: Logs contain only counts and fixed words", () => {
  it("writes one counts-only batch line, at most one diag line, no input strings, and survives throwing loggers", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (s) => {
        vi.stubEnv("GOOGLE_PLACES_API_KEY", s.key);
        clearPolishMemo();
        const lines: string[] = [];
        const diag: string[] = [];
        const resp = await runPlacesFirstBatch(requestOf(s), s.dayCount, buildDeps(s, lines, diag, false));

        expect(lines).toHaveLength(1);
        expect(lines[0].startsWith("[itinerary-batch]")).toBe(true);
        expect(lines[0]).toMatch(BATCH_RE);
        expect(lines[0]).toMatch(BATCH_GENERIC_RE);
        expect(diag.length).toBeLessThanOrEqual(1);
        if (resp.days.length > 0) expect(diag).toHaveLength(0);
        for (const d of diag) expect(d).toMatch(DIAG_RE);

        const secrets = [s.key, s.destination, s.modelText, s.errorText, ...s.names, "sx.example.test", "googleapis"];
        for (const line of [...lines, ...diag]) {
          for (const secret of secrets) {
            expect(line).not.toContain(secret);
            expect(line).not.toContain(secret.trim());
          }
        }

        // A logger that throws changes nothing about the response.
        clearPolishMemo();
        const lines2: string[] = [];
        const diag2: string[] = [];
        const resp2 = await runPlacesFirstBatch(requestOf(s), s.dayCount, buildDeps(s, lines2, diag2, true));
        expect(lines2).toHaveLength(0);
        expect(diag2).toHaveLength(0);
        expect(stable(resp2)).toEqual(stable(resp));
      }),
      { numRuns: 120 },
    );
  });
});
