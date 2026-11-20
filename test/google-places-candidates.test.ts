import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  CANDIDATE_FIELD_MASK,
  parseCandidates,
  searchCandidatesNearby,
  searchCandidatesText,
  type PostFetchLike,
} from "@/lib/providers/google-places";

const KEY = "SENTINEL-CANDIDATE-KEY-do-not-leak";

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.GOOGLE_PLACES_API_KEY;
  process.env.GOOGLE_PLACES_API_KEY = KEY;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
  else process.env.GOOGLE_PLACES_API_KEY = savedKey;
});

interface Seen {
  url: string;
  init: Parameters<PostFetchLike>[1];
}

function recorder(status: number, body: unknown): { fetchImpl: PostFetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl: PostFetchLike = async (url, init) => {
    seen.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetchImpl, seen };
}

/** A body shaped like a real Places API (New) response. */
const RECORDED_BODY = {
  places: [
    {
      id: "ChIJ_louvre",
      types: ["museum", "tourist_attraction", "point_of_interest", "establishment"],
      formattedAddress: "Rue de Rivoli, 75001 Paris, France",
      location: { latitude: 48.8606, longitude: 2.3376 },
      rating: 4.7,
      googleMapsUri: "https://maps.google.com/?cid=1",
      regularOpeningHours: {
        openNow: true,
        periods: [
          { open: { day: 1, hour: 9, minute: 0 }, close: { day: 1, hour: 18, minute: 0 } },
          { open: { day: 3, hour: 9 }, close: { day: 3, hour: 21, minute: 45 } },
          { open: { day: 9, hour: 9, minute: 0 }, close: { day: 9, hour: 10, minute: 0 } },
          { open: { day: 2, hour: 24, minute: 0 } },
        ],
        weekdayDescriptions: ["Monday: 9:00 AM \u2013 6:00 PM", "Tuesday: Closed"],
      },
      utcOffsetMinutes: 120,
      userRatingCount: 300000,
      displayName: { text: "Louvre Museum", languageCode: "en" },
      primaryType: "museum",
      businessStatus: "OPERATIONAL",
      photos: [
        { name: "places/ChIJ_louvre/photos/A1", widthPx: 4000, heightPx: 3000 },
        { name: "not-a-photo-ref" },
        { name: "places/ChIJ_louvre/photos/A2" },
        { name: "places/ChIJ_louvre/photos/A3" },
        { name: "places/ChIJ_louvre/photos/A4" },
      ],
    },
    { id: "ChIJ_bare", displayName: { text: "Bare Place" }, location: { latitude: 1, longitude: 2 } },
    { id: "", displayName: { text: "No id" }, location: { latitude: 1, longitude: 2 } },
    { id: "x", displayName: { text: "No loc" } },
    { id: "y", location: { latitude: 1, longitude: 2 } },
  ],
};

describe("parseCandidates", () => {
  it("parses a recorded-shape body and drops unusable entries", () => {
    const out = parseCandidates(RECORDED_BODY);
    expect(out?.map((c) => c.placeId)).toEqual(["ChIJ_louvre", "ChIJ_bare"]);
    const c = out![0];
    expect(c).toMatchObject({
      name: "Louvre Museum",
      address: "Rue de Rivoli, 75001 Paris, France",
      location: { lat: 48.8606, lng: 2.3376 },
      rating: 4.7,
      userRatingCount: 300000,
      utcOffsetMinutes: 120,
      primaryType: "museum",
      businessStatus: "OPERATIONAL",
      googleMapsUri: "https://maps.google.com/?cid=1",
    });
    expect(c.types).toContain("museum");
  });

  it("keeps at most 3 valid photo refs in order and skips invalid ones", () => {
    const c = parseCandidates(RECORDED_BODY)![0];
    expect(c.photos).toEqual([
      "places/ChIJ_louvre/photos/A1",
      "places/ChIJ_louvre/photos/A2",
      "places/ChIJ_louvre/photos/A3",
    ]);
  });

  it("parses opening hours and keeps only valid periods", () => {
    const c = parseCandidates(RECORDED_BODY)![0];
    expect(c.hours?.periods).toEqual([
      { open: { day: 1, hour: 9, minute: 0 }, close: { day: 1, hour: 18, minute: 0 } },
      { open: { day: 3, hour: 9, minute: 0 }, close: { day: 3, hour: 21, minute: 45 } },
    ]);
    expect(c.hours?.weekdayDescriptions).toHaveLength(2);
  });

  it("uses null/empty defaults when optional fields are absent", () => {
    const bare = parseCandidates(RECORDED_BODY)![1];
    expect(bare).toMatchObject({
      hours: null,
      utcOffsetMinutes: null,
      rating: null,
      userRatingCount: null,
      primaryType: null,
      businessStatus: null,
      googleMapsUri: null,
      photos: [],
      types: [],
      address: "",
    });
  });

  it("treats a missing places key as an empty success and bad shapes as null", () => {
    expect(parseCandidates({})).toEqual([]);
    expect(parseCandidates(null)).toBeNull();
    expect(parseCandidates([])).toBeNull();
    expect(parseCandidates("x")).toBeNull();
    expect(parseCandidates({ places: "nope" })).toBeNull();
  });
});

describe("searchCandidatesText", () => {
  it("sends the exact 13-field mask, key only in the header, and a 20-result body", async () => {
    const { fetchImpl, seen } = recorder(200, RECORDED_BODY);
    const r = await searchCandidatesText("  museums in Paris ", fetchImpl);
    expect(r.kind).toBe("ok");
    expect(seen).toHaveLength(1);
    const { url, init } = seen[0];
    expect(url).toBe("https://places.googleapis.com/v1/places:searchText");
    expect(init?.method).toBe("POST");
    expect(init?.headers?.["X-Goog-FieldMask"]).toBe(CANDIDATE_FIELD_MASK);
    expect(CANDIDATE_FIELD_MASK.split(",")).toHaveLength(13);
    expect(CANDIDATE_FIELD_MASK).not.toContain("*");
    expect(init?.headers?.["X-Goog-Api-Key"]).toBe(KEY);
    expect(JSON.parse(init!.body!)).toEqual({ textQuery: "museums in Paris", maxResultCount: 20 });
    expect(url).not.toContain(KEY);
    expect(init!.body).not.toContain(KEY);
    const otherHeaders = Object.entries(init!.headers!).filter(([k]) => k !== "X-Goog-Api-Key");
    expect(JSON.stringify(otherHeaders)).not.toContain(KEY);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("treats zero places as a successful empty lookup", async () => {
    const { fetchImpl } = recorder(200, {});
    expect(await searchCandidatesText("nothing here", fetchImpl)).toEqual({ kind: "ok", candidates: [] });
  });

  it("clamps maxResults into 1..20", async () => {
    const hi = recorder(200, {});
    await searchCandidatesText("a", hi.fetchImpl, { maxResults: 99 });
    expect(JSON.parse(hi.seen[0].init!.body!).maxResultCount).toBe(20);
    const lo = recorder(200, {});
    await searchCandidatesText("a", lo.fetchImpl, { maxResults: 0 });
    expect(JSON.parse(lo.seen[0].init!.body!).maxResultCount).toBe(1);
  });

  it("fails without a request for a blank query or missing key", async () => {
    const blank = recorder(200, RECORDED_BODY);
    expect(await searchCandidatesText("   ", blank.fetchImpl)).toEqual({ kind: "failed", cause: "error" });
    expect(blank.seen).toHaveLength(0);
    delete process.env.GOOGLE_PLACES_API_KEY;
    const nokey = recorder(200, RECORDED_BODY);
    expect(await searchCandidatesText("museums", nokey.fetchImpl)).toEqual({ kind: "failed", cause: "error" });
    expect(nokey.seen).toHaveLength(0);
  });

  it("classifies HTTP 429 as rate-limited", async () => {
    const { fetchImpl } = recorder(429, { error: { status: "RESOURCE_EXHAUSTED" } });
    expect(await searchCandidatesText("q", fetchImpl)).toEqual({ kind: "failed", cause: "rate-limited" });
  });

  it("classifies RESOURCE_EXHAUSTED on a non-429 status as rate-limited", async () => {
    const { fetchImpl } = recorder(403, { error: { code: 403, status: "RESOURCE_EXHAUSTED", message: "quota" } });
    expect(await searchCandidatesText("q", fetchImpl)).toEqual({ kind: "failed", cause: "rate-limited" });
  });

  it("returns a counts-only error failure for other non-2xx statuses, even with an unreadable body", async () => {
    const r1 = await searchCandidatesText("q", recorder(500, { error: { status: "INTERNAL", message: KEY } }).fetchImpl);
    expect(r1).toEqual({ kind: "failed", cause: "error" });
    const unreadable: PostFetchLike = async () => ({
      ok: false,
      status: 503,
      json: async () => {
        throw new Error("bad json");
      },
    });
    expect(await searchCandidatesText("q", unreadable)).toEqual({ kind: "failed", cause: "error" });
  });

  it("fails on a malformed 2xx body and when fetch throws, never throwing", async () => {
    expect(await searchCandidatesText("q", recorder(200, { places: 5 }).fetchImpl)).toEqual({
      kind: "failed",
      cause: "error",
    });
    const boom: PostFetchLike = async () => {
      throw new Error(`network ${KEY}`);
    };
    const r = await searchCandidatesText("q", boom);
    expect(r).toEqual({ kind: "failed", cause: "error" });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("aborts at the timeout via the signal and fails", async () => {
    const hang: PostFetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const r = await searchCandidatesText("q", hang, { timeoutMs: 20 });
    expect(r).toEqual({ kind: "failed", cause: "error" });
  });

  it("fails fast when the caller signal is already aborted", async () => {
    const { fetchImpl, seen } = recorder(200, RECORDED_BODY);
    const ac = new AbortController();
    ac.abort();
    expect(await searchCandidatesText("q", fetchImpl, { signal: ac.signal })).toEqual({
      kind: "failed",
      cause: "error",
    });
    expect(seen).toHaveLength(0);
  });
});

describe("searchCandidatesNearby", () => {
  const centre = { lat: 48.8566, lng: 2.3522 };

  it("sends includedTypes and a circle restriction with the exact mask and key header", async () => {
    const { fetchImpl, seen } = recorder(200, RECORDED_BODY);
    const r = await searchCandidatesNearby(centre, 5000, ["museum", "park"], fetchImpl);
    expect(r.kind).toBe("ok");
    const { url, init } = seen[0];
    expect(url).toBe("https://places.googleapis.com/v1/places:searchNearby");
    expect(init?.headers?.["X-Goog-FieldMask"]).toBe(CANDIDATE_FIELD_MASK);
    expect(init?.headers?.["X-Goog-Api-Key"]).toBe(KEY);
    expect(JSON.parse(init!.body!)).toEqual({
      maxResultCount: 20,
      locationRestriction: { circle: { center: { latitude: 48.8566, longitude: 2.3522 }, radius: 5000 } },
      includedTypes: ["museum", "park"],
    });
    expect(init!.body).not.toContain(KEY);
  });

  it("clamps the radius to 1..50000 m", async () => {
    const big = recorder(200, {});
    await searchCandidatesNearby(centre, 1e9, ["park"], big.fetchImpl);
    expect(JSON.parse(big.seen[0].init!.body!).locationRestriction.circle.radius).toBe(50000);
    const small = recorder(200, {});
    await searchCandidatesNearby(centre, -5, ["park"], small.fetchImpl);
    expect(JSON.parse(small.seen[0].init!.body!).locationRestriction.circle.radius).toBe(1);
    const nan = recorder(200, {});
    await searchCandidatesNearby(centre, Number.NaN, ["park"], nan.fetchImpl);
    expect(JSON.parse(nan.seen[0].init!.body!).locationRestriction.circle.radius).toBe(1);
  });

  it("omits includedTypes when none are given", async () => {
    const { fetchImpl, seen } = recorder(200, {});
    await searchCandidatesNearby(centre, 1000, [], fetchImpl);
    expect(JSON.parse(seen[0].init!.body!)).not.toHaveProperty("includedTypes");
  });

  it("fails without a request for a non-finite centre", async () => {
    const { fetchImpl, seen } = recorder(200, RECORDED_BODY);
    expect(await searchCandidatesNearby({ lat: Number.NaN, lng: 0 }, 1000, ["park"], fetchImpl)).toEqual({
      kind: "failed",
      cause: "error",
    });
    expect(seen).toHaveLength(0);
  });

  it("classifies 429 as rate-limited and other errors as error", async () => {
    expect(await searchCandidatesNearby(centre, 1000, ["park"], recorder(429, {}).fetchImpl)).toEqual({
      kind: "failed",
      cause: "rate-limited",
    });
    expect(await searchCandidatesNearby(centre, 1000, ["park"], recorder(500, {}).fetchImpl)).toEqual({
      kind: "failed",
      cause: "error",
    });
  });
});
