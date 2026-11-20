import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDestinationImageCache,
  resolveDestinationImage,
  DESTINATION_CACHE_TTL_MS,
  NO_IMAGE_CACHE_TTL_MS,
  type DestinationImageCache,
  type DestinationImageDeps,
} from "@/lib/destination-image";
import { resetWikiImageBackoff, wikiBackoffUntil } from "@/lib/wiki-image";
import { classifyImage } from "@/lib/wiki-image-policy";

const FIX = path.join(__dirname, "fixtures");
const fixture = (rel: string): unknown => JSON.parse(readFileSync(path.join(FIX, rel), "utf8"));

const PLACES = fixture("places/top-attractions-paris.searchtext.json");
const PLACES_EMPTY = fixture("places/top-attractions-empty.searchtext.json");
const TOURISM: Record<string, unknown> = {
  fixtureland: fixture("wikipedia/tourism-in-fixtureland.pageimages.json"),
  flagland: fixture("wikipedia/tourism-in-flagland.pageimages.json"),
  missingland: fixture("wikipedia/tourism-in-missingland.pageimages.json"),
};
const FLAG_IMAGES = fixture("wikipedia/flagland.images.json");
const FLAG_IMAGEINFO = fixture("wikipedia/flagland.imageinfo.json");
const EMPTY_IMAGES = { batchcomplete: true, query: { pages: [{ ns: 0, title: "Missingland" }] } };

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

interface Harness {
  fetchImpl: typeof fetch;
  calls: { url: string; init?: RequestInit }[];
  places: () => number;
  wiki: () => number;
  clock: { t: number };
  deps: (over?: DestinationImageDeps) => DestinationImageDeps;
}

/** Default router serving the fixtures; `override` may answer first. */
function harness(override?: Handler): Harness {
  const calls: { url: string; init?: RequestInit }[] = [];
  const clock = { t: 1_000_000 };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const o = override?.(url, init);
    if (o) return o;
    if (url.startsWith("https://places.googleapis.com/")) return json(PLACES);
    const u = new URL(url);
    const titles = decodeURIComponent(u.searchParams.get("titles") ?? "");
    const prop = u.searchParams.get("prop");
    if (prop === "pageimages") {
      const m = /^Tourism in (.+)$/.exec(titles);
      const hit = m ? TOURISM[m[1].toLowerCase()] : undefined;
      return json(hit ?? { query: { pages: [{ ns: 0, title: titles, missing: true }] } });
    }
    if (prop === "images") return json(titles === "Flagland" ? FLAG_IMAGES : EMPTY_IMAGES);
    if (prop === "imageinfo") return json(FLAG_IMAGEINFO);
    return json({}, 404);
  }) as typeof fetch;
  return {
    fetchImpl,
    calls,
    clock,
    places: () => calls.filter((c) => c.url.startsWith("https://places.googleapis.com/")).length,
    wiki: () => calls.filter((c) => c.url.startsWith("https://en.wikipedia.org/")).length,
    deps: (over = {}) => ({
      fetchImpl,
      now: () => clock.t,
      contact: "test@example.com",
      placesKey: () => "test-key",
      cache: createDestinationImageCache(),
      ...over,
    }),
  };
}

function expectNoFlagOrSvg(r: { url: string | null; srcset?: string }): void {
  for (const s of [r.url, r.srcset]) {
    if (!s) continue;
    expect(s.toLowerCase()).not.toContain(".svg");
    // "Flagland" is the destination name, so match emblem file names, not the bare word.
    expect(s.toLowerCase()).not.toMatch(/flag_of|coat_of_arms|coat%20of|location_map/);
    for (const u of s.split(/,\s*/).map((p) => p.replace(/\s+[12]x$/, ""))) {
      expect(classifyImage({ url: u })).toBe("accept");
    }
  }
}

beforeEach(() => resetWikiImageBackoff());
afterEach(() => {
  vi.useRealTimers();
  resetWikiImageBackoff();
});

describe("resolveDestinationImage source order", () => {
  it("uses Google Places first and makes no Wikimedia request", async () => {
    const h = harness();
    const r = await resolveDestinationImage("Paris", "card", 0, h.deps());
    expect(r).toMatchObject({ source: "places" });
    expect(r.url).toBe("/api/place-photo?ref=places%2FChIJFixtureTower00002%2Fphotos%2FAeFixturePhotoTowerA&w=500");
    expect((r as { srcset?: string }).srcset).toContain(" 1x, ");
    expect((r as { srcset?: string }).srcset).toContain("&w=960 2x");
    expect(h.places()).toBe(1);
    expect(h.wiki()).toBe(0);
  });

  it("sends the Places request as one POST with the documented field mask and key", async () => {
    const h = harness();
    await resolveDestinationImage("Paris", "card", 0, h.deps());
    const init = h.calls[0].init!;
    expect(init.method).toBe("POST");
    const hdr = init.headers as Record<string, string>;
    expect(hdr["X-Goog-FieldMask"]).toBe("places.id,places.displayName,places.primaryType,places.photos");
    expect(hdr["X-Goog-Api-Key"]).toBe("test-key");
    expect(JSON.parse(String(init.body)).textQuery).toContain("Paris");
  });

  it("slot selects among places that have a photo", async () => {
    const h = harness();
    const r = await resolveDestinationImage("Paris", "card", 1, h.deps());
    expect(r.url).toContain("AeFixturePhotoMuseumA");
  });

  it("skips Places without a key and uses the Tourism in page", async () => {
    const h = harness();
    const r = await resolveDestinationImage("Fixtureland", "card", 0, h.deps({ placesKey: () => "" }));
    expect(h.places()).toBe(0);
    expect(r).toMatchObject({ source: "tourism-page" });
    expect(r.url).toBe(
      "https://upload.wikimedia.org/wikipedia/commons/thumb/8/85/Fixtureland_Old_Harbour.jpg/500px-Fixtureland_Old_Harbour.jpg",
    );
    expect((r as { srcset?: string }).srcset).toContain("960px-Fixtureland_Old_Harbour.jpg 2x");
    expect(h.wiki()).toBe(1);
  });

  it("skips Places when reading the key throws", async () => {
    const h = harness();
    const r = await resolveDestinationImage(
      "Fixtureland",
      "card",
      0,
      h.deps({
        placesKey: () => {
          throw new Error("no key");
        },
      }),
    );
    expect(h.places()).toBe(0);
    expect(r).toMatchObject({ source: "tourism-page" });
  });

  it.each([
    ["a 500 response", () => json({ error: "x" }, 500)],
    ["a body without places", () => json(PLACES_EMPTY)],
    ["a network error", () => Promise.reject(new Error("boom"))],
    ["invalid JSON", () => new Response("not json", { status: 200 })],
  ])("falls back to the Tourism in page after Places returns %s", async (_n, answer) => {
    const h = harness((url) => (url.startsWith("https://places.googleapis.com/") ? (answer() as Response) : undefined));
    const r = await resolveDestinationImage("Fixtureland", "card", 0, h.deps());
    expect(h.places()).toBe(1);
    expect(r).toMatchObject({ source: "tourism-page" });
  });

  it("falls back to destination page images when the Tourism in page has no usable image", async () => {
    const h = harness();
    const r = await resolveDestinationImage("Flagland", "card", 0, h.deps({ placesKey: () => "" }));
    expect(r).toMatchObject({ source: "destination-page" });
    expect(h.wiki()).toBe(3);
  });
});

describe("resolveDestinationImage image filtering", () => {
  it("skips a flag lead image on the Tourism page and never returns a flag or SVG", async () => {
    const h = harness();
    const r = await resolveDestinationImage("Flagland", "card", 0, h.deps({ placesKey: () => "" }));
    expect(r.url).not.toBeNull();
    expect(r.url).not.toContain("Flag_of_Flagland");
    expectNoFlagOrSvg(r as { url: string; srcset?: string });
  });

  it("filters coat of arms, map and portrait images from the page images", async () => {
    const h = harness();
    const seen = new Set<string>();
    for (const slot of [0, 1, 2, 3]) {
      const r = await resolveDestinationImage("Flagland", "card", slot, h.deps({ placesKey: () => "" }));
      expect(r.url).not.toBeNull();
      seen.add(r.url!);
      expect(r.url).not.toMatch(/Coat_of_arms|location_map|portrait|Flag_of/i);
      expectNoFlagOrSvg(r as { url: string; srcset?: string });
    }
    // Only the two landscape, non-emblem photos remain.
    expect([...seen].sort()).toEqual([
      "https://upload.wikimedia.org/wikipedia/commons/thumb/d/d4/Flagland_Cliffs_at_dawn.jpg/500px-Flagland_Cliffs_at_dawn.jpg",
      "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e5/Flagland_Market_square.jpg/500px-Flagland_Market_square.jpg",
    ]);
  });

  it("does not ask imageinfo for SVG, coat of arms or map files", async () => {
    const h = harness();
    await resolveDestinationImage("Flagland", "card", 0, h.deps({ placesKey: () => "" }));
    const info = h.calls.map((c) => decodeURIComponent(c.url)).find((u) => u.includes("prop=imageinfo"))!;
    expect(info).toContain("Flagland Cliffs at dawn.jpg");
    expect(info).not.toMatch(/Flag of Flagland|Coat of arms|location map/);
  });

  it("returns no-representative-image when nothing usable exists", async () => {
    const h = harness();
    const r = await resolveDestinationImage("Missingland", "card", 0, h.deps({ placesKey: () => "" }));
    expect(r).toEqual({ url: null, reason: "no-representative-image" });
  });

  it("returns no-page for an empty query without any request", async () => {
    const h = harness();
    const r = await resolveDestinationImage("   ", "card", 0, h.deps());
    expect(r).toEqual({ url: null, reason: "no-page" });
    expect(h.calls).toHaveLength(0);
  });

  it("only returns allowed hosts or the place-photo proxy", async () => {
    const h = harness();
    for (const [q, key] of [["Paris", "k"], ["Fixtureland", ""], ["Flagland", ""]] as const) {
      const r = await resolveDestinationImage(q, "hero", 0, h.deps({ placesKey: () => key }));
      expect(r.url).toMatch(/^(\/api\/place-photo\?ref=|https:\/\/upload\.wikimedia\.org\/)/);
    }
  });
});

describe("resolveDestinationImage request caps", () => {
  it("makes at most 1 Places and 3 Wikimedia requests on the longest path", async () => {
    const h = harness((url) => (url.startsWith("https://places.googleapis.com/") ? json({}, 500) : undefined));
    const r = await resolveDestinationImage("Flagland", "card", 0, h.deps());
    expect(r).toMatchObject({ source: "destination-page" });
    expect(h.places()).toBe(1);
    expect(h.wiki()).toBe(3);
  });

  it("sends the Wikimedia User-Agent on every Wikimedia request", async () => {
    const h = harness();
    await resolveDestinationImage("Flagland", "card", 0, h.deps({ placesKey: () => "" }));
    const wiki = h.calls.filter((c) => c.url.startsWith("https://en.wikipedia.org/"));
    expect(wiki).toHaveLength(3);
    for (const c of wiki) {
      expect((c.init!.headers as Record<string, string>)["User-Agent"]).toBe("TripGenie/1.0 (test@example.com)");
    }
  });

  it("uses 2 Wikimedia requests when the page has no images", async () => {
    const h = harness();
    await resolveDestinationImage("Missingland", "card", 0, h.deps({ placesKey: () => "" }));
    expect(h.places()).toBe(0);
    expect(h.wiki()).toBe(2);
  });
});

describe("resolveDestinationImage cache", () => {
  it("serves a second call from the cache with no request", async () => {
    const h = harness();
    const deps = h.deps();
    const a = await resolveDestinationImage("Paris", "card", 0, deps);
    const n = h.calls.length;
    h.clock.t += DESTINATION_CACHE_TTL_MS - 1;
    const b = await resolveDestinationImage("Paris", "card", 0, deps);
    expect(b).toEqual(a);
    expect(h.calls.length).toBe(n);
  });

  it("keys by destination, size and slot, ignoring query case and spacing", async () => {
    const h = harness();
    const deps = h.deps();
    await resolveDestinationImage("Paris", "card", 0, deps);
    const n = h.calls.length;
    await resolveDestinationImage("  paris ", "card", 0, deps);
    expect(h.calls.length).toBe(n);
    await resolveDestinationImage("Paris", "hero", 0, deps);
    expect(h.calls.length).toBe(n + 1);
    await resolveDestinationImage("Paris", "card", 1, deps);
    expect(h.calls.length).toBe(n + 2);
  });

  it("refetches after 24 h", async () => {
    const h = harness();
    const deps = h.deps();
    await resolveDestinationImage("Paris", "card", 0, deps);
    h.clock.t += DESTINATION_CACHE_TTL_MS;
    await resolveDestinationImage("Paris", "card", 0, deps);
    expect(h.places()).toBe(2);
  });

  it("caches no-representative-image for 1 h only", async () => {
    const h = harness();
    const deps = h.deps({ placesKey: () => "" });
    await resolveDestinationImage("Missingland", "card", 0, deps);
    const n = h.calls.length;
    h.clock.t += NO_IMAGE_CACHE_TTL_MS - 1;
    expect(await resolveDestinationImage("Missingland", "card", 0, deps)).toEqual({
      url: null,
      reason: "no-representative-image",
    });
    expect(h.calls.length).toBe(n);
    h.clock.t += 1;
    await resolveDestinationImage("Missingland", "card", 0, deps);
    expect(h.calls.length).toBe(n * 2);
  });

  it("bounds the cache and evicts the oldest entry", () => {
    const c: DestinationImageCache = createDestinationImageCache(2);
    const v = { url: null, reason: "no-page" } as const;
    c.set("a", v, 1000, 0);
    c.set("b", v, 1000, 0);
    c.set("c", v, 1000, 0);
    expect(c.size).toBe(2);
    expect(c.get("a", 0)).toBeUndefined();
    expect(c.get("c", 0)).toEqual(v);
    expect(c.get("c", 1000)).toBeUndefined();
  });

  it("does not cache transient failures", async () => {
    let fail = true;
    const h = harness((url) =>
      fail && url.startsWith("https://en.wikipedia.org/") ? json({}, 500) : undefined,
    );
    const deps = h.deps({ placesKey: () => "" });
    const a = await resolveDestinationImage("Fixtureland", "card", 0, deps);
    expect(a).toEqual({ url: null, reason: "upstream-error" });
    fail = false;
    const b = await resolveDestinationImage("Fixtureland", "card", 0, deps);
    expect(b).toMatchObject({ source: "tourism-page" });
  });

  it("does not cache a network error", async () => {
    let fail = true;
    const h = harness((url) =>
      fail && url.startsWith("https://en.wikipedia.org/") ? Promise.reject(new Error("down")) : undefined,
    );
    const deps = h.deps({ placesKey: () => "" });
    expect(await resolveDestinationImage("Fixtureland", "card", 0, deps)).toEqual({
      url: null,
      reason: "upstream-error",
    });
    fail = false;
    expect(await resolveDestinationImage("Fixtureland", "card", 0, deps)).toMatchObject({ source: "tourism-page" });
  });
});

describe("resolveDestinationImage failures", () => {
  it("returns rate-limited on 429, sets the shared back-off and does not cache", async () => {
    let limited = true;
    const h = harness((url) =>
      limited && url.startsWith("https://en.wikipedia.org/")
        ? json({}, 429, { "retry-after": "30" })
        : undefined,
    );
    const deps = h.deps({ placesKey: () => "" });
    const r = await resolveDestinationImage("Fixtureland", "card", 0, deps);
    expect(r).toEqual({ url: null, reason: "rate-limited" });
    expect(wikiBackoffUntil()).toBe(h.clock.t + 30_000);
    expect(h.wiki()).toBe(1);

    // During the back-off no Wikimedia request is made.
    const again = await resolveDestinationImage("Fixtureland", "card", 0, deps);
    expect(again).toEqual({ url: null, reason: "rate-limited" });
    expect(h.wiki()).toBe(1);

    // After the back-off the result is fetched, proving the 429 was not cached.
    limited = false;
    h.clock.t += 30_001;
    expect(await resolveDestinationImage("Fixtureland", "card", 0, deps)).toMatchObject({ source: "tourism-page" });
  });

  it("still serves Places during a Wikimedia back-off", async () => {
    const h = harness();
    h.clock.t = 5_000;
    const lim = harness(() => json({}, 429));
    await resolveDestinationImage("Fixtureland", "card", 0, lim.deps({ placesKey: () => "", now: () => 5_000 }));
    expect(wikiBackoffUntil()).toBeGreaterThan(5_000);
    const r = await resolveDestinationImage("Paris", "card", 0, h.deps({ now: () => 5_000 }));
    expect(r).toMatchObject({ source: "places" });
  });

  it("returns timeout after 6 s and does not cache it", async () => {
    vi.useFakeTimers();
    const h = harness((url) => (url.startsWith("https://en.wikipedia.org/") ? new Promise<Response>(() => {}) : undefined));
    const deps = h.deps({ placesKey: () => "" });
    const p = resolveDestinationImage("Fixtureland", "card", 0, deps);
    await vi.advanceTimersByTimeAsync(5_999);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ url: null, reason: "timeout" });
    expect(deps.cache!.size).toBe(0);
  });

  it("applies the 6 s limit to a hanging Places request", async () => {
    vi.useFakeTimers();
    const h = harness((url) => (url.startsWith("https://places.googleapis.com/") ? new Promise<Response>(() => {}) : undefined));
    const p = resolveDestinationImage("Paris", "card", 0, h.deps());
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await p).toEqual({ url: null, reason: "timeout" });
    expect(h.wiki()).toBe(0);
  });

  it("never throws on malformed bodies", async () => {
    const h = harness((url) => (url.startsWith("https://en.wikipedia.org/") ? json({ query: "nope" }) : undefined));
    const r = await resolveDestinationImage("Fixtureland", "card", 0, h.deps({ placesKey: () => "" }));
    expect(r).toEqual({ url: null, reason: "no-representative-image" });
  });
});
