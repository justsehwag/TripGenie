import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { BATCH_LOG_TAG, runItineraryBatch, type BatchDeps } from "../lib/itinerary/batch-service";
import type { BatchRequest, BatchResponse } from "../lib/itinerary/batch-wire";
import { clearGroundingMemo } from "../lib/itinerary/grounding-memo";
import { createVerificationCache } from "../lib/itinerary/verification-cache";
import {
  MAX_VERIFY_LOOKUPS_PER_BATCH,
  MIN_STEP_MS,
  REPAIR_MIN_MS,
  RESPONSE_MARGIN_MS,
  VERIFY_BUDGET_MS,
} from "../lib/itinerary/constants";
import { isSafeMapsUrl } from "../lib/itinerary/maps-link";
import type { ModelPrompt } from "../lib/bedrock-model";
import type { GroundingBundle } from "../lib/grounding/types";
import type { PostFetchLike } from "../lib/providers/google-places";
import type { TripContext } from "../lib/types";

// Feature: trustworthy-itinerary (batch service)
// Validates: Requirements 2.15, 5.3, 5.4, 5.5, 5.12, 5.13, 6.2, 6.4, 13.1, 13.2, 13.3, 13.6, 15.1, 15.2, 15.3, 15.4

const NUM_RUNS = 100;
const KEY_ENV = "GOOGLE_PLACES_API_KEY";
const TEST_KEY = "test-key-not-real-SECRETKEY";
const T0 = 1_000_000;
const CENTRE = { lat: 10, lng: 20 };
const LOG_RE =
  /^\[itinerary-batch\] days=(\d+)-(\d+) proposed=(\d+) verified=(\d+) removed=(\d+) ms=(\d+) outcome=([a-z-]+)$/;

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env[KEY_ENV];
  process.env[KEY_ENV] = TEST_KEY;
  clearGroundingMemo();
});
afterEach(() => {
  if (savedKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = savedKey;
  clearGroundingMemo();
  vi.clearAllTimers();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Names and scenario types
// ---------------------------------------------------------------------------

const FIRSTS = ["Aurelia", "Brightwater", "Cedar", "Dunmore", "Eastgate", "Fernhill", "Glenmarrow", "Harrow", "Ivory", "Juniper"];
const NOUNS = ["Fort", "Museum", "Gardens", "Cathedral", "Lighthouse", "Observatory", "Palace", "Bridge"];
const NAMES: string[] = FIRSTS.flatMap((f) => NOUNS.map((n) => `${f} ${n}`));
const TIMES = ["09:00", "11:30", "14:00", "16:30", "19:00"];

type PlaceMode = "ok" | "none" | "wrong" | "far" | "nonok" | "throw" | "hang" | "dirty";
type Model1Mode = "good" | "cut" | "malformed" | "empty" | "throw" | "hang" | "dirty";
type Model2Mode = "good" | "malformed" | "empty" | "throw" | "hang";
type DetailsMode = "ok" | "fail" | "hang";

interface Hostile {
  title: string;
  area: string;
  description: string;
  time: string;
}

interface Scenario {
  totalDays: number;
  dayCount: number;
  fromDay: number;
  pace: string;
  hasKey: boolean;
  budgetMs: number;
  groundLatency: number;
  groundThrow: boolean;
  model1: { mode: Model1Mode; latency: number };
  model2: { mode: Model2Mode; latency: number };
  stops: number[];
  table: PlaceMode[];
  placeLatency: number;
  detailsMode: DetailsMode;
  centreOk: boolean;
  hostile: Hostile;
}

interface FetchRec {
  at: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  keys: string[];
  textQuery: string;
  kind: "search" | "centre" | "details";
}
interface ModelRec {
  at: number;
  timeoutMs: number;
  settledAt?: number;
}

interface Outcome {
  res: BatchResponse;
  req: BatchRequest;
  total: number;
  start: number;
  end: number;
  budgetMs: number;
  fetches: FetchRec[];
  models: ModelRec[];
  logs: string[];
  dest: string;
  proposed: Set<string>;
  used: string[];
}

let worldNo = 0;

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

function actJson(place: string, i: number, h?: Hostile, area = "Harbour Quarter") {
  return {
    time: h ? h.time : TIMES[i % TIMES.length],
    place,
    area: h ? h.area : area,
    kind: "sight",
    description: h ? h.description : "A good stop",
    cost: 10,
    debug: "RAWMODELSECRET",
  };
}

function dayJson(abs: number, offset: number, n: number, h?: Hostile) {
  const names = Array.from({ length: n }, (_, s) => NAMES[offset * 5 + s]);
  return {
    title: h ? h.title : `Highlights of day ${abs}`,
    dayTrip: false,
    activities: names.map((p, i) => actJson(p, i, h)),
    debug: "RAWMODELSECRET",
  };
}

/** When set, the first model call returns exactly this text. */
let OVERRIDE_TEXT: string | null = null;

function modelText(scn: Scenario, mode: Model1Mode): string {
  if (OVERRIDE_TEXT !== null) return OVERRIDE_TEXT;
  const days = Array.from({ length: scn.dayCount }, (_, i) =>
    dayJson(scn.fromDay + i, i, scn.stops[i] ?? 3, mode === "dirty" ? scn.hostile : undefined),
  );
  if (mode === "good" || mode === "dirty") return JSON.stringify({ days, note: "RAWMODELSECRET" });
  if (mode === "cut") {
    const text = JSON.stringify({ days });
    return text.slice(0, Math.max(1, Math.floor(text.length * 0.7)));
  }
  if (mode === "malformed") return "not json at all {{ RAWMODELSECRET";
  return "";
}

function repairText(scn: Scenario, mode: Model2Mode): string {
  if (mode === "malformed") return "{{ RAWMODELSECRET";
  if (mode === "empty") return "";
  const reps: unknown[] = [];
  for (let i = 0; i < scn.dayCount; i++) {
    for (let slot = 0; slot < 5; slot++) {
      reps.push({
        day: scn.fromDay + i,
        slot,
        activity: actJson(NAMES[40 + i * 5 + slot], slot),
      });
    }
  }
  return JSON.stringify({ replacements: reps });
}

function proposedNames(): Set<string> {
  return new Set(NAMES);
}

function groundBundle(): GroundingBundle {
  return {
    status: "ok",
    droppedCount: 0,
    snippets: [
      { title: "Local guide to the old town", snippet: "Quiet lanes and markets.", url: "https://guide.example.org/old-town", host: "guide.example.org" },
    ],
  };
}

async function execute(scn: Scenario, opts: { budgetMs?: number } = {}): Promise<Outcome> {
  worldNo += 1;
  const dest = `Testville${worldNo}`;
  const tag = `tg${worldNo}`;
  const budgetMs = opts.budgetMs ?? scn.budgetMs;
  const used = [`Used <b> SECRETUSED ${worldNo}`];
  const context = {
    origin: "SECRETORIGIN",
    destination: dest,
    durationDays: scn.totalDays,
    travellers: { adults: 7, children: 3 },
    budgetLevel: "mid",
    diet: "SECRETDIET",
    pace: scn.pace,
    interests: ["SECRETINTEREST <script>"],
  } as unknown as TripContext;
  const req: BatchRequest = {
    action: "itinerary-batch",
    context,
    fromDay: scn.fromDay,
    dayCount: scn.dayCount,
    usedPlaces: used,
    startDate: "2031-02-03",
  };

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(T0);
  const fetches: FetchRec[] = [];
  const models: ModelRec[] = [];
  const logs: string[] = [];

  const fetchImpl: PostFetchLike = async (url, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    let parsed: { textQuery?: unknown; maxResultCount?: unknown } = {};
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      // GET: no body
    }
    const method = init?.method ?? "GET";
    const textQuery = typeof parsed.textQuery === "string" ? parsed.textQuery : "";
    const isSearch = method === "POST" && typeof parsed.maxResultCount === "number";
    const kind: FetchRec["kind"] = method !== "POST" ? "details" : isSearch ? "search" : "centre";
    fetches.push({
      at: Date.now(),
      method,
      url,
      headers: { ...(init?.headers ?? {}) },
      body,
      keys: Object.keys(parsed).sort(),
      textQuery,
      kind,
    });
    const signal = init?.signal ?? null;
    if (kind === "details") {
      await sleep(scn.placeLatency, signal);
      if (scn.detailsMode === "hang") await sleep(10 * 60_000, signal);
      if (scn.detailsMode === "fail") return { ok: false, status: 500, json: async () => ({}) };
      const id = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
      return { ok: true, status: 200, json: async () => ({ id, photos: [{ name: `places/${id}/photos/ph1` }] }) };
    }
    if (kind === "centre") {
      await sleep(scn.placeLatency, signal);
      if (!scn.centreOk || textQuery !== dest) return { ok: false, status: 500, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ places: [{ id: `${tag}-centre`, location: { latitude: CENTRE.lat, longitude: CENTRE.lng } }] }),
      };
    }
    const suffix = `, ${dest}`;
    if (!textQuery.endsWith(suffix)) return { ok: false, status: 400, json: async () => ({}) };
    const place = textQuery.slice(0, textQuery.length - suffix.length);
    const idx = NAMES.indexOf(place);
    const n = idx < 0 ? 90 : idx;
    await sleep(scn.placeLatency + (n % 3) * 300, signal);
    const mode = scn.table[n % scn.table.length];
    if (mode === "throw") throw new Error("PLACES-ERR-SECRET");
    if (mode === "hang") await sleep(10 * 60_000, signal);
    if (mode === "nonok") return { ok: false, status: 503, json: async () => ({}) };
    const id = `${tag}-${n}`;
    const loc =
      mode === "far"
        ? { latitude: CENTRE.lat + 5, longitude: CENTRE.lng }
        : { latitude: CENTRE.lat + (n % 7) * 0.01, longitude: CENTRE.lng + (n % 5) * 0.01 };
    const name = mode === "wrong" ? "Unrelated Garage" : mode === "dirty" ? `${place} <b>\u0007 big\t\n  <i>name</i>` : place;
    const places =
      mode === "none"
        ? []
        : [{ id, displayName: { text: name }, formattedAddress: `${place}, Old Town, ${dest}, Testland`, location: loc }];
    return { ok: true, status: 200, json: async () => ({ places }) };
  };

  const invokeModel = async (prompt: ModelPrompt): Promise<string> => {
    const rec: ModelRec = { at: Date.now(), timeoutMs: prompt.timeoutMs };
    models.push(rec);
    const first = models.length === 1;
    const { mode, latency } = first ? scn.model1 : scn.model2;
    if (mode === "hang") return new Promise<string>(() => undefined);
    await sleep(latency);
    rec.settledAt = Date.now();
    if (mode === "throw") throw new Error("BEDROCK-ERR-SECRET");
    return first ? modelText(scn, mode as Model1Mode) : repairText(scn, mode as Model2Mode);
  };

  const ground = async (): Promise<GroundingBundle> => {
    await sleep(scn.groundLatency);
    if (scn.groundThrow) throw new Error("GROUND-ERR-SECRET");
    return groundBundle();
  };

  const deps: BatchDeps = {
    invokeModel,
    fetchImpl,
    now: () => Date.now(),
    hasKey: () => scn.hasKey,
    ground,
    verificationCache: createVerificationCache(),
    logger: (l) => logs.push(l),
    budgetMs,
  };

  const start = Date.now();
  let end = -1;
  let res: BatchResponse | undefined;
  let threw: unknown;
  runItineraryBatch(req, scn.totalDays, deps).then(
    (r) => {
      res = r;
      end = Date.now();
    },
    (e) => {
      threw = e;
      end = Date.now();
    },
  );
  for (let i = 0; i < 1000 && end < 0; i++) await vi.advanceTimersByTimeAsync(100);
  vi.clearAllTimers();
  vi.useRealTimers();
  if (threw !== undefined) throw new Error("runItineraryBatch rejected");
  if (end < 0 || !res) throw new Error("runItineraryBatch did not settle");
  return { res, req, total: scn.totalDays, start, end, budgetMs, fetches, models, logs, dest, proposed: proposedNames(), used };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const hostileText = fc.oneof(
  fc.string({ unit: "binary", maxLength: 120 }),
  fc.constantFrom(
    "<script>alert(1)</script>",
    "\u0000\u0007x\ty\nz\u0085",
    "x".repeat(500),
    "\ud800lone\udc00",
    "  spaced   out  \u2028 text ",
    "a\u200bb\ufeffc",
  ),
);
const hostileArb: fc.Arbitrary<Hostile> = fc.record({
  title: hostileText,
  area: hostileText,
  description: hostileText,
  time: hostileText,
});

const placeModeArb = fc.constantFrom<PlaceMode>("ok", "ok", "ok", "ok", "none", "wrong", "far", "nonok", "throw", "hang", "dirty");
const latencyArb = fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 3000 }));

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    totalDays: fc.integer({ min: 3, max: 8 }),
    dayCount: fc.integer({ min: 1, max: 3 }),
    fromOff: fc.nat(10),
    pace: fc.constantFrom("relaxed", "balanced", "packed"),
    hasKey: fc.constantFrom(true, true, true, true, true, true, true, true, true, false),
    budgetMs: fc.constantFrom(2000, 9000, 14000, 25000),
    groundLatency: latencyArb,
    groundThrow: fc.constantFrom(false, false, false, true),
    model1: fc.record({
      mode: fc.constantFrom<Model1Mode>("good", "good", "good", "cut", "malformed", "empty", "throw", "hang", "dirty"),
      latency: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 14000 })),
    }),
    model2: fc.record({
      mode: fc.constantFrom<Model2Mode>("good", "good", "malformed", "empty", "throw", "hang"),
      latency: latencyArb,
    }),
    stops: fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 3, maxLength: 3 }),
    table: fc.array(placeModeArb, { minLength: 8, maxLength: 8 }),
    placeLatency: latencyArb,
    detailsMode: fc.constantFrom<DetailsMode>("ok", "ok", "fail", "hang"),
    centreOk: fc.boolean(),
    hostile: hostileArb,
  })
  .map(({ fromOff, ...rest }) => ({
    ...rest,
    fromDay: 1 + (fromOff % (rest.totalDays - rest.dayCount + 1)),
  }));

// ---------------------------------------------------------------------------
// Invariant checks
// ---------------------------------------------------------------------------

const BAD_CHARS = /[\u0000-\u001f\u007f-\u009f<>]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function cpLen(s: string): number {
  return Array.from(s).length;
}

function assertDisplayText(s: unknown, max?: number): void {
  expect(typeof s).toBe("string");
  const t = s as string;
  expect(BAD_CHARS.test(t)).toBe(false);
  expect(LONE_SURROGATE.test(t)).toBe(false);
  expect(/\s{2,}/.test(t)).toBe(false);
  expect(t).toBe(t.trim());
  if (max !== undefined) expect(cpLen(t)).toBeLessThanOrEqual(max);
}

/** Property 19, response part. */
function assertSanitised(res: BatchResponse): void {
  for (const d of res.days) {
    assertDisplayText(d.title, 80);
    assertDisplayText(d.theme);
    expect(d.date === "" || /^\d{4}-\d{2}-\d{2}$/.test(d.date)).toBe(true);
    for (const a of d.activities) {
      assertDisplayText(a.time, 20);
      assertDisplayText(a.title, 100);
      assertDisplayText(a.placeName ?? "", 100);
      assertDisplayText(a.description, 160);
      assertDisplayText(a.area ?? "", 60);
      expect(BAD_CHARS.test(a.placeId ?? "")).toBe(false);
      expect(BAD_CHARS.test(a.mapsUrl ?? "")).toBe(false);
      expect(BAD_CHARS.test(a.photoRef ?? "")).toBe(false);
    }
  }
  for (const s of res.sources ?? []) {
    assertDisplayText(s.title);
    expect(BAD_CHARS.test(s.url)).toBe(false);
  }
}

/** Property 15 checks. */
function assertBudget(o: Outcome): void {
  expect(o.end - o.start).toBeLessThanOrEqual(o.budgetMs);
  expect(o.models.length).toBeLessThanOrEqual(2);
  const deadline = o.start + o.budgetMs;
  for (const m of o.models) {
    expect(m.timeoutMs).toBeLessThanOrEqual(12_000);
    expect(m.timeoutMs).toBeGreaterThanOrEqual(MIN_STEP_MS);
    expect(m.timeoutMs).toBeLessThanOrEqual(deadline - m.at);
  }
  if (o.models.length === 2) {
    const first = o.models[0];
    expect(first.settledAt).toBeDefined();
    const phaseDeadline = Math.min(first.settledAt! + VERIFY_BUDGET_MS, deadline - RESPONSE_MARGIN_MS);
    expect(phaseDeadline - o.models[1].at).toBeGreaterThanOrEqual(REPAIR_MIN_MS);
  }
  const lookups = o.fetches.filter((f) => f.kind !== "centre").length;
  expect(lookups).toBeLessThanOrEqual(MAX_VERIFY_LOOKUPS_PER_BATCH);
  expect(o.fetches.filter((f) => f.kind === "centre").length).toBeLessThanOrEqual(1);
  for (const f of o.fetches) expect(f.at).toBeLessThanOrEqual(deadline - RESPONSE_MARGIN_MS);
}

/** Property 16 checks. */
function assertContract(o: Outcome): void {
  const { res, req } = o;
  expect(["model", "unavailable"]).toContain(res.source);
  expect(res.fromDay).toBe(req.fromDay);
  expect(res.dayCount).toBe(req.dayCount);
  const range = Array.from({ length: req.dayCount }, (_, i) => req.fromDay + i);
  expect(res.days.map((d) => d.day)).toEqual(res.verifiedDays);
  expect([...res.verifiedDays].sort((a, b) => a - b)).toEqual(res.verifiedDays);
  for (const w of res.withheldDays) expect(res.verifiedDays).not.toContain(w);
  expect([...res.verifiedDays, ...res.withheldDays].sort((a, b) => a - b)).toEqual(range);
  if (res.source === "model") {
    expect(res.days.length).toBeGreaterThanOrEqual(1);
  } else {
    expect(res.days).toEqual([]);
    expect(res.verifiedDays).toEqual([]);
    expect(res.withheldDays).toEqual(range);
    expect(["not-configured", "unavailable", "unverified"]).toContain(res.reason);
  }
  for (const d of res.days) {
    expect(d.activities.length).toBeGreaterThan(0);
    for (const a of d.activities) {
      expect(a.verified).toBe(true);
      expect(typeof a.placeId).toBe("string");
      expect((a.placeId ?? "").length).toBeGreaterThan(0);
      expect(isSafeMapsUrl(a.mapsUrl)).toBe(true);
      expect(Number.isFinite(a.location?.lat)).toBe(true);
      expect(Number.isFinite(a.location?.lng)).toBe(true);
    }
  }
}

/** Property 24 checks. */
function assertPrivacy(o: Outcome): void {
  const secrets = ["SECRETORIGIN", "SECRETDIET", "SECRETINTEREST", "SECRETUSED", "2031", "adults", "children", "script"];
  for (const f of o.fetches) {
    expect(f.url.includes(TEST_KEY)).toBe(false);
    expect(Object.keys(f.headers).every((h) => ["Content-Type", "X-Goog-Api-Key", "X-Goog-FieldMask"].includes(h))).toBe(true);
    const hay = `${f.url}\n${f.body}`;
    for (const s of secrets) expect(hay.includes(s)).toBe(false);
    if (f.kind === "search") {
      expect(f.method).toBe("POST");
      expect(f.keys).toEqual(["maxResultCount", "textQuery"]);
      expect(f.textQuery.endsWith(`, ${o.dest}`)).toBe(true);
      const place = f.textQuery.slice(0, f.textQuery.length - o.dest.length - 2);
      expect(o.proposed.has(place)).toBe(true);
    } else if (f.kind === "centre") {
      expect(f.keys).toEqual(["textQuery"]);
      expect(f.textQuery).toBe(o.dest);
    } else {
      expect(f.body).toBe("");
    }
  }
  const json = JSON.stringify(o.res);
  for (const s of [TEST_KEY, "SECRETKEY", ...secrets.slice(0, 4), "RAWMODELSECRET", "BEDROCK-ERR", "PLACES-ERR", "GROUND-ERR", "Old Town", "Testland"]) {
    expect(json.includes(s)).toBe(false);
  }
  expect(o.logs).toHaveLength(1);
  const line = o.logs[0];
  const m = LOG_RE.exec(line);
  expect(m).not.toBeNull();
  expect(line.startsWith(BATCH_LOG_TAG)).toBe(true);
  const last = o.req.fromDay + o.req.dayCount - 1;
  expect(Number(m![1])).toBe(o.req.fromDay);
  expect(Number(m![2])).toBe(last);
  expect(Number(m![4])).toBe(o.res.stats.verified);
  expect(["ok", "partial", "unavailable", "not-configured", "timeout"]).toContain(m![7]);
  if (o.res.source === "model") expect(m![7]).toBe(o.res.withheldDays.length === 0 ? "ok" : "partial");
  else expect(["unavailable", "not-configured", "timeout"]).toContain(m![7]);
  for (const s of [...NAMES, o.dest, TEST_KEY, "SECRET", "ERR"]) expect(line.includes(s)).toBe(false);
}

function baseScenario(over: Partial<Scenario> = {}): Scenario {
  return {
    totalDays: 3,
    dayCount: 3,
    fromDay: 1,
    pace: "balanced",
    hasKey: true,
    budgetMs: 25_000,
    groundLatency: 0,
    groundThrow: false,
    model1: { mode: "good", latency: 0 },
    model2: { mode: "good", latency: 0 },
    stops: [4, 4, 4],
    table: ["ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok"],
    placeLatency: 0,
    detailsMode: "ok",
    centreOk: true,
    hostile: { title: "<b>T</b>", area: "A\u0007", description: "D<script>", time: "9\n00" },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("runItineraryBatch properties", () => {
  // Feature: trustworthy-itinerary, Property 15: Time budget and call counts
  it("Property 15: stays inside the time budget and call counts", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scn) => {
        clearGroundingMemo();
        const o = await execute(scn);
        assertBudget(o);
      }),
      { numRuns: NUM_RUNS },
    );
  }, 120_000);

  // Feature: trustworthy-itinerary, Property 16: Outcome contract
  it("Property 16: outcome contract holds for any combination of failures", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scn) => {
        clearGroundingMemo();
        const o = await execute(scn);
        assertContract(o);
        if (!scn.hasKey) {
          expect(o.res.source).toBe("unavailable");
          expect(o.res.reason).toBe("not-configured");
          expect(o.models).toHaveLength(0);
          expect(o.fetches).toHaveLength(0);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  }, 120_000);

  // Feature: trustworthy-itinerary, Property 19: Display text sanitising
  it("Property 19: every response string built from model or Places text is sanitised", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scn0) => {
        clearGroundingMemo();
        const scn: Scenario = {
          ...scn0,
          hasKey: true,
          model1: { mode: "dirty", latency: 0 },
          budgetMs: 25_000,
          groundLatency: 0,
          groundThrow: false,
          table: scn0.table.map((m) => (m === "dirty" || m === "ok" ? "dirty" : m)),
          placeLatency: 0,
          detailsMode: "ok",
          centreOk: true,
        };
        const o = await execute(scn);
        assertSanitised(o.res);
        assertContract(o);
      }),
      { numRuns: NUM_RUNS },
    );
  }, 120_000);

  // Feature: trustworthy-itinerary, Property 24: Privacy and logging
  it("Property 24: only place and destination reach Places, one counts-only log line", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scn) => {
        clearGroundingMemo();
        const o = await execute(scn);
        assertPrivacy(o);
      }),
      { numRuns: NUM_RUNS },
    );
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

describe("runItineraryBatch examples", () => {
  it("a missing key makes zero Bedrock calls and zero Places calls", async () => {
    const o = await execute(baseScenario({ hasKey: false }));
    expect(o.models).toHaveLength(0);
    expect(o.fetches).toHaveLength(0);
    expect(o.res.source).toBe("unavailable");
    expect(o.res.reason).toBe("not-configured");
    expect(o.res.withheldDays).toEqual([1, 2, 3]);
    assertPrivacy(o);
    expect(LOG_RE.exec(o.logs[0])![7]).toBe("not-configured");
  });

  it("all days verified gives outcome ok with hero photos and sources on the first batch", async () => {
    const o = await execute(baseScenario());
    assertContract(o);
    assertPrivacy(o);
    assertBudget(o);
    expect(o.res.source).toBe("model");
    expect(o.res.verifiedDays).toEqual([1, 2, 3]);
    expect(o.res.withheldDays).toEqual([]);
    expect(o.res.truncated).toBe(false);
    expect(o.res.sources?.length).toBe(1);
    expect(o.res.days.every((d) => d.activities.some((a) => typeof a.photoRef === "string"))).toBe(true);
    expect(o.res.days[0].date).toBe("2031-02-03");
    expect(LOG_RE.exec(o.logs[0])![7]).toBe("ok");
  });

  it("two good days and a cut third give source model, two verified days, one withheld, truncated", async () => {
    const scn = baseScenario();
    const text = (): string => {
      const d1 = JSON.stringify(dayJson(1, 0, 4));
      const d2 = JSON.stringify(dayJson(2, 1, 4));
      return `{"days":[${d1},${d2},{"title":"Day 3","activities":[{"time":"09:00","place":"${NAMES[10]}`;
    };
    const o = await executeWithText(scn, text());
    assertContract(o);
    assertPrivacy(o);
    expect(o.res.source).toBe("model");
    expect(o.res.verifiedDays).toEqual([1, 2]);
    expect(o.res.withheldDays).toEqual([3]);
    expect(o.res.truncated).toBe(true);
    expect(o.res.days).toHaveLength(2);
    expect(LOG_RE.exec(o.logs[0])![7]).toBe("partial");
  });

  it("no verified day gives unavailable with reason unverified", async () => {
    const o = await execute(baseScenario({ table: ["none", "none", "none", "none", "none", "none", "none", "none"] }));
    assertContract(o);
    assertPrivacy(o);
    expect(o.res.source).toBe("unavailable");
    expect(o.res.reason).toBe("unverified");
    expect(o.res.days).toEqual([]);
    expect(o.res.withheldDays).toEqual([1, 2, 3]);
    expect(o.models.length).toBeLessThanOrEqual(2);
  });

  it("a hanging model returns unavailable within the budget", async () => {
    const o = await execute(baseScenario({ model1: { mode: "hang", latency: 0 } }));
    assertContract(o);
    assertBudget(o);
    expect(o.res.source).toBe("unavailable");
    expect(o.end - o.start).toBeLessThanOrEqual(25_000);
  });

  it("a budget too small for generation makes no Bedrock call", async () => {
    const o = await execute(baseScenario(), { budgetMs: 9_000 });
    assertContract(o);
    expect(o.models).toHaveLength(0);
    expect(o.res.source).toBe("unavailable");
    expect(o.logs).toHaveLength(1);
  });
});

/** Runs a scenario whose first model reply is the given exact text. */
async function executeWithText(scn: Scenario, text: string): Promise<Outcome> {
  OVERRIDE_TEXT = text;
  try {
    return await execute({ ...scn, model1: { mode: "good", latency: 0 } });
  } finally {
    OVERRIDE_TEXT = null;
  }
}
