import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fc from "fast-check";
import {
  CANDIDATE_FIELD_MASK,
  searchCandidatesNearby,
  searchCandidatesText,
  type CandidateLookup,
  type PostFetchLike,
} from "../lib/providers/google-places";

// Feature: places-first-itinerary, Property 3: Places requests use the exact mask and keep the key in the header
// Validates: Requirements 1.5, 1.6, 5.7, 13.6, 13.7

const EXPECTED_FIELDS = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.rating",
  "places.userRatingCount",
  "places.regularOpeningHours",
  "places.utcOffsetMinutes",
  "places.types",
  "places.primaryType",
  "places.businessStatus",
  "places.googleMapsUri",
  "places.photos",
];

const NUM_RUNS = 100;

interface Seen {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string } | undefined;
}

type Behaviour =
  | { kind: "ok"; body: unknown }
  | { kind: "status"; status: number; body: unknown }
  | { kind: "throws"; withKey: boolean }
  | { kind: "json-rejects" };

function makeFetch(key: string, behaviour: Behaviour): { fetchImpl: PostFetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl: PostFetchLike = async (url, init) => {
    seen.push({ url, init });
    switch (behaviour.kind) {
      case "ok":
        return { ok: true, status: 200, json: async () => behaviour.body };
      case "status":
        return { ok: false, status: behaviour.status, json: async () => behaviour.body };
      case "throws":
        throw new Error(behaviour.withKey ? `network down for ${key}` : "network down");
      case "json-rejects":
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new Error(`bad json ${key}`);
          },
        };
    }
  };
  return { fetchImpl, seen };
}

// A fake key distinctive enough that it cannot occur by chance in constant URLs.
const keyArb = fc.stringMatching(/^[A-Za-z0-9_-]{24,40}$/).map((s) => `FAKEKEY-${s}`);

const queryArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 60 }),
  fc.constantFrom("museums in Paris", "  spaced  ", "café ☕ 東京", '"quoted" & <tag>'),
);

const typesArb = fc.array(fc.oneof(fc.constantFrom("museum", "park", "restaurant"), fc.string({ maxLength: 12 })), {
  maxLength: 6,
});

const centreArb = fc.record({
  // JSON turns -0 into 0, so map -0 to 0 to keep the round-trip comparison exact.
  lat: fc.double({ min: -90, max: 90, noNaN: true }).map((n) => (Object.is(n, -0) ? 0 : n)),
  lng: fc.double({ min: -180, max: 180, noNaN: true }).map((n) => (Object.is(n, -0) ? 0 : n)),
});

const radiusArb = fc.oneof(
  fc.double({ noNaN: false }),
  fc.double({ min: -1000, max: 200000, noNaN: true }),
  fc.integer({ min: -5, max: 60000 }),
  fc.constantFrom(0, 1, 50000, 50001, NaN, Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE),
);

const maxResultsArb = fc.oneof(
  fc.constant(undefined),
  fc.double({ noNaN: false }),
  fc.integer({ min: -10, max: 100 }),
  fc.double({ min: -5, max: 50, noNaN: true }),
  fc.constantFrom(NaN, Infinity, -Infinity, 0, 1, 20, 21),
);

const okBodyArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant({}),
  fc.constant({ places: [] }),
  fc.constant({
    places: [{ id: "p1", displayName: { text: "A" }, location: { latitude: 1, longitude: 2 } }],
  }),
  fc.constantFrom(null, "text", 7, [], { places: "nope" }),
);

const failureBehaviourArb: fc.Arbitrary<Behaviour> = fc.oneof(
  // 429 is the rate-limited case, covered by its own generator, so it is excluded here.
  fc
    .integer({ min: 300, max: 599 })
    .filter((status) => status !== 429)
    .map((status): Behaviour => ({ kind: "status", status, body: {} })),
  fc.constantFrom(400, 403, 500, 503).map(
    (status): Behaviour => ({ kind: "status", status, body: { error: { status: "INVALID_ARGUMENT" } } }),
  ),
  fc.constantFrom<Behaviour>({ kind: "status", status: 500, body: null }, { kind: "status", status: 500, body: "x" }),
  fc.boolean().map((withKey): Behaviour => ({ kind: "throws", withKey })),
  fc.constant<Behaviour>({ kind: "json-rejects" }),
);

const anyBehaviourArb: fc.Arbitrary<Behaviour> = fc.oneof(
  okBodyArb.map((body): Behaviour => ({ kind: "ok", body })),
  failureBehaviourArb,
  fc.constant<Behaviour>({ kind: "status", status: 429, body: {} }),
  fc.constant<Behaviour>({ kind: "status", status: 400, body: { error: { status: "RESOURCE_EXHAUSTED" } } }),
);

type Call = (key: string, behaviour: Behaviour, extra: Extras) => Promise<{ seen: Seen[]; result: CandidateLookup }>;

interface Extras {
  query: string;
  centre: { lat: number; lng: number };
  radius: number;
  types: string[];
  maxResults: number | undefined;
  timeoutMs: number | undefined;
}

const callText: Call = async (key, behaviour, x) => {
  const { fetchImpl, seen } = makeFetch(key, behaviour);
  const result = await searchCandidatesText(x.query, fetchImpl, { maxResults: x.maxResults, timeoutMs: x.timeoutMs });
  return { seen, result };
};

const callNearby: Call = async (key, behaviour, x) => {
  const { fetchImpl, seen } = makeFetch(key, behaviour);
  const result = await searchCandidatesNearby(x.centre, x.radius, x.types, fetchImpl, {
    maxResults: x.maxResults,
    timeoutMs: x.timeoutMs,
  });
  return { seen, result };
};

const extrasArb: fc.Arbitrary<Extras> = fc.record({
  query: queryArb.filter((q) => q.trim().length > 0),
  centre: centreArb,
  radius: radiusArb,
  types: typesArb,
  maxResults: maxResultsArb,
  timeoutMs: fc.oneof(fc.constant(undefined), fc.integer({ min: -10, max: 100000 }), fc.constant(NaN)),
});

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.GOOGLE_PLACES_API_KEY;
});
afterEach(() => {
  vi.unstubAllEnvs();
  if (savedKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
  else process.env.GOOGLE_PLACES_API_KEY = savedKey;
});

describe("Property 3: Places request shape", () => {
  it("CANDIDATE_FIELD_MASK is exactly the 13 fields with no wildcard", () => {
    expect(CANDIDATE_FIELD_MASK.split(",")).toEqual(EXPECTED_FIELDS);
    expect(CANDIDATE_FIELD_MASK).not.toContain("*");
  });

  for (const [label, call] of [
    ["searchCandidatesText", callText],
    ["searchCandidatesNearby", callNearby],
  ] as const) {
    describe(label, () => {
      it("sends the exact mask, key only in the header, none in URL or body", async () => {
        await fc.assert(
          fc.asyncProperty(keyArb, extrasArb, okBodyArb, async (key, x, body) => {
            vi.stubEnv("GOOGLE_PLACES_API_KEY", key);
            const { seen } = await call(key, { kind: "ok", body }, x);
            expect(seen).toHaveLength(1);
            const { url, init } = seen[0];
            const headers = init?.headers ?? {};
            expect(init?.method).toBe("POST");
            expect(headers["X-Goog-FieldMask"]).toBe(CANDIDATE_FIELD_MASK);
            expect(headers["X-Goog-FieldMask"].split(",")).toEqual(EXPECTED_FIELDS);
            expect(headers["X-Goog-FieldMask"]).not.toContain("*");
            expect(headers["X-Goog-Api-Key"]).toBe(key);
            expect(url.includes(key)).toBe(false);
            expect(url.includes(encodeURIComponent(key))).toBe(false);
            expect(url.includes("?")).toBe(false);
            expect(url.startsWith("https://places.googleapis.com/v1/")).toBe(true);
            expect((init?.body ?? "").includes(key)).toBe(false);
            // Key appears in no other header value.
            for (const [name, value] of Object.entries(headers)) {
              if (name !== "X-Goog-Api-Key") expect(value.includes(key)).toBe(false);
            }
          }),
          { numRuns: NUM_RUNS },
        );
      });

      it("clamps maxResultCount to an integer in 1..20 (default 20)", async () => {
        await fc.assert(
          fc.asyncProperty(keyArb, extrasArb, async (key, x) => {
            vi.stubEnv("GOOGLE_PLACES_API_KEY", key);
            const { seen } = await call(key, { kind: "ok", body: {} }, x);
            const body = JSON.parse(seen[0].init?.body ?? "{}") as { maxResultCount: number };
            expect(Number.isInteger(body.maxResultCount)).toBe(true);
            expect(body.maxResultCount).toBeGreaterThanOrEqual(1);
            expect(body.maxResultCount).toBeLessThanOrEqual(20);
            const raw = x.maxResults;
            if (raw === undefined || Number.isNaN(raw)) {
              expect(body.maxResultCount).toBe(20);
            } else if (Number.isFinite(raw)) {
              expect(body.maxResultCount).toBe(Math.min(Math.max(Math.floor(raw), 1), 20));
            }
          }),
          { numRuns: NUM_RUNS },
        );
      });

      it("maps 429 and RESOURCE_EXHAUSTED to rate-limited, other failures to error", async () => {
        await fc.assert(
          fc.asyncProperty(
            keyArb,
            extrasArb,
            fc.oneof(
              fc.constant<Behaviour>({ kind: "status", status: 429, body: {} }),
              fc.constant<Behaviour>({ kind: "status", status: 429, body: null }),
              fc.constantFrom(400, 403, 500, 503).map(
                (status): Behaviour => ({ kind: "status", status, body: { error: { status: "RESOURCE_EXHAUSTED" } } }),
              ),
            ),
            async (key, x, behaviour) => {
              vi.stubEnv("GOOGLE_PLACES_API_KEY", key);
              const { result } = await call(key, behaviour, x);
              expect(result).toEqual({ kind: "failed", cause: "rate-limited" });
            },
          ),
          { numRuns: NUM_RUNS },
        );
        await fc.assert(
          fc.asyncProperty(keyArb, extrasArb, failureBehaviourArb, async (key, x, behaviour) => {
            vi.stubEnv("GOOGLE_PLACES_API_KEY", key);
            const { result } = await call(key, behaviour, x);
            expect(result).toEqual({ kind: "failed", cause: "error" });
          }),
          { numRuns: NUM_RUNS },
        );
      });

      it("never throws and no result contains the key, whatever the fetch does", async () => {
        await fc.assert(
          fc.asyncProperty(keyArb, extrasArb, anyBehaviourArb, async (key, x, behaviour) => {
            vi.stubEnv("GOOGLE_PLACES_API_KEY", key);
            let result: CandidateLookup | undefined;
            let threw: unknown;
            try {
              result = (await call(key, behaviour, x)).result;
            } catch (e) {
              threw = e;
            }
            expect(threw).toBeUndefined();
            expect(JSON.stringify(result)).not.toContain(key);
            if (result?.kind === "failed") {
              expect(Object.keys(result).sort()).toEqual(["cause", "kind"]);
              expect(["rate-limited", "error"]).toContain(result.cause);
            }
          }),
          { numRuns: NUM_RUNS },
        );
      });

      it("never throws on an aborted caller signal, a missing key or a missing fetch result", async () => {
        await fc.assert(
          fc.asyncProperty(keyArb, extrasArb, fc.boolean(), async (key, x, aborted) => {
            const ac = new AbortController();
            if (aborted) ac.abort();
            const { fetchImpl } = makeFetch(key, { kind: "ok", body: {} });
            vi.stubEnv("GOOGLE_PLACES_API_KEY", "");
            const noKey =
              label === "searchCandidatesText"
                ? await searchCandidatesText(x.query, fetchImpl, { signal: ac.signal })
                : await searchCandidatesNearby(x.centre, x.radius, x.types, fetchImpl, { signal: ac.signal });
            expect(noKey).toEqual({ kind: "failed", cause: "error" });
            vi.stubEnv("GOOGLE_PLACES_API_KEY", key);
            const r =
              label === "searchCandidatesText"
                ? await searchCandidatesText(x.query, fetchImpl, { signal: ac.signal })
                : await searchCandidatesNearby(x.centre, x.radius, x.types, fetchImpl, { signal: ac.signal });
            if (aborted) expect(r).toEqual({ kind: "failed", cause: "error" });
            expect(JSON.stringify(r)).not.toContain(key);
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  }

  describe("searchCandidatesText body", () => {
    it("sends the trimmed query as textQuery and no other location field", async () => {
      await fc.assert(
        fc.asyncProperty(keyArb, extrasArb, async (key, x) => {
          vi.stubEnv("GOOGLE_PLACES_API_KEY", key);
          const { seen } = await callText(key, { kind: "ok", body: {} }, x);
          expect(seen[0].url).toBe("https://places.googleapis.com/v1/places:searchText");
          const body = JSON.parse(seen[0].init?.body ?? "{}") as Record<string, unknown>;
          expect(body.textQuery).toBe(x.query.trim());
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it("makes no request for a blank query", async () => {
      await fc.assert(
        fc.asyncProperty(keyArb, fc.stringMatching(/^[ \t\n]{0,6}$/), async (key, q) => {
          vi.stubEnv("GOOGLE_PLACES_API_KEY", key);
          const { fetchImpl, seen } = makeFetch(key, { kind: "ok", body: {} });
          const r = await searchCandidatesText(q, fetchImpl);
          expect(seen).toHaveLength(0);
          expect(r).toEqual({ kind: "failed", cause: "error" });
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe("searchCandidatesNearby body", () => {
    it("clamps radius to 1..50000 and sends the centre, types and nearby URL", async () => {
      await fc.assert(
        fc.asyncProperty(keyArb, extrasArb, async (key, x) => {
          vi.stubEnv("GOOGLE_PLACES_API_KEY", key);
          const { seen } = await callNearby(key, { kind: "ok", body: {} }, x);
          expect(seen[0].url).toBe("https://places.googleapis.com/v1/places:searchNearby");
          const body = JSON.parse(seen[0].init?.body ?? "{}") as {
            includedTypes?: string[];
            locationRestriction: { circle: { center: { latitude: number; longitude: number }; radius: number } };
          };
          const circle = body.locationRestriction.circle;
          expect(circle.radius).toBeGreaterThanOrEqual(1);
          expect(circle.radius).toBeLessThanOrEqual(50000);
          if (Number.isFinite(x.radius)) {
            expect(circle.radius).toBe(Math.min(Math.max(x.radius, 1), 50000));
          } else if (x.radius === Infinity) {
            expect(circle.radius).toBe(50000);
          }
          expect(circle.center).toEqual({ latitude: x.centre.lat, longitude: x.centre.lng });
          const expectedTypes = x.types.filter((t) => t.length > 0);
          if (expectedTypes.length > 0) expect(body.includedTypes).toEqual(expectedTypes);
          else expect(body.includedTypes).toBeUndefined();
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });
});
