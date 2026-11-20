import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { runItineraryBatch, type BatchDeps } from "../lib/itinerary/batch-service";
import type { BatchRequest, BatchResponse } from "../lib/itinerary/batch-wire";
import { clearGroundingMemo } from "../lib/itinerary/grounding-memo";
import { createVerificationCache } from "../lib/itinerary/verification-cache";
import { nameKey } from "../lib/itinerary/place-key";
import { EMPTY_BUNDLE } from "../lib/grounding/types";
import type { PostFetchLike } from "../lib/providers/google-places";
import type { TripContext } from "../lib/types";

// Preservation tests: they pin what the UNFIXED batch service does for inputs
// outside the bug condition (genuine failures, rejections, partial trips, log
// line). They must pass before and after the fix.

const DEST = "Goa";
const CENTRE = { lat: 15.4989, lng: 73.8278 };
const OUTSIDE = { lat: 23.0225, lng: 72.5714 };
const DETAILS_BASE = "https://places.googleapis.com/v1/places/";
const LOG_RE =
  /^\[itinerary-batch\] days=(\d+)-(\d+) proposed=(\d+) verified=(\d+) removed=(\d+) ms=(\d+) outcome=(ok|partial|unavailable|not-configured|timeout)$/;

type Mode = "match" | "nomatch" | "wrongName" | "outside" | "http500" | "throw";

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
    if (mode === "throw") throw new Error("network down");
    if (mode === "http500") return { ok: false, status: 500, json: async () => ({}) };
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
    const q = typeof parsed.textQuery === "string" ? parsed.textQuery : "";
    if (typeof parsed.maxResultCount !== "number") {
      if (q !== DEST) return { ok: false, status: 500, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ places: [{ id: "centre", location: { latitude: CENTRE.lat, longitude: CENTRE.lng } }] }),
      };
    }
    const suffix = `, ${DEST}`;
    if (!q.endsWith(suffix)) return { ok: false, status: 400, json: async () => ({}) };
    const place = q.slice(0, q.length - suffix.length);
    // "Ghost ..." places never exist in Places, whatever the mode.
    if (mode === "nomatch" || /^ghost/i.test(place)) return { ok: true, status: 200, json: async () => ({}) };
    const id = `p-${nameKey(place).replace(/\s+/g, "-")}`;
    let n = 0;
    for (const ch of id) n += ch.charCodeAt(0);
    const near = { latitude: CENTRE.lat + (n % 7) * 0.003, longitude: CENTRE.lng + (n % 5) * 0.003 };
    const cand =
      mode === "wrongName"
        ? { id, displayName: { text: "Zzyzx Unrelated Landmark" }, formattedAddress: `Margao, ${DEST}, India`, location: near }
        : mode === "outside"
          ? {
              id,
              displayName: { text: place },
              formattedAddress: `${place}, Ahmedabad, Gujarat, India`,
              location: { latitude: OUTSIDE.lat, longitude: OUTSIDE.lng },
            }
          : { id, displayName: { text: place }, formattedAddress: `${place}, Candolim, ${DEST}, India`, location: near };
    return { ok: true, status: 200, json: async () => ({ places: [cand] }) };
  };
}

const FIRSTS = ["Aurelia", "Brightwater", "Cedar", "Dunmore", "Eastgate", "Fernhill", "Glenmarrow", "Harrow", "Ivory", "Juniper"];
const NOUNS = ["Fort", "Museum", "Gardens", "Cathedral", "Lighthouse", "Observatory", "Palace", "Bridge"];
const placeName = (i: number) => `${FIRSTS[i % FIRSTS.length]} ${NOUNS[Math.floor(i / FIRSTS.length) % NOUNS.length]}`;

type Act = { time: string; place: string; area: string; kind: string; description: string; cost: number };
const act = (place: string, time: string): Act => ({
  time,
  place,
  area: "Area",
  kind: "sight",
  description: `A visit to ${place}`,
  cost: 100,
});
const day = (title: string, places: string[]) => ({
  title,
  dayTrip: false,
  activities: places.map((p, i) => act(p, `${9 + i * 2}:00`.padStart(5, "0"))),
});

function modelText(days: Array<{ title: string; places: string[] }>): string {
  return JSON.stringify({ days: days.map((d) => day(d.title, d.places)) });
}

/** Three days, disjoint place names built from an offset. */
function threeDays(offset: number): string {
  let c = offset;
  const take = (n: number) => Array.from({ length: n }, () => placeName(c++));
  return modelText([
    { title: "Old Goa", places: take(3) },
    { title: "North coast", places: take(4) },
    { title: "South coast", places: take(4) },
  ]);
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
  dayCount: 3,
  usedPlaces: [],
};

async function run(
  text: string,
  mode: Mode,
  extra: Partial<BatchDeps> = {},
): Promise<{ resp: BatchResponse; logs: string[] }> {
  const logs: string[] = [];
  const deps: BatchDeps = {
    invokeModel: async (p) => (p.system.includes("SLOTS TO REPLACE") ? '{"replacements":[]}' : text),
    fetchImpl: makeFetch(mode),
    ground: async () => EMPTY_BUNDLE("disabled"),
    verificationCache: createVerificationCache(),
    logger: (l) => logs.push(l),
    ...extra,
  };
  const resp = await runItineraryBatch(REQ, 3, deps);
  return { resp, logs };
}

const names = (r: BatchResponse) => r.days.flatMap((d) => d.activities.map((a) => nameKey(String(a.placeName ?? a.title))));

describe("preservation: genuine failures", () => {
  it("no key gives not-configured and shows nothing", async () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", "");
    const fetchImpl = vi.fn(makeFetch("match"));
    const { resp } = await run(threeDays(0), "match", { hasKey: () => false, fetchImpl });
    expect(resp.source).toBe("unavailable");
    expect(resp.reason).toBe("not-configured");
    expect(resp.days).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["http500", "throw"] as const)("every lookup %s gives no plan and a failure reason", async (mode) => {
    const { resp } = await run(threeDays(0), mode);
    expect(resp.source).toBe("unavailable");
    expect(["unavailable", "unverified"]).toContain(resp.reason);
    expect(resp.days).toEqual([]);
    expect(resp.verifiedDays).toEqual([]);
    expect(resp.withheldDays).toEqual([1, 2, 3]);
  });

  it("nothing verifiable (generic rows only) gives no plan", async () => {
    const generic = modelText([
      { title: "Day one", places: ["Local lunch", "Free time", "Explore the city"] },
      { title: "Day two", places: ["Free time", "Local dinner", "Leisure"] },
      { title: "Day three", places: ["Explore the city", "Local lunch", "Free time"] },
    ]);
    const { resp } = await run(generic, "match");
    expect(resp.source).toBe("unavailable");
    expect(["unavailable", "unverified"]).toContain(resp.reason);
    expect(resp.days).toEqual([]);
  });

  it("empty model text gives unavailable, unparseable non-empty text gives unverified", async () => {
    const empty = await run("", "match");
    expect(empty.resp.source).toBe("unavailable");
    expect(empty.resp.reason).toBe("unavailable");
    const junk = await run("I cannot help with that.", "match");
    expect(junk.resp.source).toBe("unavailable");
    expect(junk.resp.reason).toBe("unverified");
    expect(junk.resp.days).toEqual([]);
  });
});

describe("preservation: rejections are never shown", () => {
  const modes = ["nomatch", "wrongName", "outside"] as const;
  it("sanity: matching in-destination candidates are accepted", async () => {
    const { resp } = await run(threeDays(0), "match");
    expect(resp.source).toBe("model");
    expect(resp.days.length).toBeGreaterThan(0);
    for (const d of resp.days) {
      for (const a of d.activities) {
        expect(a.verified).toBe(true);
        expect(typeof a.placeId === "string" && a.placeId.length > 0).toBe(true);
        expect(a.location).toBeTruthy();
      }
    }
  });

  it("no match, non-matching name or outside destination never reaches the plan (generated candidates)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...modes), fc.integer({ min: 0, max: 40 }), async (mode, offset) => {
        const { resp } = await run(threeDays(offset), mode);
        expect(resp.source).toBe("unavailable");
        expect(["unavailable", "unverified"]).toContain(resp.reason);
        expect(resp.days).toEqual([]);
        expect(resp.verifiedDays).toEqual([]);
        expect(names(resp)).toEqual([]);
      }),
      { numRuns: 15 },
    );
  });

  it("every shown stop carries a placeId, a location and a matching name (generated)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 40 }), async (offset) => {
        const text = threeDays(offset);
        const proposed = new Set(
          (JSON.parse(text) as { days: Array<{ activities: Act[] }> }).days.flatMap((d) =>
            d.activities.map((a) => nameKey(a.place)),
          ),
        );
        const { resp } = await run(text, "match");
        for (const d of resp.days) {
          for (const a of d.activities) {
            expect(a.verified).toBe(true);
            expect(String(a.placeId).length).toBeGreaterThan(0);
            expect(Number.isFinite(a.location?.lat) && Number.isFinite(a.location?.lng)).toBe(true);
            expect(proposed.has(nameKey(String(a.placeName)))).toBe(true);
          }
        }
      }),
      { numRuns: 10 },
    );
  });
});

describe("preservation: partial trip", () => {
  it("verified days are returned and the unverifiable day is withheld", async () => {
    const text = modelText([
      { title: "Old Goa", places: [placeName(0), placeName(1), placeName(2)] },
      { title: "North coast", places: [placeName(3), placeName(4), placeName(5), placeName(6)] },
      { title: "Phantom day", places: ["Ghost Tower", "Ghost Harbour", "Ghost Market", "Ghost Temple"] },
    ]);
    const { resp, logs } = await run(text, "match");
    expect(resp.source).toBe("model");
    expect(resp.verifiedDays).toEqual([1, 2]);
    expect(resp.withheldDays).toEqual([3]);
    expect(resp.days.map((d) => d.day)).toEqual([1, 2]);
    expect(names(resp).some((n) => n.includes("ghost"))).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/outcome=partial$/);
  });
});

describe("preservation: the [itinerary-batch] log line", () => {
  function expectOneLine(logs: string[], resp: BatchResponse) {
    expect(logs).toHaveLength(1);
    const m = LOG_RE.exec(logs[0]);
    expect(m).not.toBeNull();
    const [, a, b, proposed, verified, removed, ms] = m!;
    expect(Number(a)).toBe(resp.fromDay);
    expect(Number(b)).toBe(resp.fromDay + resp.dayCount - 1);
    expect(Number(proposed)).toBe(resp.stats.proposed);
    expect(Number(verified)).toBe(resp.stats.verified);
    expect(Number(removed)).toBe(resp.stats.removed);
    expect(Number(ms)).toBe(resp.stats.ms);
    return m![7];
  }

  it("ok batch logs one line with the fields in order", async () => {
    const { resp, logs } = await run(threeDays(0), "match");
    expect(expectOneLine(logs, resp)).toBe("ok");
    expect(logs[0].startsWith("[itinerary-batch] days=1-3 proposed=")).toBe(true);
  });

  it("not-configured, failure and unverified outcomes log exactly one line", async () => {
    const nc = await run(threeDays(0), "match", { hasKey: () => false });
    expect(expectOneLine(nc.logs, nc.resp)).toBe("not-configured");
    const down = await run(threeDays(0), "http500");
    expectOneLine(down.logs, down.resp);
    const rej = await run(threeDays(0), "nomatch");
    expectOneLine(rej.logs, rej.resp);
    const junk = await run("not json", "match");
    expectOneLine(junk.logs, junk.resp);
  });

  it("the line holds no place names or query text", async () => {
    const { logs } = await run(threeDays(0), "match");
    for (const f of FIRSTS) expect(logs[0]).not.toContain(f);
    expect(logs[0]).not.toContain(DEST);
  });
});

describe("preservation: .chat-chip stays", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("globals.css keeps the .chat-chip rules", () => {
    const css = read("../app/globals.css");
    expect(css).toMatch(/\.chat-chip\s*\{/);
    expect(css).toMatch(/\.chat-chip:hover\s*\{/);
    expect(css).toMatch(/\.chat-chip:focus-visible\s*\{/);
    expect(css).toMatch(/\.concierge-chips \.chat-chip\s*\{/);
  });

  it("concierge-home and quick-form still use the class", () => {
    expect(read("../components/concierge-home.tsx")).toContain("chat-chip");
    expect(read("../components/quick-form.tsx")).toContain("chat-chip");
  });
});
