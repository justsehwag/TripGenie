import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_RESULTS_PER_QUERY,
  QUERY_TIMEOUT_MS,
  buildSearchUrl,
  mapSearxngResult,
  searxngSearch,
  type SearxngFetch,
} from "@/lib/providers/searxng";

const BASE = "https://sx.example.test";
const CFG = { baseUrl: BASE, secretHeader: { name: "X-Grounding-Key", value: "placeholder-value" } };

function okFetch(body: unknown, status = 200): SearxngFetch {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));
}

afterEach(() => vi.useRealTimers());

describe("searxng client", () => {
  it("sends GET with fixed params, secret header, no cookie or body", async () => {
    const f = okFetch({ results: [] });
    const out = await searxngSearch("best things to do in Goa", CFG, { fetchImpl: f });
    expect(out).toEqual({ kind: "ok", results: [] });
    const [url, init] = (f as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock.calls[0];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(`${BASE}/search`);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      q: "best things to do in Goa",
      format: "json",
      language: "en",
      safesearch: "1",
      categories: "general",
      pageno: "1",
    });
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect("body" in init).toBe(false);
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Grounding-Key"]).toBe("placeholder-value");
    expect(headers.Accept).toBe("application/json");
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain("cookie");
  });

  it("sends no secret header when none is configured", async () => {
    const f = okFetch({ results: [] });
    await searxngSearch("q", { baseUrl: BASE, secretHeader: null }, { fetchImpl: f });
    const init = (f as unknown as { mock: { calls: [string, { headers: Record<string, string> }][] } }).mock.calls[0][1];
    expect(Object.keys(init.headers).sort()).toEqual(["Accept", "User-Agent"]);
  });

  it("keeps a base path and sends nothing for non-https or blank base", async () => {
    expect(buildSearchUrl("https://h.test/sx/", "a b")).toMatch(/^https:\/\/h\.test\/sx\/search\?q=a\+b&/);
    for (const baseUrl of ["http://h.test", "", "nonsense"]) {
      const f = okFetch({ results: [] });
      expect(await searxngSearch("q", { baseUrl, secretHeader: null }, { fetchImpl: f })).toEqual({ kind: "failed" });
      expect(f).not.toHaveBeenCalled();
    }
  });

  it("aborts after 2500 ms", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const f: SearxngFetch = (_u, init) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          rej(new Error("aborted"));
        });
      });
    const p = searxngSearch("q", CFG, { fetchImpl: f });
    await vi.advanceTimersByTimeAsync(QUERY_TIMEOUT_MS - 1);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(aborted).toBe(true);
    expect(await p).toEqual({ kind: "failed" });
  });

  it("ends at the timeout even when fetch ignores the signal", async () => {
    vi.useFakeTimers();
    const f: SearxngFetch = () => new Promise(() => undefined);
    const p = searxngSearch("q", CFG, { fetchImpl: f });
    await vi.advanceTimersByTimeAsync(QUERY_TIMEOUT_MS);
    expect(await p).toEqual({ kind: "failed" });
  });

  it("honours an external abort signal", async () => {
    const ac = new AbortController();
    const f: SearxngFetch = (_u, init) =>
      new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("x"))));
    const p = searxngSearch("q", CFG, { fetchImpl: f, signal: ac.signal });
    ac.abort();
    expect(await p).toEqual({ kind: "failed" });
  });

  it("returns failed for each failure mode without throwing", async () => {
    const thrower: SearxngFetch = async () => {
      throw new Error("https://secret.example/leak");
    };
    const badJson: SearxngFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("bad");
      },
    });
    for (const f of [thrower, badJson, okFetch({}, 500), okFetch({ results: [] }, 429), okFetch({ nope: 1 }), okFetch([1]), okFetch(null)]) {
      expect(await searxngSearch("q", CFG, { fetchImpl: f })).toEqual({ kind: "failed" });
    }
  });

  it("returns redirect for any 3xx without reading the body", async () => {
    const json = vi.fn();
    for (const status of [301, 302, 307, 308]) {
      const f: SearxngFetch = async () => ({ ok: false, status, json });
      expect(await searxngSearch("q", CFG, { fetchImpl: f })).toEqual({ kind: "redirect" });
    }
    expect(json).not.toHaveBeenCalled();
  });

  it("maps only allowed fields and truncates", () => {
    const m = mapSearxngResult({
      title: "T".repeat(300),
      content: "c".repeat(900),
      url: "https://a.test/x",
      engine: "e".repeat(80),
      extra: "ignored",
    });
    expect(m).not.toBeNull();
    expect(m!.title.length).toBe(200);
    expect(m!.content.length).toBe(500);
    expect(m!.engine.length).toBe(50);
    expect(Object.keys(m!).sort()).toEqual(["content", "engine", "title", "url"]);
  });

  it("drops non-https URLs and empty titles, keeps the first 10 in order", async () => {
    const results = [
      { title: "bad http", content: "x", url: "http://a.test" },
      { title: "bad js", content: "x", url: "javascript:alert(1)" },
      { title: "   ", content: "x", url: "https://a.test/empty" },
      ...Array.from({ length: 15 }, (_, i) => ({ title: `T${i}`, content: "c", url: `https://a.test/${i}` })),
    ];
    const out = await searxngSearch("q", CFG, { fetchImpl: okFetch({ results }) });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.results).toHaveLength(MAX_RESULTS_PER_QUERY);
    expect(out.results.map((r) => r.title)).toEqual(Array.from({ length: 10 }, (_, i) => `T${i}`));
  });

  it("one failing query does not affect another", async () => {
    const f: SearxngFetch = async (url) => {
      if (new URL(url).searchParams.get("q") === "bad") throw new Error("x");
      return { ok: true, status: 200, json: async () => ({ results: [{ title: "A", content: "c", url: "https://a.test" }] }) };
    };
    const [a, b] = await Promise.all([
      searxngSearch("bad", CFG, { fetchImpl: f }),
      searxngSearch("good", CFG, { fetchImpl: f }),
    ]);
    expect(a.kind).toBe("failed");
    expect(b.kind).toBe("ok");
  });
});
