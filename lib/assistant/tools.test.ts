import { afterEach, describe, expect, it, vi } from "vitest";
import * as fc from "fast-check";
import type { Itinerary } from "../types";
import { TOOL_NAMES, dispatchTool, type ToolContext, type ToolDeps } from "./tools";
import type { PlaceRecord, WireItinerary } from "./types";

// ---------- fixtures (fake providers only; no network) ----------

const itinerary: Itinerary = {
  title: "Trip",
  totalCost: 0,
  days: [
    {
      day: 1,
      date: "2030-01-05",
      title: "D1",
      theme: "",
      total: 0,
      activities: [
        { time: "09:00", title: "Fort", description: "d", cost: 0, placeId: "a" },
        { time: "13:00", title: "Market", description: "d", cost: 0, placeId: "b" },
      ],
    },
  ],
} as unknown as Itinerary;

const wire: WireItinerary = {
  title: "Trip",
  totalCost: 0,
  days: [
    {
      day: 1,
      date: "2030-01-05",
      title: "D1",
      theme: "",
      total: 0,
      activities: [
        { time: "09:00", title: "Fort", description: "d", cost: 0, placeId: "a" },
        { time: "13:00", title: "Market", description: "d", cost: 0, placeId: "b" },
      ],
    },
  ],
};

function place(placeId: string): PlaceRecord {
  return {
    placeId,
    name: `Place ${placeId}`,
    address: "1 Road",
    location: { lat: 15.5, lng: 73.8 },
    mapsUrl: `https://www.google.com/maps/place/?q=place_id:${placeId}`,
  };
}

const NOT_CHECKED = { status: "not-checked", stops: new Map(), queries: 0, sources: [], unavailable: false };

function makeSpies() {
  return {
    searchPlaces: vi.fn(async () => ({ status: "unavailable" })),
    fetchPlace: vi.fn(async () => null),
    webSearch: vi.fn(async () => ({ status: "unavailable" })),
    enrich: vi.fn(async () => NOT_CHECKED),
    newId: vi.fn(() => "id-1"),
  };
}
type Spies = ReturnType<typeof makeSpies>;

function makeCtx(spies: Spies, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    itinerary,
    wire,
    context: { destination: "Goa" } as ToolContext["context"],
    allowList: new Set(["a", "b"]),
    proposals: [],
    offered: [],
    sources: [],
    degraded: new Set(),
    remainingMs: 10_000,
    deps: spies as unknown as ToolDeps,
    ...overrides,
  };
}

function expectNoProviderCalls(s: Spies) {
  expect(s.searchPlaces).not.toHaveBeenCalled();
  expect(s.fetchPlace).not.toHaveBeenCalled();
  expect(s.webSearch).not.toHaveBeenCalled();
  expect(s.enrich).not.toHaveBeenCalled();
  expect(s.newId).not.toHaveBeenCalled();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ---------- Property 12 ----------

const nonObject = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.array(fc.integer(), { maxLength: 3 }),
);
const extraKey = fc.string({ minLength: 1, maxLength: 8 }).map((s) => `zz_${s}`);
const badQuery = fc.oneof(
  fc.constant(undefined),
  fc.constant(""),
  fc.constant("   "),
  fc.integer(),
  fc.constant("line\nbreak"),
  fc.integer({ min: 121, max: 300 }).map((n) => "x".repeat(n)),
);
const badDay = fc.oneof(
  fc.constant(0),
  fc.constant(31),
  fc.integer({ min: -50, max: -1 }),
  fc.integer({ min: 32, max: 500 }),
  fc.constant(1.5),
  fc.constant("1"),
);

const invalidArgsByTool: Record<string, fc.Arbitrary<unknown>> = {
  get_itinerary_summary: fc.oneof(
    nonObject,
    badDay.map((day) => ({ day })),
    extraKey.map((k) => ({ [k]: 1 })),
  ),
  get_profile: fc.oneof(nonObject, extraKey.map((k) => ({ [k]: 1 }))),
  search_places: fc.oneof(
    nonObject,
    badQuery.map((query) => ({ query })),
    fc.record({ query: fc.constant("cafe"), day: badDay }),
    fc.record({ query: fc.constant("cafe"), includeExisting: fc.oneof(fc.string(), fc.integer()) }),
    extraKey.map((k) => ({ query: "cafe", [k]: 1 })),
  ),
  web_search: fc.oneof(
    nonObject,
    badQuery.map((query) => ({ query })),
    extraKey.map((k) => ({ query: "hours", [k]: 1 })),
  ),
  price_lookup: fc.oneof(
    nonObject,
    fc.record({ placeId: fc.constant("a"), name: fc.constant("Fort"), kind: fc.oneof(fc.string(), fc.integer()) }).filter(
      (o) => o.kind !== "sight" && o.kind !== "meal",
    ),
    fc.record({ placeId: fc.oneof(fc.constant(""), fc.integer()), name: fc.constant("Fort"), kind: fc.constant("sight") }),
    fc.record({ placeId: fc.constant("a"), name: badQuery, kind: fc.constant("meal") }),
  ),
  propose_edit: fc.oneof(
    nonObject,
    fc.record({ summary: fc.oneof(badQuery.filter((q) => typeof q !== "string" || q.length < 121), fc.integer({ min: 201, max: 400 }).map((n) => "x".repeat(n))), edit: fc.constant({ op: "remove", day: 1, index: 0, expectTitle: "Fort" }) }),
    fc.record({
      summary: fc.constant("Remove it"),
      edit: fc.oneof(
        fc.string().filter((s) => !["add", "replace", "remove", "move", "retime"].includes(s)).map((op) => ({ op, day: 1 })),
        badDay.map((day) => ({ op: "remove", day, index: 0, expectTitle: "Fort" })),
        fc.constant({ op: "retime", day: 1, index: 0, expectTitle: "Fort", time: "25:99" }),
        fc.constant({ op: "add", day: 1 }),
        fc.constant({ op: "remove", day: 1, index: 0 }),
        fc.constant({ op: "remove", day: 1, index: 0, expectTitle: "Fort", placeId: "x" }),
        nonObject,
      ),
    }),
    extraKey.map((k) => ({ summary: "s", edit: { op: "remove", day: 1, index: 0, expectTitle: "Fort" }, [k]: 1 })),
  ),
};

describe("dispatchTool (Property 12)", () => {
  it("covers every declared tool with an invalid-argument generator", () => {
    expect(Object.keys(invalidArgsByTool).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("unknown tool names return an error and never call a provider", async () => {
    // Feature: trip-assistant-chat, Property 12: Tool dispatch refuses unknown tools and invalid arguments
    await fc.assert(
      fc.asyncProperty(
        fc.string().filter((n) => !(TOOL_NAMES as readonly string[]).includes(n)),
        fc.anything(),
        async (name, input) => {
          const spies = makeSpies();
          const ctx = makeCtx(spies);
          const res = await dispatchTool(name, input, ctx);
          expect(res.ok).toBe(false);
          expect(typeof (res as { error?: unknown }).error).toBe("string");
          expectNoProviderCalls(spies);
          expect(ctx.proposals).toHaveLength(0);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("invalid arguments for each declared tool return an error and never call a provider", async () => {
    // Feature: trip-assistant-chat, Property 12: Tool dispatch refuses unknown tools and invalid arguments
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const name of TOOL_NAMES) {
      await fc.assert(
        fc.asyncProperty(invalidArgsByTool[name], async (input) => {
          const spies = makeSpies();
          const ctx = makeCtx(spies);
          const res = await dispatchTool(name, input, ctx);
          expect(res.ok).toBe(false);
          expect(typeof (res as { error?: unknown }).error).toBe("string");
          expectNoProviderCalls(spies);
          expect(ctx.proposals).toHaveLength(0);
          expect(ctx.sources).toHaveLength(0);
        }),
        { numRuns: 100 },
      );
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------- propose_edit allow-list and fresh lookup ----------

describe("propose_edit", () => {
  const addEdit = (placeId: string) => ({
    summary: "Add a nice place",
    edit: { op: "add", day: 1, placeId },
  });

  it("rejects a placeId that is not allow-listed and stores no proposal", async () => {
    const spies = makeSpies();
    spies.fetchPlace.mockImplementation(async () => place("not-listed") as never);
    const ctx = makeCtx(spies);
    const res = await dispatchTool("propose_edit", addEdit("not-listed"), ctx);
    expect(res).toMatchObject({ ok: true, accepted: false });
    expect(ctx.proposals).toHaveLength(0);
    expect(spies.fetchPlace).not.toHaveBeenCalled();
  });

  it("rejects a non-allow-listed placeId for replace", async () => {
    const spies = makeSpies();
    const ctx = makeCtx(spies);
    const res = await dispatchTool(
      "propose_edit",
      { summary: "Swap", edit: { op: "replace", day: 1, index: 0, expectTitle: "Fort", placeId: "nope" } },
      ctx,
    );
    expect(res).toMatchObject({ ok: true, accepted: false });
    expect(ctx.proposals).toHaveLength(0);
    expect(spies.fetchPlace).not.toHaveBeenCalled();
  });

  it("accepts an allow-listed id when the fresh lookup returns that place", async () => {
    const spies = makeSpies();
    spies.fetchPlace.mockImplementation(async () => place("p1") as never);
    const ctx = makeCtx(spies, { allowList: new Set(["a", "b", "p1"]) });
    const res = await dispatchTool("propose_edit", addEdit("p1"), ctx);
    expect(res).toMatchObject({ ok: true, accepted: true, proposalId: "id-1" });
    expect(ctx.proposals).toHaveLength(1);
    expect(ctx.proposals[0].place?.placeId).toBe("p1");
    expect(spies.fetchPlace).toHaveBeenCalledTimes(1);
  });

  it("rejects an allow-listed id when the fresh lookup returns null", async () => {
    const spies = makeSpies();
    const ctx = makeCtx(spies, { allowList: new Set(["a", "b", "p1"]) });
    const res = await dispatchTool("propose_edit", addEdit("p1"), ctx);
    expect(res).toMatchObject({ ok: true, accepted: false });
    expect(ctx.proposals).toHaveLength(0);
    expect(spies.fetchPlace).toHaveBeenCalledTimes(1);
  });

  it("rejects an allow-listed id when the fresh lookup returns a different placeId", async () => {
    const spies = makeSpies();
    spies.fetchPlace.mockImplementation(async () => place("other") as never);
    const ctx = makeCtx(spies, { allowList: new Set(["a", "b", "p1"]) });
    const res = await dispatchTool("propose_edit", addEdit("p1"), ctx);
    expect(res).toMatchObject({ ok: true, accepted: false });
    expect(ctx.proposals).toHaveLength(0);
  });
});

// ---------- provider failures and citations ----------

describe("provider failures", () => {
  it("search_places returns unavailable when the places provider fails", async () => {
    const spies = makeSpies();
    const ctx = makeCtx(spies);
    const res = await dispatchTool("search_places", { query: "beach cafe" }, ctx);
    expect(res).toMatchObject({ ok: true, status: "unavailable" });
    expect(ctx.degraded.has("places")).toBe(true);
    expect(ctx.offered).toHaveLength(0);
  });

  it("search_places returns unavailable when the places provider throws", async () => {
    const spies = makeSpies();
    spies.searchPlaces.mockImplementation(async () => {
      throw new Error("boom");
    });
    const ctx = makeCtx(spies);
    const res = await dispatchTool("search_places", { query: "beach cafe" }, ctx);
    expect(res).toMatchObject({ ok: true, status: "unavailable" });
  });

  it("web_search returns unavailable without a fetch when the web flags are off", async () => {
    vi.stubEnv("TRIPGENIE_SEARXNG_ENABLED", "");
    vi.stubEnv("TRIPGENIE_WEB_PRICING_ENABLED", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    // No deps.webSearch: the default path goes through webSearchForAssistant, which checks the flags.
    const ctx = makeCtx(makeSpies(), { deps: {} });
    const res = await dispatchTool("web_search", { query: "fort opening hours" }, ctx);
    expect(res).toMatchObject({ ok: true, status: "unavailable" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ctx.degraded.has("web")).toBe(true);
    expect(ctx.sources).toHaveLength(0);
  });

  it("web_search stays unavailable when only one flag is on", async () => {
    vi.stubEnv("TRIPGENIE_SEARXNG_ENABLED", "true");
    vi.stubEnv("TRIPGENIE_WEB_PRICING_ENABLED", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const ctx = makeCtx(makeSpies(), { deps: {} });
    const res = await dispatchTool("web_search", { query: "fort opening hours" }, ctx);
    expect(res).toMatchObject({ ok: true, status: "unavailable" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("price_lookup returns price null when the citation is rejected", async () => {
    const spies = makeSpies();
    spies.enrich.mockImplementation(async () => ({
      status: "ok",
      stops: new Map([
        [
          "a",
          {
            placeId: "a",
            webDetails: { checked: true },
            // http (not https) and host mismatch: must not survive the citation check.
            price: { inr: 500, sourceUrl: "http://example.com/x", sourceHost: "other.com", checkedAt: "2030-01-01T00:00:00Z", basis: "b", kind: "entry" },
          },
        ],
      ]),
      queries: 1,
      sources: [],
      unavailable: false,
    }) as never);
    const ctx = makeCtx(spies);
    const res = await dispatchTool("price_lookup", { placeId: "a", name: "Fort", kind: "sight" }, ctx);
    expect(res).toMatchObject({ ok: true, status: "ok", price: null });
    expect(ctx.sources).toHaveLength(0);
  });

  it("price_lookup returns the cited price when the citation is valid", async () => {
    const spies = makeSpies();
    spies.enrich.mockImplementation(async () => ({
      status: "ok",
      stops: new Map([
        [
          "a",
          {
            placeId: "a",
            webDetails: { checked: true },
            price: { inr: 500, sourceUrl: "https://example.com/x", sourceHost: "example.com", checkedAt: "2030-01-01T00:00:00Z", basis: "adult entry", kind: "entry" },
          },
        ],
      ]),
      queries: 1,
      sources: [],
      unavailable: false,
    }) as never);
    const ctx = makeCtx(spies);
    const res = (await dispatchTool("price_lookup", { placeId: "a", name: "Fort", kind: "sight" }, ctx)) as unknown as {
      price: { inr: number; ref: string } | null;
    };
    expect(res.price).toMatchObject({ inr: 500, ref: "S1" });
    expect(ctx.sources).toHaveLength(1);
  });
});
