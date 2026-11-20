import { describe, expect, it, vi } from "vitest";
import { enrichStops, extractExcerpt, type EnrichInput } from "@/lib/itinerary/enrichment";
import { createEvidenceCache } from "@/lib/web-pricing/evidence-cache";
import { createLimiter } from "@/lib/grounding/limiter";
import { RESEARCH_BUDGET_MS, type ResearchConfig, researchPricing } from "@/lib/web-pricing/service";
import type { SearxngFetch } from "@/lib/providers/searxng";
import { isValidWebFields } from "@/lib/web-price-sources";
import type { EvidenceSet } from "@/lib/web-pricing/evidence";

const ON: ResearchConfig = { enabled: true, baseUrl: "https://sx.example.test", secretHeader: null };
const CTX = { destination: "Jaipur", budgetLevel: "mid" };

const sight = (id: string, name: string, primaryType: string | null = "tourist_attraction"): EnrichInput => ({
  placeId: id,
  name,
  primaryType,
  kind: "sight",
});
const meal = (id: string, name: string): EnrichInput => ({ placeId: id, name, primaryType: "restaurant", kind: "meal" });

function okRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
const q = (url: string) => new URL(url).searchParams.get("q") ?? "";

function result(n: number, content: string, title = "Amber Fort visitor guide") {
  return {
    title: `${title} ${n}`,
    content,
    url: `https://site${n}.example.org/amber`,
    engine: "ddg",
  };
}

function deps(fetchImpl: SearxngFetch, extra: Record<string, unknown> = {}) {
  return { fetchImpl, config: ON, cache: createEvidenceCache(), limiter: createLimiter(5), ...extra };
}

describe("enrichStops", () => {
  it("returns not-checked without any request when disabled or no base URL", async () => {
    const f = vi.fn();
    const a = await enrichStops([sight("p1", "Amber Fort")], CTX, deps(f as unknown as SearxngFetch, { config: { ...ON, enabled: false } }));
    const b = await enrichStops([sight("p1", "Amber Fort")], CTX, deps(f as unknown as SearxngFetch, { config: { ...ON, baseUrl: "" } }));
    for (const r of [a, b]) {
      expect(r.status).toBe("not-checked");
      expect(r.stops.get("p1")?.webDetails).toEqual({ checked: false });
      expect(r.queries).toBe(0);
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("accepts a cited price and keeps tip, booking and best time as verbatim excerpts", async () => {
    const tip = "Tip: arrive early to avoid crowds at the main gate of Amber Fort in Jaipur.";
    const booking = "You can book tickets online in advance for Amber Fort in Jaipur to skip the queue.";
    const best = "The best time to visit Amber Fort in Jaipur is sunrise, between October and March.";
    const fetchImpl: SearxngFetch = async () =>
      okRes({
        results: [
          result(1, "Amber Fort entry fee is INR 100 per person for Indian visitors in Jaipur."),
          result(2, tip),
          result(3, booking),
          result(4, best),
        ],
      });
    const r = await enrichStops([sight("p1", "Amber Fort")], CTX, deps(fetchImpl));
    const s = r.stops.get("p1")!;
    expect(r.status).toBe("ok");
    expect(s.webDetails.checked).toBe(true);
    expect(s.price?.inr).toBe(100);
    expect(s.price?.kind).toBe("entry");
    expect(s.webDetails.priceKind).toBe("entry");
    expect(s.webDetails.tip?.text).toBe(tip);
    expect(s.webDetails.booking?.text).toBe(booking);
    expect(s.webDetails.bestTime?.text).toBe(best);
    for (const d of [s.webDetails.tip, s.webDetails.booking, s.webDetails.bestTime]) {
      expect(d!.text.length).toBeLessThanOrEqual(240);
      expect(isValidWebFields(d!)).toBe(true);
    }
    expect(r.sources.length).toBeGreaterThan(0);
    expect(r.sources.every((x) => x.url.startsWith("https://"))).toBe(true);
  });

  it("rejects a party price and shows the Stop as checked with no price", async () => {
    const fetchImpl: SearxngFetch = async () =>
      okRes({ results: [result(1, "Amber Fort tickets cost INR 500 for two people in Jaipur today.")] });
    const r = await enrichStops([sight("p1", "Amber Fort")], CTX, deps(fetchImpl));
    const s = r.stops.get("p1")!;
    expect(s.webDetails.checked).toBe(true);
    expect(s.price).toBeUndefined();
    expect(s.webDetails.priceKind).toBeUndefined();
  });

  it("drops excerpts that contain confirmed, bookable, guaranteed or 100% accurate", async () => {
    const fetchImpl: SearxngFetch = async () =>
      okRes({
        results: [
          result(1, "Booking is confirmed instantly for Amber Fort in Jaipur when you book online."),
          result(2, "Guaranteed best time to visit Amber Fort in Jaipur is sunrise every day."),
          result(3, "Bookable tickets in advance, 100% accurate timings for Amber Fort in Jaipur."),
        ],
      });
    const r = await enrichStops([sight("p1", "Amber Fort")], CTX, deps(fetchImpl));
    const d = r.stops.get("p1")!.webDetails;
    expect(d.checked).toBe(true);
    expect(d.tip).toBeUndefined();
    expect(d.booking).toBeUndefined();
    expect(d.bestTime).toBeUndefined();
  });

  it("returns not-checked when SearXNG is unreachable or redirects", async () => {
    const failing: SearxngFetch = async () => {
      throw new Error("down");
    };
    const redirect: SearxngFetch = async () => okRes({}, 302);
    for (const f of [failing, redirect]) {
      const r = await enrichStops([sight("p1", "Amber Fort"), meal("p2", "Chokhi Dhani")], CTX, deps(f));
      expect(r.status).toBe("not-checked");
      expect(r.stops.get("p1")?.webDetails).toEqual({ checked: false });
      expect(r.stops.get("p2")?.webDetails).toEqual({ checked: false });
    }
  });

  it("treats an answered search with no results as checked, not unchecked", async () => {
    const fetchImpl: SearxngFetch = async () => okRes({ results: [] });
    const r = await enrichStops([sight("p1", "Amber Fort")], CTX, deps(fetchImpl));
    expect(r.stops.get("p1")?.webDetails).toEqual({ checked: true });
    expect(r.stops.get("p1")?.price).toBeUndefined();
  });

  it("sends at most 10 queries for a large batch and leaves the rest unchecked", async () => {
    let sent = 0;
    const fetchImpl: SearxngFetch = async (url) => {
      sent += 1;
      return okRes({ results: [result(sent, `Page about ${q(url)} with no price information at all.`)] });
    };
    const stops = Array.from({ length: 15 }, (_, i) => sight(`p${i}`, `Fort Number${String.fromCharCode(97 + i)}`));
    const r = await enrichStops(stops, CTX, deps(fetchImpl));
    expect(sent).toBeLessThanOrEqual(10);
    expect(r.queries).toBe(sent);
    expect(r.stops.size).toBe(15);
    expect([...r.stops.values()].filter((s) => !s.webDetails.checked).length).toBeGreaterThanOrEqual(5);
    expect(r.status).toBe("partial");
  });

  it("queries sights before meals and names meals as Lunch at <name>", async () => {
    const research = vi.fn(researchPricing);
    const fetchImpl: SearxngFetch = async (url) => okRes({ results: [result(1, `About ${q(url)}`)] });
    await enrichStops([meal("m1", "Chokhi Dhani"), sight("s1", "Amber Fort")], CTX, deps(fetchImpl, { research }));
    const input = research.mock.calls[0][0];
    expect(input.activities.map((a) => a.id)).toEqual(["s1", "m1"]);
    expect(input.activities[1].title).toBe("Lunch at Chokhi Dhani");
    expect(input.activities[1].costClass).toBe("meal");
    expect(research.mock.calls[0][1]?.maxQueries).toBe(10);
  });

  it("caps the budget at the shorter of the remaining batch budget and RESEARCH_BUDGET_MS", async () => {
    const research = vi.fn(researchPricing);
    const fetchImpl: SearxngFetch = async () => okRes({ results: [] });
    await enrichStops([sight("p1", "Amber Fort")], CTX, deps(fetchImpl, { research, budgetMs: 3000 }));
    await enrichStops([sight("p1", "Amber Fort")], CTX, deps(fetchImpl, { research, budgetMs: 60_000 }));
    expect(research.mock.calls[0][1]?.budgetMs).toBe(3000);
    expect(research.mock.calls[1][1]?.budgetMs).toBe(RESEARCH_BUDGET_MS);
  });

  it("returns not-checked without a request when no batch budget remains", async () => {
    const f = vi.fn();
    const r = await enrichStops([sight("p1", "Amber Fort")], CTX, deps(f as unknown as SearxngFetch, { budgetMs: 0 }));
    expect(r.status).toBe("not-checked");
    expect(f).not.toHaveBeenCalled();
  });

  it("returns unchecked Stops when the research step is slower than the budget", async () => {
    const fetchImpl: SearxngFetch = () => new Promise(() => undefined);
    const r = await enrichStops([sight("p1", "Amber Fort")], CTX, deps(fetchImpl, { budgetMs: 50 }));
    expect(r.status).toBe("not-checked");
    expect(r.stops.get("p1")?.webDetails).toEqual({ checked: false });
  });

  it("never throws when the research step throws", async () => {
    const research = (async () => {
      throw new Error("boom");
    }) as unknown as typeof researchPricing;
    const r = await enrichStops([sight("p1", "Amber Fort")], CTX, deps((async () => okRes({})) as SearxngFetch, { research }));
    expect(r.status).toBe("not-checked");
    expect(r.stops.get("p1")?.webDetails).toEqual({ checked: false });
  });

  it("uses the injected clock for checkedAt", async () => {
    const t = Date.parse("2025-03-01T10:00:00Z");
    const fetchImpl: SearxngFetch = async () =>
      okRes({ results: [result(1, "Amber Fort entry fee is INR 100 per person for Indian visitors in Jaipur.")] });
    const r = await enrichStops([sight("p1", "Amber Fort")], CTX, deps(fetchImpl, { now: () => t }));
    expect(r.stops.get("p1")?.price?.checkedAt).toBe("2025-03-01T10:00:00.000Z");
  });
});

describe("extractExcerpt", () => {
  const set = (text: string): EvidenceSet => ({
    key: "k",
    kind: "entry-fee",
    checkedAtMs: 0,
    snippets: [{ title: "T", text, url: "https://a.example.org/x", host: "a.example.org" }],
  });

  it("returns the snippet text unchanged", () => {
    const text = "Arrive early to avoid the crowds.";
    expect(extractExcerpt("tip", set(text), "2025-01-01T00:00:00.000Z")?.text).toBe(text);
  });

  it("refuses a text longer than 240 characters and a non-matching text", () => {
    const long = "Arrive early to avoid crowds. " + "x ".repeat(130);
    expect(extractExcerpt("tip", set(long), "2025-01-01T00:00:00.000Z")).toBeUndefined();
    expect(extractExcerpt("booking", set("Nice view."), "2025-01-01T00:00:00.000Z")).toBeUndefined();
  });

  it("returns undefined for an undefined set", () => {
    expect(extractExcerpt("bestTime", undefined, "2025-01-01T00:00:00.000Z")).toBeUndefined();
  });
});
