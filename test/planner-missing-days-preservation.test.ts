import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { runItineraryBatch, type BatchDeps } from "../lib/itinerary/batch-service";
import { readBatchResponse, unavailable, type BatchReason, type BatchRequest, type BatchResponse } from "../lib/itinerary/batch-wire";
import { clearGroundingMemo } from "../lib/itinerary/grounding-memo";
import { createVerificationCache } from "../lib/itinerary/verification-cache";
import { nameKey } from "../lib/itinerary/place-key";
import { buildMapsUrl } from "../lib/itinerary/maps-link";
import { EMPTY_BUNDLE } from "../lib/grounding/types";
import { AUTO_RETRY_MAX, MAX_TRIP_DAYS } from "../lib/itinerary/constants";
import {
  batchReducer,
  buildRequest,
  initBatchState,
  nextSlot,
  type BatchEvent,
  type BatchState,
} from "../lib/itinerary/planner-batches";
import type { PostFetchLike } from "../lib/providers/google-places";
import type { Activity, TripContext, TripDay } from "../lib/types";

// Preservation tests for planner-missing-days. They pin what the UNFIXED
// planner does outside the bug condition and must pass before and after the fix.

const DEST = "Goa";
const CENTRE = { lat: 15.4989, lng: 73.8278 };
const DETAILS_BASE = "https://places.googleapis.com/v1/places/";
const KEY = "trip-key-preservation";
const TOTAL = 4;
const LOG_RE =
  /^\[itinerary-batch\] days=(\d+)-(\d+) proposed=(\d+) verified=(\d+) removed=(\d+) ms=(\d+) outcome=(ok|partial|unavailable|not-configured|timeout)$/;

beforeEach(() => {
  vi.stubEnv("GOOGLE_PLACES_API_KEY", "test-key");
  clearGroundingMemo();
});
afterEach(() => {
  vi.unstubAllEnvs();
  clearGroundingMemo();
});

type Mode = "match" | "nomatch";

/** Places API (New) shaped fake: centre lookup, details, searchText. "Ghost" places never exist. */
function makeFetch(mode: Mode): PostFetchLike {
  return async (url, init) => {
    if (url.startsWith(DETAILS_BASE)) {
      const id = decodeURIComponent(url.slice(DETAILS_BASE.length));
      return { ok: true, status: 200, json: async () => ({ id, photos: [{ name: `places/${id}/photos/ph1` }] }) };
    }
    let parsed: { textQuery?: unknown; maxResultCount?: unknown } = {};
    try {
      parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as typeof parsed;
    } catch {
      parsed = {};
    }
    const q = typeof parsed.textQuery === "string" ? parsed.textQuery : "";
    if (typeof parsed.maxResultCount !== "number") {
      if (q !== DEST) return { ok: false, status: 500, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ places: [{ id: "centre", location: { latitude: CENTRE.lat, longitude: CENTRE.lng } }] }),
      };
    }
    const suffix = `, ${DEST}`;
    if (!q.endsWith(suffix)) return { ok: false, status: 400, json: async () => ({}) };
    const place = q.slice(0, q.length - suffix.length);
    if (mode === "nomatch" || /^ghost/i.test(place)) return { ok: true, status: 200, json: async () => ({}) };
    const id = `p-${nameKey(place).replace(/\s+/g, "-")}`;
    let n = 0;
    for (const ch of id) n += ch.charCodeAt(0);
    const near = { latitude: CENTRE.lat + (n % 7) * 0.003, longitude: CENTRE.lng + (n % 5) * 0.003 };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        places: [{ id, displayName: { text: place }, formattedAddress: `${place}, Candolim, ${DEST}, India`, location: near }],
      }),
    };
  };
}

const FIRSTS = ["Aurelia", "Brightwater", "Cedar", "Dunmore", "Eastgate", "Fernhill", "Glenmarrow", "Harrow", "Ivory", "Juniper"];
const NOUNS = ["Fort", "Museum", "Gardens", "Cathedral", "Lighthouse", "Observatory", "Palace", "Bridge"];
const placeName = (i: number) => `${FIRSTS[i % FIRSTS.length]} ${NOUNS[Math.floor(i / FIRSTS.length) % NOUNS.length]}`;

const act = (place: string, i: number) => ({
  time: `${9 + i * 2}:00`.padStart(5, "0"),
  place,
  area: "Area",
  kind: "sight",
  description: `A visit to ${place}`,
  cost: 100,
});
type ModelDay = { title: string; places: string[] };
const modelText = (days: ModelDay[]) =>
  JSON.stringify({ days: days.map((d) => ({ title: d.title, dayTrip: false, activities: d.places.map(act) })) });

/** Scripted two-batch trip: days 1-3 then day 4. Balanced: day 1 and 4 hold 2 stops, days 2-3 hold 4. */
function batchTexts(titles: string[] = ["Old Goa", "North coast", "South coast", "Farewell"], day3Ghost = false): string[] {
  let c = 0;
  const take = (n: number) => Array.from({ length: n }, () => placeName(c++));
  const d1 = take(2);
  const d2 = take(4);
  const d3 = day3Ghost ? ["Ghost Tower", "Ghost Harbour", "Ghost Market", "Ghost Temple"] : take(4);
  const d4 = take(2);
  return [
    modelText([
      { title: titles[0], places: d1 },
      { title: titles[1], places: d2 },
      { title: titles[2], places: d3 },
    ]),
    modelText([{ title: titles[3], places: d4 }]),
  ];
}

const CONTEXT = {
  origin: "Delhi",
  destination: DEST,
  durationDays: TOTAL,
  budgetLevel: "mid",
  pace: "balanced",
  travellers: { adults: 2, children: 0 },
  interests: ["culture"],
} as unknown as TripContext;

interface Driven {
  state: BatchState;
  requests: BatchRequest[];
  responses: BatchResponse[];
  modelCalls: number;
  logs: string[];
  diag: string[];
  placesCalls: number;
}

/** Mimics the planner driver effect: request, call the service, dispatch the response. */
async function drive(
  texts: string[],
  mode: Mode,
  opts: { hasKey?: () => boolean; autoRetryNoop?: boolean } = {},
): Promise<Driven> {
  const out: Driven = { state: initBatchState(), requests: [], responses: [], modelCalls: 0, logs: [], diag: [], placesCalls: 0 };
  const inner = makeFetch(mode);
  const fetchImpl: PostFetchLike = async (u, i) => {
    out.placesCalls += 1;
    return inner(u, i);
  };
  const deps: BatchDeps = {
    invokeModel: async (p) => {
      if (p.system.includes("SLOTS TO REPLACE")) return '{"replacements":[]}';
      const t = texts[Math.min(out.modelCalls, texts.length - 1)];
      out.modelCalls += 1;
      return t;
    },
    fetchImpl,
    ground: async () => EMPTY_BUNDLE("disabled"),
    verificationCache: createVerificationCache(),
    logger: (l) => out.logs.push(l),
    diagLogger: (l) => out.diag.push(l),
    ...(opts.hasKey ? { hasKey: opts.hasKey } : {}),
  };
  let s = batchReducer(initBatchState(), { type: "start", tripKey: KEY, totalDays: TOTAL });
  let guard = 0;
  for (let slot = nextSlot(s); slot && guard < 12; slot = nextSlot(s), guard++) {
    s = batchReducer(s, { type: "request", slotId: slot.id });
    const req = buildRequest(s, slot, CONTEXT);
    out.requests.push(req);
    const resp = await runItineraryBatch(req, TOTAL, deps);
    out.responses.push(resp);
    s = batchReducer(s, { type: "response", slotId: slot.id, tripKey: KEY, resp });
    if (opts.autoRetryNoop) {
      // Unknown today (ignored), a no-op after the fix when nothing is retryable.
      const after = batchReducer(s, { type: "auto-retry" } as unknown as BatchEvent);
      expect(after).toEqual(s);
      s = after;
    }
  }
  out.state = s;
  return out;
}

describe("preservation: reducer is total for an unknown event", () => {
  it("ignores an unknown event type and returns the same state", () => {
    const s = batchReducer(initBatchState(), { type: "start", tripKey: KEY, totalDays: TOTAL });
    const after = batchReducer(s, { type: "auto-retry" } as unknown as BatchEvent);
    expect(after).toBe(s);
  });
});

describe("preservation: all days verify on the first pass", () => {
  it("makes one request per slot, no extra request, and returns every day", async () => {
    const d = await drive(batchTexts(), "match", { autoRetryNoop: true });
    expect(d.requests.map((r) => [r.fromDay, r.dayCount])).toEqual([[1, 3], [4, 1]]);
    expect(d.modelCalls).toBe(2);
    expect(d.state.phase).toBe("complete");
    expect(d.state.verified).toEqual([1, 2, 3, 4]);
    expect(d.state.withheld).toEqual([]);
    expect(d.state.pending).toEqual([]);
    expect(d.state.slots.every((x) => x.status === "done" && x.attempts === 1 && x.auto === 0)).toBe(true);
    expect(d.responses.every((r) => r.source === "model" && r.withheldDays.length === 0)).toBe(true);
    for (const day of d.state.days) {
      expect(day.activities.length).toBeGreaterThan(0);
      for (const a of day.activities) {
        expect(a.verified).toBe(true);
        expect(String(a.placeId).length).toBeGreaterThan(0);
      }
    }
    expect(nextSlot(d.state)).toBeNull();
  });

  it("the second request carries the places verified in the first", async () => {
    const d = await drive(batchTexts(), "match");
    expect(d.requests[0].usedPlaces).toEqual([]);
    expect(d.requests[1].usedPlaces.length).toBe(d.state.days.slice(0, 3).reduce((n, x) => n + x.activities.length, 0));
  });
});

describe("preservation: Places not configured", () => {
  it("fails the first slot with not-configured, keeps withheld and makes no extra request", async () => {
    const d = await drive(batchTexts(), "match", { hasKey: () => false, autoRetryNoop: true });
    expect(d.requests).toHaveLength(1);
    expect(d.modelCalls).toBe(0);
    expect(d.placesCalls).toBe(0);
    expect(d.responses[0].source).toBe("unavailable");
    expect(d.responses[0].reason).toBe("not-configured");
    expect(d.state.phase).toBe("failed");
    expect(d.state.reason).toBe("not-configured");
    expect(d.state.withheld).toEqual([1, 2, 3]);
    expect(d.state.pending).toEqual([4]);
    expect(d.state.verified).toEqual([]);
    expect(d.state.slots[0].status).toBe("failed");
    expect(d.state.slots[0].auto).toBe(0);
    expect(nextSlot(d.state)).toBeNull();
  });
});

describe("preservation: nothing verifiable", () => {
  it("keeps the failure state and withheld days and still writes the diag line", async () => {
    const d = await drive(batchTexts(), "nomatch");
    expect(d.requests).toHaveLength(1);
    expect(d.responses[0].source).toBe("unavailable");
    expect(["unavailable", "unverified"]).toContain(d.responses[0].reason);
    expect(d.responses[0].days).toEqual([]);
    expect(d.state.phase).toBe("failed");
    expect(d.state.withheld).toEqual([1, 2, 3]);
    expect(d.state.verified).toEqual([]);
    expect(d.state.days).toEqual([]);
    expect(d.diag.length).toBeGreaterThanOrEqual(1);
    expect(d.diag.length).toBe(d.logs.length);
    for (const l of d.diag) expect(l).not.toContain(DEST);
    for (const f of FIRSTS) for (const l of d.diag) expect(l).not.toContain(f);
  });
});

describe("preservation: the [itinerary-batch] log line", () => {
  it("keeps its fields in order for every outcome", async () => {
    const check = (d: Driven) => {
      expect(d.logs).toHaveLength(d.requests.length);
      d.logs.forEach((line, i) => {
        const m = LOG_RE.exec(line);
        expect(m).not.toBeNull();
        const r = d.responses[i];
        expect(Number(m![1])).toBe(r.fromDay);
        expect(Number(m![2])).toBe(r.fromDay + r.dayCount - 1);
        expect(Number(m![3])).toBe(r.stats.proposed);
        expect(Number(m![4])).toBe(r.stats.verified);
        expect(Number(m![5])).toBe(r.stats.removed);
        expect(Number(m![6])).toBe(r.stats.ms);
      });
    };
    const ok = await drive(batchTexts(), "match");
    check(ok);
    expect(ok.logs[0].startsWith("[itinerary-batch] days=1-3 proposed=")).toBe(true);
    expect(ok.logs[1].startsWith("[itinerary-batch] days=4-4 proposed=")).toBe(true);
    check(await drive(batchTexts(), "match", { hasKey: () => false }));
    check(await drive(batchTexts(), "nomatch"));
    const partial = await drive(batchTexts(undefined, true), "match");
    check(partial);
    expect(partial.logs[0]).toMatch(/outcome=partial$/);
  });
});

describe("preservation: day titles without a Day N prefix", () => {
  it.each(["Day trip to Dudhsagar", "South Goa Beaches", "Old Goa Heritage Walk", "Daydream Market Lanes"])(
    "keeps %s unchanged",
    async (title) => {
      const d = await drive(batchTexts([title, "North coast", "South coast", "Farewell"]), "match");
      expect(d.state.days[0].title).toBe(title);
    },
  );
});

describe("preservation: manual retry", () => {
  it("creates fresh pending slots from the withheld days", async () => {
    const d = await drive(batchTexts(undefined, true), "match");
    expect(d.state.phase).toBe("partial");
    expect(d.state.verified).toEqual([1, 2, 4]);
    expect(d.state.withheld).toEqual([3]);
    expect(d.requests).toHaveLength(2);
    const before = d.state;
    const s = batchReducer(before, { type: "retry", fromDay: 1, toDay: TOTAL });
    expect(s.phase).toBe("running");
    expect(s.withheld).toEqual([]);
    expect(s.pending).toEqual([3]);
    expect(s.verified).toEqual([1, 2, 4]);
    expect(s.days).toEqual(before.days);
    const slot = nextSlot(s)!;
    expect([slot.fromDay, slot.dayCount, slot.status, slot.attempts, slot.auto]).toEqual([3, 1, "pending", 0, 0]);
    expect(slot.id).toBe(before.nextSlotId);
    const req = buildRequest(s, slot, CONTEXT);
    expect([req.fromDay, req.dayCount]).toEqual([3, 1]);
    expect(req.usedPlaces).toEqual(before.usedPlaces);
  });

  it("does nothing when no day is withheld", async () => {
    const d = await drive(batchTexts(), "match");
    expect(batchReducer(d.state, { type: "retry", fromDay: 1, toDay: TOTAL })).toBe(d.state);
  });
});

// ---- Reducer invariants under random sequences of the existing events ----

let uniq = 0;
function activity(name: string): Activity {
  const placeId = `pid-${nameKey(name) || "x"}`;
  return { time: "09:00", title: name, description: "", cost: 0, placeName: name, placeId, verified: true, mapsUrl: buildMapsUrl(placeId, name) };
}
const dayOf = (n: number, names: string[]): TripDay => ({
  day: n,
  date: "",
  title: `Stop ${n}`,
  theme: "",
  activities: names.map(activity),
  total: 0,
});
function modelResp(fromDay: number, dayCount: number, days: TripDay[]): BatchResponse {
  const nums = days.map((x) => x.day);
  const withheld: number[] = [];
  for (let i = 0; i < dayCount; i++) if (!nums.includes(fromDay + i)) withheld.push(fromDay + i);
  const r = readBatchResponse({
    source: "model",
    fromDay,
    dayCount,
    days,
    verifiedDays: nums,
    withheldDays: withheld,
    truncated: false,
    stats: { proposed: dayCount, verified: nums.length, removed: 0, ms: 1 },
  });
  if (!r) throw new Error("unreadable test response");
  return r;
}

type Action =
  | { k: "start"; total: number }
  | { k: "request" }
  | { k: "ok"; mask: boolean[]; counts: number[] }
  | { k: "unavailable"; reason: BatchReason }
  | { k: "net" }
  | { k: "retry"; a: number; b: number }
  | { k: "cancel" };

const REASONS: BatchReason[] = ["not-configured", "unavailable", "unverified"];
const actionArb: fc.Arbitrary<Action> = fc.oneof(
  { weight: 1, arbitrary: fc.record({ k: fc.constant("start" as const), total: fc.integer({ min: 1, max: MAX_TRIP_DAYS }) }) },
  { weight: 8, arbitrary: fc.record({ k: fc.constant("request" as const) }) },
  {
    weight: 8,
    arbitrary: fc.record({
      k: fc.constant("ok" as const),
      mask: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
      counts: fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 3, maxLength: 3 }),
    }),
  },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("unavailable" as const), reason: fc.constantFrom(...REASONS) }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant("net" as const) }) },
  {
    weight: 4,
    arbitrary: fc.record({
      k: fc.constant("retry" as const),
      a: fc.integer({ min: 1, max: MAX_TRIP_DAYS }),
      b: fc.integer({ min: 1, max: MAX_TRIP_DAYS }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("cancel" as const) }) },
);

const sortedAsc = (a: number[]) => a.every((v, i) => i === 0 || a[i - 1] < v);

function checkInvariants(s: BatchState): void {
  // Slots sorted ascending by fromDay, pairwise disjoint among live slots is not required
  // for failed/done history, but ordering is.
  for (let i = 1; i < s.slots.length; i++) expect(s.slots[i - 1].fromDay).toBeLessThanOrEqual(s.slots[i].fromDay);
  expect(sortedAsc(s.verified)).toBe(true);
  expect(sortedAsc(s.withheld)).toBe(true);
  expect(sortedAsc(s.pending)).toBe(true);
  const all = [...s.verified, ...s.withheld, ...s.pending];
  expect(new Set(all).size).toBe(all.length);
  expect([...all].sort((a, b) => a - b)).toEqual(Array.from({ length: s.totalDays }, (_, i) => i + 1));
  for (const slot of s.slots) expect(slot.auto).toBeLessThanOrEqual(AUTO_RETRY_MAX);
  expect(s.slots.filter((x) => x.status === "loading").length).toBeLessThanOrEqual(1);
}

describe("preservation: reducer invariants under existing events", () => {
  it("keeps sorted, disjoint, covering days and a bounded auto count (generated)", () => {
    fc.assert(
      fc.property(fc.array(actionArb, { minLength: 1, maxLength: 60 }), (actions) => {
        let s = initBatchState();
        for (const a of actions) {
          let ev: BatchEvent | null = null;
          if (a.k === "start") ev = { type: "start", tripKey: KEY, totalDays: a.total };
          else if (a.k === "request") {
            const n = nextSlot(s);
            ev = { type: "request", slotId: n ? n.id : 0 };
          } else if (a.k === "ok") {
            const slot = s.slots.find((x) => x.id === s.inFlight);
            if (slot) {
              const days: TripDay[] = [];
              for (let i = 0; i < slot.dayCount; i++) {
                if (!a.mask[i]) continue;
                days.push(dayOf(slot.fromDay + i, Array.from({ length: a.counts[i] }, () => `Unique ${++uniq}`)));
              }
              ev = { type: "response", slotId: slot.id, tripKey: KEY, resp: modelResp(slot.fromDay, slot.dayCount, days) };
            }
          } else if (a.k === "unavailable") {
            const slot = s.slots.find((x) => x.id === s.inFlight);
            if (slot) {
              ev = {
                type: "response",
                slotId: slot.id,
                tripKey: KEY,
                resp: unavailable({ fromDay: slot.fromDay, dayCount: slot.dayCount }, a.reason),
              };
            }
          } else if (a.k === "net") {
            if (s.inFlight !== null) ev = { type: "network-error", slotId: s.inFlight, tripKey: KEY };
          } else if (a.k === "retry") ev = { type: "retry", fromDay: a.a, toDay: a.b };
          else ev = { type: "cancel" };
          if (!ev) continue;
          s = batchReducer(s, ev);
          checkInvariants(s);
        }
        return true;
      }),
      { numRuns: 100 },
    );
  });
});
