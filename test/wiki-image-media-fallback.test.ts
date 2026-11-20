import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { resetWikiImageBackoff, resolveWikiImage } from "@/lib/wiki-image";

/** Media-list fallback (task 4.4). Injected fetch and recorded fixtures only. */

const FIX = path.join(__dirname, "fixtures", "wikipedia");
const load = (name: string): any => JSON.parse(fs.readFileSync(path.join(FIX, name), "utf8"));
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });

interface Call {
  url: string;
  ua: string | undefined;
}

type Handler = (url: URL) => Response | undefined;

function makeFetch(calls: Call[], handlers: Handler[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ua: (init?.headers as Record<string, string> | undefined)?.["User-Agent"] });
    const u = new URL(url);
    for (const h of handlers) {
      const r = h(u);
      if (r) return r;
    }
    return json({}, 500);
  }) as typeof fetch;
}

const eiffelHandlers = (media: Handler): Handler[] => [
  (u) => (u.pathname.endsWith("/search/title") ? json(load("eiffel-tower.title.json")) : undefined),
  media,
  // The second search hit gets the same logo-led summary, so the next title is tried too.
  (u) => (/\/page\/summary\//.test(u.pathname) ? json(load("eiffel-tower.summary.json")) : undefined),
];
const eiffelMedia: Handler = (u) =>
  /\/page\/media-list\/Eiffel_Tower$/.test(u.pathname) ? json(load("eiffel-tower.media.json")) : undefined;

const isMedia = (c: Call) => c.url.includes("/page/media-list/");

beforeEach(() => resetWikiImageBackoff());

describe("media-list fallback when the lead image is rejected", () => {
  it("uses the first acceptable media-list photo for Eiffel Tower, never a logo or SVG", async () => {
    const calls: Call[] = [];
    const r = await resolveWikiImage("Eiffel Tower", {
      fetchImpl: makeFetch(calls, eiffelHandlers(eiffelMedia)),
      contact: "c@example.org",
    });
    expect(r.url).not.toBeNull();
    const url = r.url as string;
    expect(url).not.toMatch(/logo/i);
    expect(url).not.toContain(".svg");
    expect(url).toContain("Tour_Eiffel_Wikimedia_Commons");
    expect(url).toMatch(/^https:\/\/thumb\.wikimedia\.org\//);
    expect(url).toMatch(/\/500px-/);
    const media = calls.filter(isMedia);
    expect(media).toHaveLength(1);
    expect(media[0].ua).toBe("TripGenie/1.0 (c@example.org)");
  });

  it("makes no extra request when the lead image is acceptable", async () => {
    const calls: Call[] = [];
    const r = await resolveWikiImage("Taj Mahal", {
      fetchImpl: makeFetch(calls, [
        (u) => (u.pathname.endsWith("/search/title") ? json(load("taj-mahal.title.json")) : undefined),
        (u) => (u.pathname.includes("/page/media-list/") ? json({ items: [] }) : undefined),
        (u) => (/\/page\/summary\/Taj_Mahal$/.test(u.pathname) ? json(load("taj-mahal.summary.json")) : undefined),
      ]),
    });
    expect(r.url).not.toBeNull();
    expect(calls.filter(isMedia)).toHaveLength(0);
  });

  it("tries the next title when every media-list item is banned", async () => {
    const calls: Call[] = [];
    const banned = {
      items: [
        { title: "File:Flag_of_Paris.svg", type: "image", srcset: [{ src: "//thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Flag_of_Paris.svg/500px-Flag_of_Paris.svg.png", scale: "1x" }] },
        { title: "File:Paris_location_map.png", type: "image", srcset: [{ src: "//thumb.wikimedia.org/wikipedia/commons/thumb/a/ac/Paris_location_map.png/500px-Paris_location_map.png", scale: "1x" }] },
        { title: "File:Intro.ogv", type: "video", srcset: [{ src: "//upload.wikimedia.org/wikipedia/commons/a/ad/Intro.ogv", scale: "1x" }] },
      ],
    };
    const good = {
      type: "standard",
      title: "Second Tower",
      titles: { canonical: "Second_Tower" },
      thumbnail: { source: "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/cd/Second.jpg/500px-Second.jpg", width: 500, height: 700 },
      originalimage: { source: "https://upload.wikimedia.org/wikipedia/commons/c/cd/Second.jpg", width: 2000, height: 2800 },
    };
    const bad = {
      type: "standard",
      title: "First Tower",
      titles: { canonical: "First_Tower" },
      thumbnail: { source: "https://thumb.wikimedia.org/wikipedia/en/thumb/b/ba/First_logo.svg/330px-First_logo.svg.png", width: 330, height: 400 },
    };
    const r = await resolveWikiImage("Tower", {
      fetchImpl: makeFetch(calls, [
        (u) =>
          u.pathname.endsWith("/search/title")
            ? json({ pages: [{ key: "First_Tower", title: "First Tower" }, { key: "Second_Tower", title: "Second Tower" }] })
            : undefined,
        (u) => (u.pathname.endsWith("/media-list/First_Tower") ? json(banned) : undefined),
        (u) => (u.pathname.endsWith("/summary/First_Tower") ? json(bad) : undefined),
        (u) => (u.pathname.endsWith("/summary/Second_Tower") ? json(good) : undefined),
      ]),
    });
    expect(r.url).toContain("Second.jpg");
    expect(calls.filter(isMedia)).toHaveLength(1);
    const order = calls.map((c) => c.url.split("/page/")[1]?.split("/")[0]).filter(Boolean);
    expect(order).toEqual(["summary", "media-list", "summary"]);
  });

  it("returns no-representative-image when no title has an acceptable photo", async () => {
    const calls: Call[] = [];
    const r = await resolveWikiImage("Eiffel Tower", {
      fetchImpl: makeFetch(calls, eiffelHandlers((u) => (u.pathname.includes("/media-list/") ? json({ items: [] }) : undefined))),
    });
    expect(r).toEqual({ url: null, reason: "no-representative-image" });
  });

  it("maps a media-list 429 to rate-limited and sets the back-off", async () => {
    const calls: Call[] = [];
    const fetchImpl = makeFetch(
      calls,
      eiffelHandlers((u) => (u.pathname.includes("/media-list/") ? json({}, 429, { "retry-after": "30" }) : undefined)),
    );
    const r = await resolveWikiImage("Eiffel Tower", { fetchImpl });
    expect(r).toEqual({ url: null, reason: "rate-limited" });
    const before = calls.length;
    const again = await resolveWikiImage("Eiffel Tower", { fetchImpl });
    expect(again).toEqual({ url: null, reason: "rate-limited" });
    expect(calls.length).toBe(before);
  });

  it("maps a media-list 5xx to upstream-error", async () => {
    const r = await resolveWikiImage("Eiffel Tower", {
      fetchImpl: makeFetch([], eiffelHandlers((u) => (u.pathname.includes("/media-list/") ? json({}, 503) : undefined))),
    });
    expect(r).toEqual({ url: null, reason: "upstream-error" });
  });
});
