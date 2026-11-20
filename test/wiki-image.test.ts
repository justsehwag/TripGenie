import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  acceptImageUrl,
  parseRetryAfter,
  resetWikiImageBackoff,
  resolveWikiImage,
  sizeThumbnail,
  wikimediaUserAgent,
} from "@/lib/wiki-image";

const FIX = path.join(__dirname, "fixtures", "wikipedia");
const load = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(FIX, name), "utf8"));

const SLUGS: Record<string, string> = {
  "Taj Mahal": "taj-mahal",
  "Eiffel Tower": "eiffel-tower",
  Goa: "goa",
  "Taj Mahal India": "taj-mahal-india",
  "qzxjvkwpl zzqy xxkcd": "qzxjvkwpl-zzqy-xxkcd",
};

const SLUGS_BY_KEY: Record<string, string> = { Eiffel_Tower: "eiffel-tower" };

interface Call {
  url: string;
  ua: string | undefined;
}

/** Fetch stub that serves the recorded fixtures. */
function fixtureFetch(calls: Call[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ua: (init?.headers as Record<string, string> | undefined)?.["User-Agent"] });
    const u = new URL(url);
    const json = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (u.pathname.endsWith("/search/title")) {
      return json(load(`${SLUGS[u.searchParams.get("q")!]}.title.json`));
    }
    if (u.pathname.endsWith("/w/api.php")) {
      return json(load(`${SLUGS[u.searchParams.get("srsearch")!]}.search.json`));
    }
    const ml = /\/page\/media-list\/(.+)$/.exec(u.pathname);
    if (ml) {
      const file = `${SLUGS_BY_KEY[decodeURIComponent(ml[1])] ?? ""}.media.json`;
      return fs.existsSync(path.join(FIX, file)) ? json(load(file)) : json({ items: [] });
    }
    const m = /\/page\/summary\/(.+)$/.exec(u.pathname);
    if (m) {
      const key = decodeURIComponent(m[1]);
      for (const slug of Object.values(SLUGS)) {
        const s = load(`${slug}.summary.json`) as { titles?: { canonical?: string } };
        if (s.titles?.canonical === key) return json(s);
      }
      return json({ status: 404, type: "Internal error" }, 404);
    }
    return json({}, 500);
  }) as typeof fetch;
}

const stub = (status: number, headers: Record<string, string> = {}, body: unknown = {}): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers })) as typeof fetch;

beforeEach(() => resetWikiImageBackoff());

describe("acceptImageUrl", () => {
  it("accepts https allowlisted hosts with image extensions, ignoring case and query", () => {
    expect(acceptImageUrl("https://upload.wikimedia.org/a/b/X.JPG")).toBe(true);
    expect(acceptImageUrl("https://thumb.wikimedia.org/a/330px-X.webp?utm_source=x")).toBe(true);
    expect(acceptImageUrl("https://thumb.wikimedia.org/a/330px-X.svg.png")).toBe(false);
  });
  it("rejects http, other hosts, bad extensions and non-strings", () => {
    expect(acceptImageUrl("http://upload.wikimedia.org/a/X.jpg")).toBe(false);
    expect(acceptImageUrl("https://evil.example.com/X.jpg")).toBe(false);
    expect(acceptImageUrl("https://upload.wikimedia.org/a/X.svg")).toBe(false);
    expect(acceptImageUrl("https://upload.wikimedia.org/a/X.jpg/page")).toBe(false);
    expect(acceptImageUrl(null)).toBe(false);
    expect(acceptImageUrl(42)).toBe(false);
  });
});

describe("sizeThumbnail", () => {
  const base = "https://thumb.wikimedia.org/wikipedia/commons/thumb/f/fc/B.jpg/";
  it("keeps widths in 320..960", () => {
    expect(sizeThumbnail(`${base}330px-B.jpg?x=1`, 330, 4000)).toBe(`${base}330px-B.jpg?x=1`);
    expect(sizeThumbnail(`${base}960px-B.jpg`, 960, undefined)).toBe(`${base}960px-B.jpg`);
  });
  it("rewrites out-of-range widths to 640 and keeps the query", () => {
    expect(sizeThumbnail(`${base}60px-B.jpg?x=1`, 60, 4000)).toBe(`${base}640px-B.jpg?x=1`);
    expect(sizeThumbnail(`${base}1500px-B.jpg`, 1500, undefined)).toBe(`${base}640px-B.jpg`);
  });
  it("returns null when it cannot be sized", () => {
    expect(sizeThumbnail(`${base}60px-B.jpg`, 60, 500)).toBeNull();
    expect(sizeThumbnail("https://upload.wikimedia.org/a/B.jpg", 100, 4000)).toBeNull();
    expect(sizeThumbnail("not a url", 100, 4000)).toBeNull();
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2025-01-01T00:00:00Z");
  it("parses seconds and caps at 300", () => {
    expect(parseRetryAfter("30", now)).toBe(30);
    expect(parseRetryAfter("9999", now)).toBe(300);
  });
  it("parses an HTTP date and caps it", () => {
    expect(parseRetryAfter(new Date(now + 90_000).toUTCString(), now)).toBe(90);
    expect(parseRetryAfter(new Date(now + 3_600_000).toUTCString(), now)).toBe(300);
    expect(parseRetryAfter(new Date(now - 5_000).toUTCString(), now)).toBe(0);
  });
  it("defaults to 60 when absent or invalid", () => {
    expect(parseRetryAfter(null, now)).toBe(60);
    expect(parseRetryAfter("", now)).toBe(60);
    expect(parseRetryAfter("soon", now)).toBe(60);
  });
});

describe("wikimediaUserAgent", () => {
  it("has the form app/version (contact)", () => {
    expect(wikimediaUserAgent("https://example.org/c")).toBe("TripGenie/1.0 (https://example.org/c)");
  });
});

describe("resolveWikiImage with recorded fixtures", () => {
  it("resolves each query to an allowed thumbnail, never the original", async () => {
    for (const q of ["Taj Mahal", "Eiffel Tower", "Goa", "Taj Mahal India"]) {
      const r = await resolveWikiImage(q, { fetchImpl: fixtureFetch(), contact: "c@example.org" });
      expect(r.url, q).not.toBeNull();
      expect(acceptImageUrl(r.url)).toBe(true);
      expect(r.url).toMatch(/\/\d{3}px-/);
    }
  });

  it("sends the contact User-Agent on every request, and searches before any summary", async () => {
    const calls: Call[] = [];
    await resolveWikiImage("Taj Mahal India", { fetchImpl: fixtureFetch(calls), contact: "me@example.org" });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) expect(c.ua).toBe("TripGenie/1.0 (me@example.org)");
    expect(calls[0].url).toContain("/search/title");
    expect(calls.at(-1)!.url).toContain("/page/summary/Taj_Mahal");
    expect(calls.some((c) => c.url.includes("Taj_Mahal_India"))).toBe(false);
  });

  it("falls back to full-text search when the title search is empty, then reports no-page", async () => {
    const calls: Call[] = [];
    const r = await resolveWikiImage("qzxjvkwpl zzqy xxkcd", { fetchImpl: fixtureFetch(calls) });
    expect(r).toEqual({ url: null, reason: "no-page" });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/w/rest.php/v1/search/title", "/w/api.php"]);
  });

  it("returns no-page for an empty query without any request", async () => {
    const calls: Call[] = [];
    expect(await resolveWikiImage("   ", { fetchImpl: fixtureFetch(calls) })).toEqual({
      url: null,
      reason: "no-page",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("resolveWikiImage reasons", () => {
  const titleHit = { pages: [{ key: "Foo", title: "Foo", description: "x" }] };
  const seq = (...responses: Array<() => Response>): typeof fetch => {
    let i = 0;
    return (async () => responses[Math.min(i++, responses.length - 1)]()) as typeof fetch;
  };
  const ok = (b: unknown) => () => new Response(JSON.stringify(b), { status: 200 });

  it("no-thumbnail when the summary has none", async () => {
    const r = await resolveWikiImage("Foo", { fetchImpl: seq(ok(titleHit), ok({ type: "standard" })) });
    expect(r).toEqual({ url: null, reason: "no-thumbnail" });
  });

  it("rejected-url for a non-allowlisted host or a bad extension", async () => {
    const bad = (source: string) =>
      resolveWikiImage("Foo", {
        fetchImpl: seq(ok(titleHit), ok({ thumbnail: { source, width: 400 } })),
      });
    expect(await bad("https://evil.example.com/a/400px-X.jpg")).toEqual({ url: null, reason: "rejected-url" });
    expect(await bad("https://thumb.wikimedia.org/a/400px-X.gif")).toEqual({ url: null, reason: "rejected-url" });
    expect(await bad("http://thumb.wikimedia.org/a/400px-X.jpg")).toEqual({ url: null, reason: "rejected-url" });
  });

  it("no-page on a summary 404", async () => {
    const r = await resolveWikiImage("Foo", {
      fetchImpl: seq(ok(titleHit), () => new Response("{}", { status: 404 })),
    });
    expect(r).toEqual({ url: null, reason: "no-page" });
  });

  it("skips a disambiguation summary and uses the next title", async () => {
    const two = {
      pages: [
        { key: "A", title: "A", description: null },
        { key: "B", title: "B", description: null },
      ],
    };
    const r = await resolveWikiImage("Foo", {
      fetchImpl: seq(
        ok(two),
        ok({ type: "disambiguation" }),
        ok({ type: "standard", thumbnail: { source: "https://thumb.wikimedia.org/a/400px-B.png", width: 400 } }),
      ),
    });
    expect(r).toEqual({ url: "https://thumb.wikimedia.org/a/500px-B.png" });
  });

  it("upstream-error on 5xx, a network error or invalid JSON", async () => {
    expect(await resolveWikiImage("Foo", { fetchImpl: stub(503) })).toEqual({ url: null, reason: "upstream-error" });
    const boom = (async () => {
      throw new Error("down");
    }) as typeof fetch;
    expect(await resolveWikiImage("Foo", { fetchImpl: boom })).toEqual({ url: null, reason: "upstream-error" });
    const html = (async () => new Response("<html>", { status: 200 })) as typeof fetch;
    expect(await resolveWikiImage("Foo", { fetchImpl: html })).toEqual({ url: null, reason: "upstream-error" });
  });

  it("timeout aborts an in-flight request", async () => {
    let aborted = false;
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          rej(new Error("aborted"));
        });
      })) as typeof fetch;
    const r = await resolveWikiImage("Foo", { fetchImpl: hang, timeoutMs: 20 });
    expect(r).toEqual({ url: null, reason: "timeout" });
    expect(aborted).toBe(true);
  });

  it("never throws, even for a non-string query", async () => {
    const r = await resolveWikiImage(undefined as unknown as string, { fetchImpl: stub(200) });
    expect(r.url).toBeNull();
  });
});

describe("resolveWikiImage rate limiting", () => {
  it("backs off for Retry-After seconds without further requests, then recovers", async () => {
    let t = 1_000_000;
    let n = 0;
    const counting = (async () => {
      n++;
      return new Response("{}", { status: 429, headers: { "retry-after": "30" } });
    }) as typeof fetch;
    const deps = { now: () => t };
    expect(await resolveWikiImage("Foo", { ...deps, fetchImpl: counting })).toEqual({
      url: null,
      reason: "rate-limited",
    });
    expect(n).toBe(1);
    t += 29_000;
    expect(await resolveWikiImage("Foo", { ...deps, fetchImpl: counting })).toEqual({
      url: null,
      reason: "rate-limited",
    });
    expect(n).toBe(1);
    t += 2_000;
    await resolveWikiImage("Taj Mahal", { ...deps, fetchImpl: fixtureFetch() });
    const r = await resolveWikiImage("Taj Mahal", { ...deps, fetchImpl: fixtureFetch() });
    expect(r.url).not.toBeNull();
  });

  it("uses 60 s without a valid Retry-After and caps at 300 s", async () => {
    let t = 0;
    const deps = { now: () => t };
    await resolveWikiImage("Foo", { ...deps, fetchImpl: stub(429) });
    t = 59_000;
    expect(await resolveWikiImage("Taj Mahal", { ...deps, fetchImpl: fixtureFetch() })).toEqual({
      url: null,
      reason: "rate-limited",
    });
    t = 61_000;
    expect((await resolveWikiImage("Taj Mahal", { ...deps, fetchImpl: fixtureFetch() })).url).not.toBeNull();

    resetWikiImageBackoff();
    t = 0;
    await resolveWikiImage("Foo", { ...deps, fetchImpl: stub(429, { "retry-after": "99999" }) });
    t = 299_000;
    expect((await resolveWikiImage("Taj Mahal", { ...deps, fetchImpl: fixtureFetch() })).url).toBeNull();
    t = 301_000;
    expect((await resolveWikiImage("Taj Mahal", { ...deps, fetchImpl: fixtureFetch() })).url).not.toBeNull();
  });
});
