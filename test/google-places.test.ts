import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import {
  enrichPlace,
  fetchPlaceDetails,
  resolvePlaceId,
  type EnrichmentResult,
  type PlaceEnrichment,
} from "@/lib/providers/google-places";
import { googlePlacesApiKey } from "@/lib/config";
import {
  createEnrichmentCache,
  enrichmentCache,
  MAX_TTL_MS,
  type CachedEntry,
} from "@/lib/providers/enrichment-cache";
import { toReviewPayload, summarizeReviews } from "@/lib/reviews";
import { toAttributableReview, buildStayOffers, type InventoryQuery } from "@/lib/inventory-adapter";

/**
 * Feature: google-places-integration — correctness properties + example/integration tests.
 *
 * No test depends on a live GOOGLE_PLACES_API_KEY. Key-present paths set a
 * SENTINEL key in process.env (saved/restored) and inject a mock fetch — no real
 * network call is ever made. Key-absent paths exercise the no-request fallback.
 * Property tests use fast-check at >= 100 runs and carry the exact
 * `Feature: google-places-integration, Property N` tag.
 */

const SENTINEL_KEY = "SENTINEL-TEST-KEY-do-not-leak-xyz";

let savedKey: string | undefined;
function setKey(value: string | undefined): void {
  if (value === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
  else process.env.GOOGLE_PLACES_API_KEY = value;
}
beforeEach(() => {
  savedKey = process.env.GOOGLE_PLACES_API_KEY;
  // Isolate from the process-wide shared cache so one test never serves a
  // "cached" result into another test's expectations.
  enrichmentCache.clear();
});
afterEach(() => {
  setKey(savedKey);
  enrichmentCache.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A minimal injectable fetch returning a controllable json body + status. */
function jsonFetch(status: number, body: unknown) {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

/** A valid Place Details body for `fetchPlaceDetails` normalization. */
function detailsBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "places/ChIJ_test",
    rating: 4.3,
    userRatingCount: 128,
    priceLevel: "PRICE_LEVEL_MODERATE",
    photos: [{ name: "places/ChIJ_test/photos/AAA", authorAttributions: [{ displayName: "Jane" }] }],
    reviews: [
      { rating: 5, publishTime: "2024-01-01T00:00:00Z", authorAttribution: { displayName: "Al" }, text: { text: "Great" } },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unit — task 1.2: server-only key accessor
// ---------------------------------------------------------------------------
describe("google-places-integration: key accessor (task 1.2)", () => {
  it("returns the env value when GOOGLE_PLACES_API_KEY is set", () => {
    setKey(SENTINEL_KEY);
    expect(googlePlacesApiKey()).toBe(SENTINEL_KEY);
  });
  it("returns '' when GOOGLE_PLACES_API_KEY is absent or empty", () => {
    setKey(undefined);
    expect(googlePlacesApiKey()).toBe("");
    setKey("   ");
    expect(googlePlacesApiKey()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Unit — task 2.4: Field_Mask + key handling
// ---------------------------------------------------------------------------
describe("google-places-integration: Field_Mask and key handling (task 2.4)", () => {
  it("sends only the enumerated Field_Mask and the key as X-Goog-Api-Key", async () => {
    setKey(SENTINEL_KEY);
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const spyFetch = async (url: string, init?: { headers?: Record<string, string> }) => {
      seenUrl = url;
      seenHeaders = init?.headers ?? {};
      return { ok: true, status: 200, json: async () => detailsBody() };
    };
    await fetchPlaceDetails("places/ChIJ_test", spyFetch);
    expect(seenHeaders["X-Goog-FieldMask"]).toBe("id,rating,userRatingCount,priceLevel,photos,reviews");
    expect(seenHeaders["X-Goog-Api-Key"]).toBe(SENTINEL_KEY);
    expect(seenUrl.includes(SENTINEL_KEY)).toBe(false);
  });

  it("issues zero requests and returns null when the key is absent", async () => {
    setKey(undefined);
    let called = 0;
    const spyFetch = async () => {
      called += 1;
      return { ok: true, status: 200, json: async () => detailsBody() };
    };
    const out = await fetchPlaceDetails("places/ChIJ_test", spyFetch);
    expect(called).toBe(0);
    expect(out).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unit — task 2.5: <=5s timeout abort (fake timers, no real wait)
// ---------------------------------------------------------------------------
describe("google-places-integration: timeout abort (task 2.5)", () => {
  it("aborts at <=5s and yields a fallback without throwing", async () => {
    setKey(SENTINEL_KEY);
    vi.useFakeTimers();
    const hangingFetch = (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const resultPromise = enrichPlace({ placeId: "places/ChIJ_test" }, hangingFetch as never);
    await vi.advanceTimersByTimeAsync(5001);
    const result = await resultPromise;
    expect(result.mode).toBe("fallback");
    expect(result.data).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Property 1: Fallback is total, safe, and empty (Req 2.2, 2.3, 10.5)
// A genuinely failing fetch (throw/reject/non-2xx) or an absent key always
// degrades to a well-formed, empty fallback and never throws.
// ---------------------------------------------------------------------------
describe("Feature: google-places-integration, Property 1: Fallback is total, safe, and empty", () => {
  it("every failing outcome resolves to a well-formed empty fallback", async () => {
    let n = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.constantFrom<"throw" | "reject" | "non2xx" | "nokey">("throw", "reject", "non2xx", "nokey"),
        async (q, failureMode) => {
          // Unique placeId per run so no cross-run cache hit can occur, and a
          // fresh cache guarantees a failing fetch cannot be served from cache.
          enrichmentCache.clear();
          n += 1;
          if (failureMode === "nokey") setKey(undefined);
          else setKey(SENTINEL_KEY);
          const fetchImpl = (async () => {
            if (failureMode === "throw") throw new Error("boom");
            if (failureMode === "reject") return Promise.reject(new Error("net"));
            return { ok: false, status: 500, json: async () => ({}) }; // non-2xx
          }) as never;
          const r: EnrichmentResult = await enrichPlace({ placeId: "places/uniq-" + n, query: q }, fetchImpl);
          expect(r.mode).toBe("fallback");
          expect(r.data).toBeNull();
          expect(r.provider).toBe("Google");
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Result contract is well-formed (Req 2.4, 1.5)
// ---------------------------------------------------------------------------
describe("Feature: google-places-integration, Property 2: Result contract is well-formed", () => {
  it("mode is always valid, provider is Google, and data is null iff fallback", async () => {
    let n = 0;
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (succeed) => {
        enrichmentCache.clear();
        n += 1;
        setKey(SENTINEL_KEY);
        const body = detailsBody({ id: "places/ok-" + n });
        const fetchImpl = succeed ? (jsonFetch(200, body) as never) : (jsonFetch(500, {}) as never);
        const r = await enrichPlace({ placeId: "places/ok-" + n }, fetchImpl);
        expect(["live", "cached", "fallback"]).toContain(r.mode);
        expect(r.provider).toBe("Google");
        expect(r.data === null).toBe(r.mode === "fallback");
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: The API key never appears in any output (Req 1.4)
// ---------------------------------------------------------------------------
describe("Feature: google-places-integration, Property 3: The API key never appears in any output", () => {
  it("no returned value ever contains the sentinel key string", async () => {
    let n = 0;
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1 }), fc.boolean(), async (q, succeed) => {
        enrichmentCache.clear();
        n += 1;
        setKey(SENTINEL_KEY);
        const body = detailsBody({ id: "places/k-" + n });
        const fetchImpl = succeed ? (jsonFetch(200, body) as never) : (jsonFetch(500, {}) as never);
        const r = await enrichPlace({ placeId: "places/k-" + n, query: q }, fetchImpl);
        expect(JSON.stringify(r).includes(SENTINEL_KEY)).toBe(false);
        const resolved = await resolvePlaceId(q, jsonFetch(200, { places: [{ id: "places/x" }] }) as never);
        expect(JSON.stringify(resolved ?? "").includes(SENTINEL_KEY)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4: No attributable review yields the no-verified-reviews state
// ---------------------------------------------------------------------------
describe("Feature: google-places-integration, Property 4: No attributable review yields the no-verified-reviews state", () => {
  it("an enrichment with no reviews summarizes to the no-verified-reviews state", () => {
    fc.assert(
      fc.property(
        fc.option(fc.double({ min: 0, max: 5, noNaN: true }), { nil: null }),
        fc.option(fc.integer({ min: 0, max: 100000 }), { nil: null }),
        (rating, count) => {
          const e: PlaceEnrichment = {
            placeId: "places/x", rating, userRatingCount: count,
            reviews: [], photos: [], priceLevel: null, provider: "Google",
          };
          const summary = summarizeReviews(toReviewPayload(e));
          expect(summary.hasReviews).toBe(false);
          expect(summary.verified).toBe(false);
          expect(summary.items).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5: At most five individual reviews are rendered (Req 3.7)
// ---------------------------------------------------------------------------
describe("Feature: google-places-integration, Property 5: At most five individual reviews are rendered", () => {
  it("fetchPlaceDetails caps mapped reviews at 5 for any upstream count", async () => {
    setKey(SENTINEL_KEY);
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 40 }), async (count) => {
        const reviews = Array.from({ length: count }, (_v, i) => ({
          rating: 4,
          publishTime: "2024-01-0" + ((i % 9) + 1) + "T00:00:00Z",
          authorAttribution: { displayName: "A" + i },
          text: { text: "review " + i },
        }));
        const data = await fetchPlaceDetails("places/x", jsonFetch(200, detailsBody({ reviews })) as never);
        expect(data).not.toBeNull();
        expect(data!.reviews.length).toBeLessThanOrEqual(5);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: Stays attribution gate (Req 6.2, 6.3, 6.4, 6.5)
// ---------------------------------------------------------------------------
describe("Feature: google-places-integration, Property 6: Stays attribution gate", () => {
  it("toAttributableReview yields Google attribution iff rating, count, and a review are all present", () => {
    fc.assert(
      fc.property(
        fc.option(fc.double({ min: 0, max: 5, noNaN: true }), { nil: null }),
        fc.option(fc.integer({ min: 0, max: 50000 }), { nil: null }),
        fc.nat({ max: 8 }),
        (rating, count, reviewCount) => {
          const e: PlaceEnrichment = {
            placeId: "places/x", rating, userRatingCount: count,
            reviews: Array.from({ length: reviewCount }, (_v, i) => ({ author: "A" + i, rating: 4, text: "t", publishedAt: "" })),
            photos: [], priceLevel: null, provider: "Google",
          };
          const out = toAttributableReview(e);
          const shouldAttribute = rating !== null && !!count && count > 0 && reviewCount > 0;
          if (shouldAttribute) {
            expect(out).toBeDefined();
            expect(out!.source).toBe("Google");
            expect("amount" in (out as object)).toBe(false);
          } else {
            expect(out).toBeUndefined();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7: Google data never affects stay pricing (Req 6.7)
// ---------------------------------------------------------------------------
describe("Feature: google-places-integration, Property 7: Google data never affects stay pricing", () => {
  it("attaching a Google review to a stay query never changes any price", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("Dubai", "Goa", "Paris", "Tokyo", "Bali"),
        fc.constantFrom("Budget", "Comfort", "Luxury"),
        fc.integer({ min: 1, max: 14 }),
        fc.double({ min: 0, max: 5, noNaN: true }),
        fc.integer({ min: 1, max: 50000 }),
        (destination, stayStyle, nights, rating, count) => {
          const base: InventoryQuery = { origin: "BOM", destination, cabin: "Economy", stayStyle, nights };
          const withReview: InventoryQuery = { ...base, review: { rating, count, source: "Google" } };
          const now = new Date("2026-01-01T00:00:00Z");
          const a = buildStayOffers(base, 6, now);
          const b = buildStayOffers(withReview, 6, now);
          expect(b.length).toBe(a.length);
          for (let i = 0; i < a.length; i += 1) {
            expect(b[i].pricePerNight).toBe(a[i].pricePerNight);
          }
          expect(b[0].meta.reviewSummary?.source).toBe("Google");
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 8: Cache excludes reviews and honours retention (Req 8.1, 8.3, 8.5)
// ---------------------------------------------------------------------------
describe("Feature: google-places-integration, Property 8: Cache excludes reviews and honours retention", () => {
  it("stored entries carry no review fields and expire exactly at the TTL boundary", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 29 }),
        fc.integer({ min: 0, max: 60 }),
        (ttlDays, ageDays) => {
          let clock = 1_000_000_000_000;
          const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
          const cache = createEnrichmentCache({ now: () => clock, ttlMs });
          expect(cache.ttlMs).toBeLessThanOrEqual(MAX_TTL_MS);
          const entry: CachedEntry = {
            placeId: "places/x", rating: 4.5, userRatingCount: 10, priceLevel: 2,
            photos: [{ name: "places/x/photos/AAA" }], storedAt: clock,
          };
          cache.setDetails(entry);
          const stored = cache.getDetails("places/x");
          expect(stored).not.toBeNull();
          expect(Object.keys(stored as object)).not.toContain("reviews");
          clock += ageDays * 24 * 60 * 60 * 1000;
          const probed = cache.getDetails("places/x");
          const ageMs = ageDays * 24 * 60 * 60 * 1000;
          if (ageMs <= ttlMs) expect(probed).not.toBeNull();
          else expect(probed).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("the effective TTL is hard-capped at 30 days regardless of override", () => {
    const cache = createEnrichmentCache({ ttlMs: 999 * 24 * 60 * 60 * 1000 });
    expect(cache.ttlMs).toBe(MAX_TTL_MS);
  });
});

// ---------------------------------------------------------------------------
// Example/integration — task 5.2: photo proxy route
// ---------------------------------------------------------------------------
describe("google-places-integration: photo proxy route (task 5.2)", () => {
  async function loadRoute() {
    return await import("@/app/api/place-photo/route");
  }
  function req(url: string) {
    return { nextUrl: new URL(url) } as unknown as import("next/server").NextRequest;
  }

  it("returns 404 when the ref is missing", async () => {
    setKey(SENTINEL_KEY);
    const { GET } = await loadRoute();
    const res = await GET(req("http://localhost/api/place-photo"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when the key is absent", async () => {
    setKey(undefined);
    const { GET } = await loadRoute();
    const res = await GET(req("http://localhost/api/place-photo?ref=places/x/photos/AAA"));
    expect(res.status).toBe(404);
  });

  it("returns 404 for a malformed ref shape (SSRF guard)", async () => {
    setKey(SENTINEL_KEY);
    const { GET } = await loadRoute();
    const res = await GET(req("http://localhost/api/place-photo?ref=" + encodeURIComponent("https://evil.example/x")));
    expect(res.status).toBe(404);
  });

  it("streams bytes with the upstream content-type and never leaks the key", async () => {
    setKey(SENTINEL_KEY);
    let fetchedUrl = "";
    let fetchedHeaders: Record<string, string> = {};
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: { headers?: Record<string, string> }) => {
      fetchedUrl = String(url);
      fetchedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
    }) as never);
    const { GET } = await loadRoute();
    const res = await GET(req("http://localhost/api/place-photo?ref=places/x/photos/AAA&w=400"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(fetchedHeaders["X-Goog-Api-Key"]).toBe(SENTINEL_KEY);
    expect(fetchedUrl.includes(SENTINEL_KEY)).toBe(false);
    const body = await res.text();
    expect(body.includes(SENTINEL_KEY)).toBe(false);
    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Example/integration — task 6.2: place-details route google block
// This route also calls the real live-data adapters (no key needed); with no
// network they self-bound at <=5s each, so give the test a 20s budget.
// ---------------------------------------------------------------------------
describe("google-places-integration: place-details route (task 6.2)", () => {
  async function loadRoute() {
    return await import("@/app/api/place-details/route");
  }
  function req(url: string) {
    return { nextUrl: new URL(url) } as unknown as import("next/server").NextRequest;
  }

  it("includes a nullable google field; a fallback omits it but keeps the other signals", async () => {
    setKey(undefined); // no key -> Google enrichment is a fallback, google block is null
    const { GET } = await loadRoute();
    const res = await GET(req("http://localhost/api/place-details?name=Eiffel%20Tower"));
    const json = await res.json();
    expect("google" in json).toBe(true);
    expect(json.google).toBeNull();
    expect("destination" in json).toBe(true);
    expect("weather" in json).toBe(true);
    expect(JSON.stringify(json).includes(SENTINEL_KEY)).toBe(false);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  }, 20000);

  it("rejects an empty name with 400", async () => {
    setKey(undefined);
    const { GET } = await loadRoute();
    const res = await GET(req("http://localhost/api/place-details?name="));
    expect(res.status).toBe(400);
  });
});
