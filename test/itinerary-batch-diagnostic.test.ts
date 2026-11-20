import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { runItineraryBatch, type BatchDeps } from "../lib/itinerary/batch-service";
import type { BatchRequest, BatchResponse } from "../lib/itinerary/batch-wire";
import { clearGroundingMemo } from "../lib/itinerary/grounding-memo";
import { createVerificationCache } from "../lib/itinerary/verification-cache";
import { EMPTY_BUNDLE } from "../lib/grounding/types";
import type { PostFetchLike } from "../lib/providers/google-places";
import type { TripContext } from "../lib/types";

// Counts-only diagnostic for batches where no day verifies. Real
// runItineraryBatch, injected model and Places transport.

const DEST = "Goa";
const CENTRE = { lat: 15.4989, lng: 73.8278 };
const OUTSIDE = { lat: 23.0225, lng: 72.5714 };
const DIAG_RE =
  /^\[itinerary-batch-diag\] cause=(parse|verify|lookup) prefilter=\d+ duplicate=\d+ lookupFailed=\d+ noMatch=\d+ outside=\d+ tooFew=\d+ parseLen=\d+ truncated=(true|false)$/;

type Mode = "fail" | "nomatch" | "outside";

beforeEach(() => {
  vi.stubEnv("GOOGLE_PLACES_API_KEY", "test-key");
  clearGroundingMemo();
});
afterEach(() => {
  vi.unstubAllEnvs();
  clearGroundingMemo();
});

function makeFetch(mode: Mode): PostFetchLike {
  return async (url, init) => {
    if (mode === "fail") return { ok: false, status: 429, json: async () => ({}) };
    if (url.includes("/v1/places/") && !url.endsWith(":searchText")) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    let parsed: { textQuery?: unknown; maxResultCount?: unknown } = {};
    try {
      parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as typeof parsed;
    } catch {
      parsed = {};
    }
    const q = typeof parsed.textQuery === "string" ? parsed.textQuery : "";
    if (typeof parsed.maxResultCount !== "number") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ places: [{ id: "centre", location: { latitude: CENTRE.lat, longitude: CENTRE.lng } }] }),
      };
    }
    if (mode === "nomatch") return { ok: true, status: 200, json: async () => ({}) };
    const place = q.endsWith(`, ${DEST}`) ? q.slice(0, q.length - DEST.length - 2) : q;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        places: [
          {
            id: `p-${place.length}-${place.charCodeAt(0)}`,
            displayName: { text: place },
            formattedAddress: `${place}, Ahmedabad, Gujarat, India`,
            location: { latitude: OUTSIDE.lat, longitude: OUTSIDE.lng },
          },
        ],
      }),
    };
  };
}

const CONTEXT = {
  origin: "Delhi",
  destination: DEST,
  durationDays: 3,
  budgetLevel: "mid",
  pace: "balanced",
  travellers: { adults: 2, children: 0 },
  interests: ["culture"],
} as unknown as TripContext;

const REQ: BatchRequest = {
  action: "itinerary-batch",
  context: CONTEXT,
  fromDay: 1,
  dayCount: 1,
  usedPlaces: [],
};

const act = (place: string, i: number) => ({
  time: `${String(9 + i * 2).padStart(2, "0")}:00`,
  place,
  area: "Area",
  kind: "sight",
  description: `A visit to ${place}`,
  cost: 100,
});
const oneDay = (places: string[]) =>
  JSON.stringify({ days: [{ title: "Day one", dayTrip: false, activities: places.map(act) }] });

async function run(
  text: string,
  mode: Mode,
): Promise<{ resp: BatchResponse; logs: string[]; diags: string[] }> {
  const logs: string[] = [];
  const diags: string[] = [];
  const deps: BatchDeps = {
    invokeModel: async (p) => (p.system.includes("SLOTS TO REPLACE") ? '{"replacements":[]}' : text),
    fetchImpl: makeFetch(mode),
    ground: async () => EMPTY_BUNDLE("disabled"),
    verificationCache: createVerificationCache(),
    logger: (l) => logs.push(l),
    diagLogger: (l) => diags.push(l),
  };
  const resp = await runItineraryBatch(REQ, 3, deps);
  return { resp, logs, diags };
}

describe("unverified diagnostic", () => {
  it("parse failure: cause=parse with text length", async () => {
    const { resp, logs, diags } = await run("this is not json", "fail");
    expect(resp.source).toBe("unavailable");
    expect(logs).toHaveLength(1);
    expect(diags).toEqual([
      "[itinerary-batch-diag] cause=parse prefilter=0 duplicate=0 lookupFailed=0 noMatch=0 outside=0 tooFew=0 parseLen=16 truncated=false",
    ]);
  });

  it("every lookup failing: cause=lookup, reason unavailable", async () => {
    const { resp, diags } = await run(oneDay(["Aurelia Fort", "Brightwater Museum", "Cedar Gardens"]), "fail");
    expect(resp.source === "unavailable" && resp.reason).toBe("unavailable");
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatch(/^\[itinerary-batch-diag\] cause=lookup prefilter=0 duplicate=0 lookupFailed=3 noMatch=0 outside=0 tooFew=1 /);
  });

  it("no Places match: cause=verify with noMatch tally", async () => {
    const { resp, diags } = await run(oneDay(["Aurelia Fort", "Brightwater Museum", "Cedar Gardens"]), "nomatch");
    expect(resp.source === "unavailable" && resp.reason).toBe("unverified");
    expect(diags[0]).toMatch(/^\[itinerary-batch-diag\] cause=verify prefilter=0 duplicate=0 lookupFailed=0 noMatch=3 outside=0 tooFew=1 /);
  });

  it("outside the destination: cause=verify with outside tally", async () => {
    const { resp, diags } = await run(oneDay(["Aurelia Fort", "Brightwater Museum", "Cedar Gardens"]), "outside");
    expect(resp.source === "unavailable" && resp.reason).toBe("unverified");
    expect(diags[0]).toMatch(/^\[itinerary-batch-diag\] cause=verify prefilter=0 duplicate=0 lookupFailed=0 noMatch=0 outside=3 tooFew=1 /);
  });

  it("pre-filter drops plus lookup failures: still cause=lookup, reason unavailable", async () => {
    const { resp, diags } = await run(
      oneDay(["Free time", "Rest day", "Aurelia Fort", "Brightwater Museum", "Cedar Gardens"]),
      "fail",
    );
    expect(resp.source === "unavailable" && resp.reason).toBe("unavailable");
    expect(diags[0]).toMatch(/^\[itinerary-batch-diag\] cause=lookup prefilter=2 duplicate=0 lookupFailed=3 noMatch=0 outside=0 tooFew=1 /);
  });

  it("emits no diagnostic for not-configured", async () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", "");
    const logs: string[] = [];
    const diags: string[] = [];
    const resp = await runItineraryBatch(REQ, 3, {
      invokeModel: async () => oneDay(["Aurelia Fort"]),
      hasKey: () => false,
      logger: (l) => logs.push(l),
      diagLogger: (l) => diags.push(l),
    });
    expect(resp.source === "unavailable" && resp.reason).toBe("not-configured");
    expect(diags).toHaveLength(0);
  });

  it("property: the diag line holds only fixed words and numbers, never names", async () => {
    const word = fc.stringMatching(/^[a-z]{4,10}$/).map((s) => `Xq${s}`);
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(word, { minLength: 3, maxLength: 5 }),
        fc.constantFrom<Mode>("fail", "nomatch", "outside"),
        async (names, mode) => {
          const places = names.map((n) => `${n} Fort`);
          const { diags } = await run(oneDay(places), mode);
          expect(diags).toHaveLength(1);
          expect(diags[0]).toMatch(DIAG_RE);
          for (const n of names) {
            expect(diags[0]).not.toContain(n);
            expect(diags[0]).not.toContain(`${n}, ${DEST}`);
          }
          expect(diags[0]).not.toContain("test-key");
        },
      ),
      { numRuns: 15 },
    );
  });
});
