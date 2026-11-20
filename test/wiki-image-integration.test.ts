import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { loadAwsConfig, wikimediaContact } from "@/lib/config";
import {
  resetWikiImageBackoff,
  resolveWikiImage,
  wikimediaUserAgent,
  type WikiImageResult,
  type WikiReason,
} from "@/lib/wiki-image";

/**
 * Task 4.5 (Requirements 11.1, 11.2, 11.4-11.9, 11.11). Recorded fixtures and an
 * injected fetch only: no live network. Complements test/wiki-image.test.ts
 * (task 4.2), which is not edited.
 */

// Route tests (bottom of file) stub the resolver; every other test uses the real one.
const routeResolver = vi.hoisted(() => ({
  impl: null as null | ((q: string) => Promise<unknown>),
}));
vi.mock("@/lib/wiki-image", async () => {
  const actual = await vi.importActual<typeof import("@/lib/wiki-image")>("@/lib/wiki-image");
  return {
    ...actual,
    resolveWikiImage: (q: string, deps?: Parameters<typeof actual.resolveWikiImage>[1]) =>
      routeResolver.impl ? routeResolver.impl(q) : actual.resolveWikiImage(q, deps),
  };
});

const FIX = path.join(__dirname, "fixtures", "wikipedia");
const load = (name: string): any => JSON.parse(fs.readFileSync(path.join(FIX, name), "utf8"));

const SLUGS: Record<string, string> = {
  "Taj Mahal": "taj-mahal",
  "Eiffel Tower": "eiffel-tower",
  Goa: "goa",
  "Taj Mahal India": "taj-mahal-india",
  "qzxjvkwpl zzqy xxkcd": "qzxjvkwpl-zzqy-xxkcd",
};
const SLUGS_BY_KEY: Record<string, string> = { Eiffel_Tower: "eiffel-tower" };
const NONSENSE = "qzxjvkwpl zzqy xxkcd";

const ALLOWED_HOSTS = loadAwsConfig().imageHostAllowlist.map((h) => h.toLowerCase());
const isAllowedWikimediaHost = (host: string): boolean =>
  ALLOWED_HOSTS.includes(host.toLowerCase()) && /(^|\.)wikimedia\.org$/.test(host.toLowerCase());

interface Call {
  url: string;
  headers: Record<string, string>;
}

function fixtureFetch(calls: Call[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const u = new URL(url);
    const json = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (u.pathname.endsWith("/search/title")) return json(load(`${SLUGS[u.searchParams.get("q")!]}.title.json`));
    if (u.pathname.endsWith("/w/api.php")) return json(load(`${SLUGS[u.searchParams.get("srsearch")!]}.search.json`));
    const ml = /\/page\/media-list\/(.+)$/.exec(u.pathname);
    if (ml) {
      const file = `${SLUGS_BY_KEY[decodeURIComponent(ml[1])] ?? ""}.media.json`;
      return fs.existsSync(path.join(FIX, file)) ? json(load(file)) : json({ items: [] });
    }
    const m = /\/page\/summary\/(.+)$/.exec(u.pathname);
    if (m) {
      const key = decodeURIComponent(m[1]);
      for (const slug of Object.values(SLUGS)) {
        const s = load(`${slug}.summary.json`);
        if (s.titles?.canonical === key) return json(s);
      }
      return json({}, 404);
    }
    return json({}, 500);
  }) as typeof fetch;
}

beforeEach(() => {
  resetWikiImageBackoff();
  routeResolver.impl = null;
});

describe("Requirement 11.11: recorded Wikipedia fixtures", () => {
  it.each(["Taj Mahal", "Eiffel Tower", "Goa", "Taj Mahal India"])(
    "%s resolves to an https URL on an allowed Wikimedia host",
    async (q) => {
      const r = await resolveWikiImage(q, { fetchImpl: fixtureFetch(), contact: "c@example.org" });
      expect(r.url).not.toBeNull();
      const u = new URL(r.url as string);
      expect(u.protocol).toBe("https:");
      expect(isAllowedWikimediaHost(u.hostname)).toBe(true);
    },
  );

  it("the nonsense query returns url null with reason no-page", async () => {
    const r = await resolveWikiImage(NONSENSE, { fetchImpl: fixtureFetch() });
    expect(r).toEqual({ url: null, reason: "no-page" });
  });
});

describe("Requirement 11.1, 11.2: search first, thumbnail only", () => {
  it("requests a summary only for titles that came from a search result", async () => {
    for (const q of ["Taj Mahal", "Eiffel Tower", "Goa", "Taj Mahal India"]) {
      resetWikiImageBackoff();
      const calls: Call[] = [];
      await resolveWikiImage(q, { fetchImpl: fixtureFetch(calls) });
      const searchTitles = new Set<string>();
      const title = load(`${SLUGS[q]}.title.json`);
      for (const p of title.pages ?? []) searchTitles.add(String(p.key ?? p.title).replace(/ /g, "_"));
      const summaries = calls.filter((c) => c.url.includes("/page/summary/"));
      expect(summaries.length).toBeGreaterThan(0);
      expect(calls[0].url).toContain("/search/title");
      for (const s of summaries) {
        const t = decodeURIComponent(s.url.split("/page/summary/")[1]);
        expect(searchTitles.has(t), `${q}: ${t}`).toBe(true);
      }
    }
  });

  it("never returns the originalimage source", async () => {
    for (const q of ["Taj Mahal", "Eiffel Tower", "Goa", "Taj Mahal India"]) {
      resetWikiImageBackoff();
      const r = await resolveWikiImage(q, { fetchImpl: fixtureFetch() });
      const summary = load(`${SLUGS[q]}.summary.json`);
      const original: string | undefined = summary.originalimage?.source;
      // Some small images have originalimage identical to the thumbnail; only a distinct original is checked.
      if (original && original !== summary.thumbnail?.source) expect(r.url).not.toBe(original);
      expect(String(r.url)).toMatch(/\/\d{3}px-/);
    }
  });

  it("never returns a Picsum or stock URL, whatever the outcome", async () => {
    const results: WikiImageResult[] = [];
    for (const q of Object.keys(SLUGS)) {
      resetWikiImageBackoff();
      results.push(await resolveWikiImage(q, { fetchImpl: fixtureFetch() }));
    }
    results.push(await resolveWikiImage("Foo", { fetchImpl: (async () => new Response("{}", { status: 503 })) as typeof fetch }));
    for (const r of results) expect(JSON.stringify(r)).not.toMatch(/picsum|destination-fallback/i);
  });
});

describe("Requirement 11.4: User-Agent contact", () => {
  it("the default contact is non-empty and used on every request", async () => {
    expect(wikimediaContact().trim()).not.toBe("");
    const calls: Call[] = [];
    await resolveWikiImage("Goa", { fetchImpl: fixtureFetch(calls) });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.headers["User-Agent"]).toBe(wikimediaUserAgent(wikimediaContact()));
      expect(c.headers["User-Agent"]).toMatch(/^TripGenie\/1\.0 \(.+\)$/);
    }
  });
});

describe("Requirement 11.8, 11.9: rate limit and timeout", () => {
  it("429 without Retry-After blocks for 60 s, with Retry-After 120 for 120 s, using an injected clock", async () => {
    let t = 10_000_000;
    let n = 0;
    const limited = (retryAfter?: string) =>
      (async () => {
        n++;
        return new Response("{}", { status: 429, headers: retryAfter ? { "retry-after": retryAfter } : {} });
      }) as typeof fetch;
    const deps = { now: () => t };

    expect(await resolveWikiImage("Goa", { ...deps, fetchImpl: limited() })).toEqual({ url: null, reason: "rate-limited" });
    expect(n).toBe(1);
    t += 59_000;
    expect((await resolveWikiImage("Goa", { ...deps, fetchImpl: limited() })).url).toBeNull();
    expect(n).toBe(1);
    t += 2_000;
    expect((await resolveWikiImage("Goa", { ...deps, fetchImpl: fixtureFetch() })).url).not.toBeNull();

    resetWikiImageBackoff();
    n = 0;
    await resolveWikiImage("Goa", { ...deps, fetchImpl: limited("120") });
    t += 119_000;
    await resolveWikiImage("Goa", { ...deps, fetchImpl: limited("120") });
    expect(n).toBe(1);
    t += 2_000;
    expect((await resolveWikiImage("Goa", { ...deps, fetchImpl: fixtureFetch() })).url).not.toBeNull();
  });

  it("aborts at the default 6,000 ms with timeout (fake timers)", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const hang = ((_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            rej(new Error("aborted"));
          });
        })) as typeof fetch;
      let settled = false;
      const p = resolveWikiImage("Goa", { fetchImpl: hang }).then((r) => {
        settled = true;
        return r;
      });
      await vi.advanceTimersByTimeAsync(5_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toEqual({ url: null, reason: "timeout" });
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Route-level tests. They depend on task 4.3 (app/api/image/route.ts rebuilt as a
 * thin edge over resolveWikiImage, per design.md "Image route").
 */
describe("Requirement 11.6, 11.7: /api/image route (depends on task 4.3)", () => {
  const call = async (query: string) => {
    const { GET } = await import("@/app/api/image/route");
    const req = new NextRequest(
      `http://localhost/api/image?kind=destination&query=${encodeURIComponent(query)}&slot=0`,
    );
    const res = await GET(req);
    return { res, body: (await res.json()) as Record<string, unknown> };
  };

  const CACHEABLE: WikiReason[] = ["no-page", "no-thumbnail", "rejected-url"];
  const NO_STORE: WikiReason[] = ["timeout", "rate-limited", "upstream-error"];

  it.each([...CACHEABLE, ...NO_STORE])("reason %s: HTTP 200, url null, correct Cache-Control", async (reason) => {
    routeResolver.impl = async () => ({ url: null, reason });
    const { res, body } = await call("Some Place");
    expect(res.status).toBe(200);
    expect(body.url).toBeNull();
    expect(body.reason).toBe(reason);
    expect(res.headers.get("cache-control")).toBe(
      NO_STORE.includes(reason) ? "no-store" : "public, max-age=86400",
    );
  });

  it("a resolved URL is returned with public caching and no Picsum substitute", async () => {
    const url = "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/330px-X.jpg";
    routeResolver.impl = async () => ({ url });
    const { res, body } = await call("Taj Mahal");
    expect(res.status).toBe(200);
    expect(body.url).toBe(url);
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(JSON.stringify(body)).not.toMatch(/picsum|destination-fallback/i);
  });

  it("route source no longer mentions Picsum", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "app", "api", "image", "route.ts"), "utf8");
    expect(src).not.toMatch(/picsum/i);
  });
});
