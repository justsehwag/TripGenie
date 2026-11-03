import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { FetchLike } from "@/lib/live-data";
import {
  clearHotelRateCache,
  fetchHotelOffers,
  normalizeHotel,
  safeHttpsUrl,
  searchHotelRates,
  validateHotelQuery,
  type HotelRateQuery,
} from "@/lib/providers/serpapi-hotels";

const KEY = "test-serpapi-secret-key-123";
const NOW = new Date("2026-06-01T08:00:00Z");
const QUERY: HotelRateQuery = { destination: "Goa", checkIn: "2026-07-10", checkOut: "2026-07-13", adults: 2 };

function mockFetch(payload: unknown, ok = true, status = 200) {
  const calls: string[] = [];
  const impl: FetchLike = async (url) => {
    calls.push(url);
    return { ok, status, json: async () => payload };
  };
  return { impl, calls };
}

const SEARCH_FIXTURE = {
  properties: [
    {
      type: "hotel",
      name: "Sea Breeze Resort",
      description: "Beachfront rooms with a pool.",
      link: "https://seabreeze.example.com/",
      property_token: "TOKEN_SEA_1",
      images: [{ thumbnail: "https://lh3.googleusercontent.com/sea.jpg" }],
      extracted_hotel_class: 4,
      overall_rating: 4.5,
      reviews: 1820,
      rate_per_night: { extracted_lowest: 6200, extracted_before_taxes_fees: 5400, extracted_after_taxes_fees: 6200 },
      total_rate: { extracted_lowest: 18600, extracted_after_taxes_fees: 18600 },
      amenities: ["Pool", "Free Wi-Fi", "Spa"],
    },
    {
      // No price reported -> must be skipped, never estimated.
      type: "hotel",
      name: "No Price Inn",
      property_token: "TOKEN_NOPRICE",
    },
    {
      type: "hotel",
      name: "Unsafe Links Lodge",
      link: "javascript:alert(1)",
      property_token: "TOKEN_UNSAFE",
      images: [{ thumbnail: "http://insecure.example.com/x.jpg" }],
      rate_per_night: { extracted_lowest: 3100 },
    },
  ],
};

beforeEach(() => {
  process.env.SERPAPI_API_KEY = KEY;
  clearHotelRateCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.SERPAPI_API_KEY;
  vi.restoreAllMocks();
});

describe("serpapi-hotels: configuration and validation", () => {
  it("makes no request and reports unconfigured when the key is missing", async () => {
    delete process.env.SERPAPI_API_KEY;
    const { impl, calls } = mockFetch(SEARCH_FIXTURE);
    const r = await searchHotelRates(QUERY, { fetchImpl: impl, now: NOW });
    expect(r.status).toBe("unconfigured");
    expect(r.hotels).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it.each([
    [{ ...QUERY, checkIn: "2026-05-01" }, "past"],
    [{ ...QUERY, checkOut: "2026-07-10" }, "after"],
    [{ ...QUERY, checkIn: "10/07/2026" }, "valid dates"],
    [{ ...QUERY, adults: 0 }, "Guests"],
    [{ ...QUERY, destination: "" }, "destination"],
  ])("rejects an invalid query without calling the provider (%#)", async (q, fragment) => {
    const { impl, calls } = mockFetch(SEARCH_FIXTURE);
    const r = await searchHotelRates(q as HotelRateQuery, { fetchImpl: impl, now: NOW });
    expect(r.status).toBe("invalid");
    expect(r.error).toContain(fragment);
    expect(calls).toHaveLength(0);
  });

  it("accepts a valid future stay", () => {
    expect(validateHotelQuery(QUERY, NOW)).toBeNull();
  });
});

describe("serpapi-hotels: live search", () => {
  it("returns only hotels with real reported prices, using the after-tax rate", async () => {
    const { impl, calls } = mockFetch(SEARCH_FIXTURE);
    const r = await searchHotelRates(QUERY, { fetchImpl: impl, now: NOW });
    expect(r.status).toBe("live");
    expect(r.currency).toBe("INR");
    // Completion time = now + measured wall ms, so checkedAt is a valid ISO instant at/after NOW
    // and within a few seconds of it (not exactly NOW).
    const checkedAtMs = Date.parse(r.checkedAt);
    expect(Number.isNaN(checkedAtMs)).toBe(false);
    expect(checkedAtMs).toBeGreaterThanOrEqual(NOW.getTime());
    expect(checkedAtMs).toBeLessThan(NOW.getTime() + 5_000);
    expect(r.hotels.map((h) => h.name)).toEqual(["Sea Breeze Resort", "Unsafe Links Lodge"]);

    const sea = r.hotels[0];
    expect(sea.ratePerNight).toBe(6200);
    expect(sea.ratePerNightBeforeTaxes).toBe(5400);
    expect(sea.totalRate).toBe(18600);
    expect(sea.hotelClass).toBe(4);
    expect(sea.rating).toBe(4.5);
    expect(sea.website).toBe("https://seabreeze.example.com/");

    // Non-https links/images are dropped, never passed to the browser.
    const unsafe = r.hotels[1];
    expect(unsafe.website).toBeNull();
    expect(unsafe.thumbnail).toBeNull();

    // Request carries the exact dates, guests and currency.
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]);
    expect(url.origin + url.pathname).toBe("https://serpapi.com/search.json");
    expect(url.searchParams.get("engine")).toBe("google_hotels");
    expect(url.searchParams.get("check_in_date")).toBe("2026-07-10");
    expect(url.searchParams.get("check_out_date")).toBe("2026-07-13");
    expect(url.searchParams.get("adults")).toBe("2");
    expect(url.searchParams.get("currency")).toBe("INR");
  });

  it("never exposes the API key in the returned result", async () => {
    const { impl } = mockFetch(SEARCH_FIXTURE);
    const r = await searchHotelRates(QUERY, { fetchImpl: impl, now: NOW });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("never sends a hotel_class filter (star-class is filtered locally)", async () => {
    const { impl, calls } = mockFetch(SEARCH_FIXTURE);
    await searchHotelRates(QUERY, { fetchImpl: impl, now: NOW });
    expect(new URL(calls[0]).searchParams.has("hotel_class")).toBe(false);
  });

  it.each([
    ["error payload", mockFetch({ error: "Invalid API key." })],
    ["HTTP 500", mockFetch({}, false, 500)],
  ])("reports unavailable without throwing on %s", async (_label, mock) => {
    const r = await searchHotelRates(QUERY, { fetchImpl: mock.impl, now: NOW });
    expect(r.status).toBe("unavailable");
    expect(r.hotels).toEqual([]);
    expect(r.error).not.toContain(KEY);
  });

  it("reports unavailable without throwing when the network fails", async () => {
    const impl: FetchLike = async () => {
      throw new Error(`boom ${KEY}`);
    };
    const r = await searchHotelRates(QUERY, { fetchImpl: impl, now: NOW });
    expect(r.status).toBe("unavailable");
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("reuses a successful lookup within the 45-minute TTL and refetches after it", async () => {
    const { impl, calls } = mockFetch(SEARCH_FIXTURE);
    const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

    // Initial live lookup spends one request.
    await searchHotelRates(QUERY, { fetchImpl: impl, now: NOW });
    expect(calls).toHaveLength(1);

    // Still inside the 45-minute window: served from cache, no new request.
    await searchHotelRates(QUERY, { fetchImpl: impl, now: at(44) });
    expect(calls).toHaveLength(1);

    // Past the 45-minute window: the cached entry has expired, so we refetch.
    await searchHotelRates(QUERY, { fetchImpl: impl, now: at(46) });
    expect(calls).toHaveLength(2);
  });
});

describe("serpapi-hotels: booking offers", () => {
  const OFFERS_FIXTURE = {
    name: "Sea Breeze Resort",
    featured_prices: [
      {
        source: "Sea Breeze Resort",
        official: true,
        link: "https://www.google.com/aclk?sa=l&ai=official",
        logo: "https://www.gstatic.com/logo-official.png",
        rate_per_night: { extracted_after_taxes_fees: 6400 },
        total_rate: { extracted_after_taxes_fees: 19200 },
      },
    ],
    prices: [
      {
        source: "Booking.com",
        link: "https://www.google.com/aclk?sa=l&ai=booking",
        rate_per_night: { extracted_lowest: 6100 },
        total_rate: { extracted_lowest: 18300 },
        free_cancellation: true,
      },
      { source: "Booking.com", link: "https://dup.example.com/", rate_per_night: { extracted_lowest: 9999 } },
      { source: "Shady OTA", link: "http://insecure.example.com/", rate_per_night: { extracted_lowest: 100 } },
    ],
  };

  it("returns one offer per site, https links only, cheapest first", async () => {
    const { impl, calls } = mockFetch(OFFERS_FIXTURE);
    const r = await fetchHotelOffers({ ...QUERY, token: "TOKEN_SEA_1" }, { fetchImpl: impl, now: NOW });
    expect(r.status).toBe("live");
    expect(r.hotelName).toBe("Sea Breeze Resort");
    expect(r.offers.map((o) => o.source)).toEqual(["Booking.com", "Sea Breeze Resort"]);
    expect(r.offers[0]).toMatchObject({ ratePerNight: 6100, totalRate: 18300, freeCancellation: true, official: false });
    expect(r.offers[1]).toMatchObject({ ratePerNight: 6400, official: true });
    expect(r.offers.every((o) => o.link.startsWith("https://"))).toBe(true);
    expect(new URL(calls[0]).searchParams.get("property_token")).toBe("TOKEN_SEA_1");
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("rejects a malformed property token without calling the provider", async () => {
    const { impl, calls } = mockFetch(OFFERS_FIXTURE);
    const r = await fetchHotelOffers({ ...QUERY, token: "bad token/../x" }, { fetchImpl: impl, now: NOW });
    expect(r.status).toBe("invalid");
    expect(calls).toHaveLength(0);
  });
});

describe("serpapi-hotels: properties", () => {
  it("safeHttpsUrl only ever returns https URLs", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.webUrl(), fc.constant("javascript:alert(1)")), (s) => {
        const out = safeHttpsUrl(s);
        expect(out === null || out.startsWith("https://")).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("normalizeHotel never yields a hotel without a real positive price", () => {
    fc.assert(
      fc.property(
        fc.record({
          name: fc.oneof(fc.string(), fc.constant(undefined)),
          property_token: fc.oneof(fc.stringMatching(/^[A-Za-z0-9_-]{4,20}$/), fc.string()),
          rate_per_night: fc.oneof(
            fc.constant(undefined),
            fc.record({ extracted_lowest: fc.oneof(fc.double(), fc.integer(), fc.constant(null)) }),
          ),
        }),
        (raw) => {
          const h = normalizeHotel(raw);
          if (h !== null) {
            expect(Number.isFinite(h.ratePerNight)).toBe(true);
            expect(h.ratePerNight).toBeGreaterThan(0);
            expect(h.name.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});