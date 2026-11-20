import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enrichStops, resetSearxngHealth, type EnrichInput } from "@/lib/itinerary/enrichment";
import { createEvidenceCache } from "@/lib/web-pricing/evidence-cache";
import { createLimiter } from "@/lib/grounding/limiter";
import type { ResearchConfig, researchPricing } from "@/lib/web-pricing/service";
import type { SearxngFetch } from "@/lib/providers/searxng";

const HOST = "sx-private.example.test";
const BASE = `https://${HOST}`;
const KEY = "SECRET-KEY-d41d8cd98f00";
const ON: ResearchConfig = {
  enabled: true,
  baseUrl: BASE,
  secretHeader: { name: "X-Edge-Key", value: KEY },
};
const CTX = { destination: "Jaipur", budgetLevel: "mid" };

const sight = (id: string, name: string): EnrichInput => ({
  placeId: id,
  name,
  primaryType: "tourist_attraction",
  kind: "sight",
});
const STOPS = [sight("p1", "Amber Fort"), sight("p2", "Hawa Mahal"), sight("p3", "City Palace")];

const q = (url: string) => new URL(url).searchParams.get("q") ?? "";
function okRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
const emptyOk = (): ReturnType<typeof okRes> => okRes({ results: [] });

/** SearXNG-shaped body with one result that carries no price. */
const resultsBody = (n: number) => ({
  query: "x",
  results: [
    {
      title: `Visitor guide ${n}`,
      content: "A page about the place with no price information at all.",
      url: `https://site${n}.example.org/page`,
      engine: "ddg",
    },
  ],
});

const failing: SearxngFetch = async (url) => {
  // The error text carries the URL and key on purpose: the health line must not leak them.
  throw new Error(`connect ECONNREFUSED ${url} key=${KEY}`);
};
const succeeding: SearxngFetch = async (url) => okRes(resultsBody(q(url).length));

function deps(fetchImpl: SearxngFetch, lines: string[], extra: Record<string, unknown> = {}) {
  return {
    fetchImpl,
    config: ON,
    cache: createEvidenceCache(),
    limiter: createLimiter(5),
    healthLogger: (l: string) => {
      lines.push(l);
    },
    ...extra,
  };
}

const HEALTH_RE = /^\[searxng-health\] status=(unreachable|degraded) queries=\d+ failed=\d+$/;

beforeEach(() => resetSearxngHealth());
afterEach(() => {
  resetSearxngHealth();
  vi.restoreAllMocks();
});

describe("[searxng-health] line", () => {
  it("every search fails: unavailable and one status=unreachable line with counts", async () => {
    const lines: string[] = [];
    const r = await enrichStops(STOPS, CTX, deps(failing, lines));
    expect(r.unavailable).toBe(true);
    expect(r.queries).toBeGreaterThan(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(HEALTH_RE);
    expect(lines[0]).toBe(`[searxng-health] status=unreachable queries=${r.queries} failed=${r.queries}`);
    for (const s of STOPS) expect(r.stops.get(s.placeId)?.webDetails).toEqual({ checked: false });
    expect(r.status).toBe("not-checked");
  });

  it("HTTP 500 and a malformed body also count as failures", async () => {
    const lines: string[] = [];
    const a = await enrichStops(STOPS, CTX, deps(async () => okRes({}, 500), lines));
    expect(a.unavailable).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("status=unreachable");

    resetSearxngHealth();
    const lines2: string[] = [];
    const b = await enrichStops(STOPS, CTX, deps(async () => okRes("not a searxng body"), lines2));
    expect(b.unavailable).toBe(true);
    expect(lines2).toHaveLength(1);
  });

  it("some searches fail: degraded, not unavailable", async () => {
    const lines: string[] = [];
    const mixed: SearxngFetch = async (url) => {
      if (q(url).includes("Hawa Mahal")) throw new Error("boom");
      return okRes(resultsBody(1));
    };
    const r = await enrichStops(STOPS, CTX, deps(mixed, lines));
    expect(r.unavailable).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(HEALTH_RE);
    expect(lines[0]).toContain("status=degraded");
    const m = /queries=(\d+) failed=(\d+)/.exec(lines[0])!;
    expect(Number(m[1])).toBe(r.queries);
    expect(Number(m[2])).toBeGreaterThan(0);
    expect(Number(m[2])).toBeLessThan(Number(m[1]));
  });

  it("is written once per process while the failure persists", async () => {
    const lines: string[] = [];
    await enrichStops(STOPS, CTX, deps(failing, lines));
    await enrichStops(STOPS, CTX, deps(failing, lines));
    const r3 = await enrichStops(STOPS, CTX, deps(failing, lines));
    expect(r3.unavailable).toBe(true); // still reported on the result
    expect(lines).toHaveLength(1);
  });

  it("stays once-only when the status changes from unreachable to degraded", async () => {
    const lines: string[] = [];
    await enrichStops(STOPS, CTX, deps(failing, lines));
    const mixed: SearxngFetch = async (url) => {
      if (q(url).includes("Hawa Mahal")) throw new Error("boom");
      return okRes(resultsBody(1));
    };
    await enrichStops(STOPS, CTX, deps(mixed, lines));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("status=unreachable");
  });

  it("a fully successful run clears the flag so the next failure logs again", async () => {
    const lines: string[] = [];
    await enrichStops(STOPS, CTX, deps(failing, lines));
    expect(lines).toHaveLength(1);

    const ok = await enrichStops(STOPS, CTX, deps(succeeding, lines));
    expect(ok.unavailable).toBe(false);
    expect(lines).toHaveLength(1); // recovery writes nothing

    await enrichStops(STOPS, CTX, deps(failing, lines));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(HEALTH_RE);
  });

  it("an answered search with no results counts as success and clears the flag", async () => {
    const lines: string[] = [];
    await enrichStops(STOPS, CTX, deps(failing, lines));
    const r = await enrichStops(STOPS, CTX, deps(async () => emptyOk(), lines));
    expect(r.unavailable).toBe(false);
    await enrichStops(STOPS, CTX, deps(failing, lines));
    expect(lines).toHaveLength(2);
  });

  it("a degraded run does not clear the flag", async () => {
    const lines: string[] = [];
    const mixed: SearxngFetch = async (url) => {
      if (q(url).includes("Hawa Mahal")) throw new Error("boom");
      return okRes(resultsBody(1));
    };
    await enrichStops(STOPS, CTX, deps(mixed, lines));
    await enrichStops(STOPS, CTX, deps(mixed, lines));
    expect(lines).toHaveLength(1);
  });

  it("resetSearxngHealth lets the line be written again", async () => {
    const lines: string[] = [];
    await enrichStops(STOPS, CTX, deps(failing, lines));
    resetSearxngHealth();
    await enrichStops(STOPS, CTX, deps(failing, lines));
    expect(lines).toHaveLength(2);
  });
});

describe("unavailable and no line when enrichment does not run", () => {
  it("disabled configuration: unavailable=false, no line, no request", async () => {
    const lines: string[] = [];
    const f = vi.fn(failing);
    const r = await enrichStops(STOPS, CTX, deps(f, lines, { config: { ...ON, enabled: false } }));
    expect(r.unavailable).toBe(false);
    expect(r.queries).toBe(0);
    expect(lines).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it("no base URL: unavailable=false, no line, no request", async () => {
    const lines: string[] = [];
    const f = vi.fn(failing);
    const r = await enrichStops(STOPS, CTX, deps(f, lines, { config: { ...ON, baseUrl: "" } }));
    expect(r.unavailable).toBe(false);
    expect(lines).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it("no stops or no budget: unavailable=false, no line", async () => {
    const lines: string[] = [];
    const none = await enrichStops([], CTX, deps(failing, lines));
    const noTime = await enrichStops(STOPS, CTX, deps(failing, lines, { budgetMs: 0 }));
    expect(none.unavailable).toBe(false);
    expect(noTime.unavailable).toBe(false);
    expect(lines).toEqual([]);
  });

  it("zero searches sent: unavailable=false and no line", async () => {
    const lines: string[] = [];
    const research = (async () => ({
      status: "none",
      plan: { targets: {}, queries: [], retries: {}, route: {} },
      sets: {},
      stats: { queries: 0, failed: 0, snippets: 0, candidates: 0, ms: 0 },
    })) as unknown as typeof researchPricing;
    const r = await enrichStops(STOPS, CTX, deps(failing, lines, { research }));
    expect(r.unavailable).toBe(false);
    expect(lines).toEqual([]);
  });

  it("successful searches: unavailable=false and no line", async () => {
    const lines: string[] = [];
    const r = await enrichStops(STOPS, CTX, deps(succeeding, lines));
    expect(r.unavailable).toBe(false);
    expect(r.queries).toBeGreaterThan(0);
    expect(lines).toEqual([]);
  });
});

describe("the health line never leaks", () => {
  it("contains no URL, host, query text or key", async () => {
    const lines: string[] = [];
    const seen: string[] = [];
    const f: SearxngFetch = async (url, init) => {
      seen.push(url, JSON.stringify(init ?? {}));
      return failing(url, init);
    };
    await enrichStops(STOPS, CTX, deps(f, lines));
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).toMatch(HEALTH_RE);
    expect(line).not.toContain(KEY);
    expect(line).not.toContain(HOST);
    expect(line).not.toContain(BASE);
    expect(line.toLowerCase()).not.toContain("http");
    expect(line).not.toContain("X-Edge-Key");
    expect(line).not.toContain("ECONNREFUSED");
    for (const s of STOPS) expect(line).not.toContain(s.name);
    expect(line).not.toContain("Jaipur");
    for (const queryText of seen.map((u) => q(u.startsWith("http") ? u : "https://x.test/?q=")).filter(Boolean)) {
      expect(line).not.toContain(queryText);
    }
    // the sent requests did carry the host and key, so the checks above are meaningful
    expect(seen.join(" ")).toContain(HOST);
    expect(seen.join(" ")).toContain(KEY);
  });

  it("the default logger writes only the counts line through console.info", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const base = deps(failing, []);
    const { healthLogger: _omit, ...noLogger } = base;
    void _omit;
    await enrichStops(STOPS, CTX, noLogger);
    const health = info.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[searxng-health]"));
    expect(health).toHaveLength(1);
    expect(health[0]).toMatch(HEALTH_RE);
    for (const l of [...info.mock.calls, ...warn.mock.calls, ...err.mock.calls].map((c) => c.map(String).join(" "))) {
      expect(l).not.toContain(KEY);
      expect(l).not.toContain(HOST);
    }
  });

  it("a throwing logger does not change the result", async () => {
    const r = await enrichStops(
      STOPS,
      CTX,
      deps(failing, [], {
        healthLogger: () => {
          throw new Error("logger down");
        },
      }),
    );
    expect(r.unavailable).toBe(true);
    expect(r.stops.size).toBe(STOPS.length);
  });
});
