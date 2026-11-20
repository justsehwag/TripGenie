/**
 * Bug condition exploration (planner-missing-days, Property 1).
 *
 * A 4-day, balanced-pace Goa trip is driven through the real
 * runItineraryBatch (real verifier, geo and match code) with a loop that
 * mimics the planner driver effect: request, run the batch, dispatch the
 * response, then dispatch `{ type: "auto-retry" }`.
 *
 * Only the model text and the Places HTTP answers (Text Search (New) shape)
 * are faked. The key is a fake value set with vi.stubEnv.
 *
 * Every case has a defect on the FIRST proposal of a range. A later request for
 * the same range (the automatic retry the fix adds) gets usable real places.
 * The tests assert the expected behaviour: 4 verified days, every stop with a
 * placeId, no "Day N:" title prefix. On unfixed code they FAIL because nothing
 * retries a withheld day.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runItineraryBatch, type BatchDeps } from "../lib/itinerary/batch-service";
import type { BatchResponse } from "../lib/itinerary/batch-wire";
import { clearGroundingMemo } from "../lib/itinerary/grounding-memo";
import { createVerificationCache } from "../lib/itinerary/verification-cache";
import {
  batchReducer,
  buildRequest,
  initBatchState,
  nextSlot,
  type BatchEvent,
  type BatchState,
} from "../lib/itinerary/planner-batches";
import { EMPTY_BUNDLE } from "../lib/grounding/types";
import type { PostFetchLike } from "../lib/providers/google-places";
import type { TripContext } from "../lib/types";

const TOTAL_DAYS = 4;
const TRIP_KEY = "pmd-goa-4-balanced";
const DETAILS_BASE = "https://places.googleapis.com/v1/places/";
const GOA_CENTRE = { latitude: 15.2993, longitude: 74.124 };
const BOGUS = "Bogus Spot Nowhere";

interface Place {
  name: string;
  area: string;
  pin: string;
  lat: number;
  lng: number;
  kind: "sight" | "meal";
}

const P: Record<string, Place> = {
  basilica: { name: "Basilica of Bom Jesus", area: "Bainguinim, Old Goa", pin: "403402", lat: 15.5009, lng: 73.9116, kind: "sight" },
  se: { name: "Se Cathedral", area: "Velha Goa", pin: "403402", lat: 15.5031, lng: 73.9125, kind: "sight" },
  fontainhas: { name: "Fontainhas", area: "Panaji", pin: "403001", lat: 15.4965, lng: 73.8294, kind: "sight" },
  reis: { name: "Reis Magos Fort", area: "Verem, Reis Magos", pin: "403114", lat: 15.4929, lng: 73.8088, kind: "sight" },
  mums: { name: "Mum's Kitchen", area: "Porvorim", pin: "403521", lat: 15.5069, lng: 73.8171, kind: "meal" },
  museum: { name: "Goa State Museum", area: "Patto, Panaji", pin: "403001", lat: 15.4985, lng: 73.8285, kind: "sight" },
  aguada: { name: "Fort Aguada", area: "Sinquerim, Candolim", pin: "403515", lat: 15.4925, lng: 73.7737, kind: "sight" },
  chapora: { name: "Chapora Fort", area: "Chapora", pin: "403509", lat: 15.6055, lng: 73.736, kind: "sight" },
  mangueshi: { name: "Mangueshi Temple", area: "Priol, Ponda", pin: "403401", lat: 15.4486, lng: 73.9763, kind: "sight" },
  gunpowder: { name: "Gunpowder", area: "Assagao", pin: "403507", lat: 15.5883, lng: 73.7747, kind: "meal" },
  church: { name: "Church of Our Lady of the Immaculate Conception", area: "Panaji", pin: "403001", lat: 15.4989, lng: 73.8315, kind: "sight" },
  donapaula: { name: "Dona Paula View Point", area: "Dona Paula", pin: "403004", lat: 15.4546, lng: 73.8023, kind: "sight" },
};

const TIMES = ["09:30", "11:30", "13:30", "15:30", "17:30"];

interface StopSpec {
  /** Key into P, or a literal name that Places does not know. */
  key: string;
}
interface DaySpec {
  title: string;
  stops: StopSpec[];
}

const GOOD: Record<number, DaySpec> = {
  1: { title: "Arrival and Old Goa", stops: [{ key: "basilica" }, { key: "se" }] },
  2: { title: "Panaji heritage", stops: [{ key: "fontainhas" }, { key: "reis" }, { key: "mums" }, { key: "museum" }] },
  3: { title: "Forts, temples and coast", stops: [{ key: "aguada" }, { key: "chapora" }, { key: "mangueshi" }, { key: "gunpowder" }] },
  4: { title: "Last morning in Panaji", stops: [{ key: "church" }, { key: "donapaula" }] },
};

/** Day specs for one model call. `n` is how many earlier calls had the same range. */
type Script = (fromDay: number, dayCount: number, n: number) => DaySpec[];

const goodDays = (from: number, count: number): DaySpec[] => {
  const out: DaySpec[] = [];
  for (let d = from; d < from + count; d++) out.push(GOOD[d]);
  return out;
};

function modelJson(days: DaySpec[]): string {
  return JSON.stringify({
    days: days.map((d) => ({
      title: d.title,
      dayTrip: false,
      activities: d.stops.map((s, i) => {
        const p = P[s.key];
        const place = p ? p.name : s.key;
        return {
          time: TIMES[i % TIMES.length],
          place,
          area: p ? p.area.split(", ").pop() : "Goa",
          kind: p ? p.kind : "sight",
          description: `A visit to ${place}`,
          cost: p?.kind === "meal" ? 900 : 300,
        };
      }),
    })),
  });
}

interface Harness {
  deps: BatchDeps;
  /** Per request: what the model was asked and what the pipeline did. */
  trace: string[];
  lines: string[];
  diag: string[];
  /** Range keys ("from-count#n") of the model calls that were followed by a repair call. */
  repairLog: string[];
}

/**
 * `modelDelayMs` simulates a slow generation call by moving the injected
 * clock forward. 21500 ms leaves 3000 ms before the verify deadline
 * (25000 budget - 500 margin), which is below REPAIR_MIN_MS (3500).
 */
function makeHarness(
  script: Script,
  repairReply: string,
  modelDelayMs?: (from: number, count: number, n: number) => number,
): Harness {
  const seen = new Map<string, number>();
  const trace: string[] = [];
  const lines: string[] = [];
  const diag: string[] = [];
  const repairLog: string[] = [];
  let lastKey = "";
  let offset = 0;
  const now = () => Date.now() + offset;

  const invokeModel: BatchDeps["invokeModel"] = async (prompt) => {
    const m = /Plan days (\d+) to (\d+)\./.exec(prompt.user);
    if (!m) {
      trace.push(`    repair model call (reply ${repairReply.slice(0, 40)}...)`);
      repairLog.push(lastKey);
      return repairReply;
    }
    const from = Number(m[1]);
    const count = Number(m[2]) - from + 1;
    const k = `${from}-${count}`;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    lastKey = `${k}#${n}`;
    const delay = modelDelayMs ? modelDelayMs(from, count, n) : 0;
    if (delay > 0) {
      offset += delay;
      trace.push(`    (clock moved forward ${delay} ms to simulate a slow generation)`);
    }
    trace.push(`    model call days ${from}-${from + count - 1} (call #${n + 1} for this range)`);
    return modelJson(script(from, count, n));
  };

  const fetchImpl: PostFetchLike = async (url, init) => {
    if (url.startsWith(DETAILS_BASE)) {
      const id = decodeURIComponent(url.slice(DETAILS_BASE.length));
      return { ok: true, status: 200, json: async () => ({ id, photos: [{ name: `places/${id}/photos/ph1` }] }) };
    }
    let body: { textQuery?: unknown; maxResultCount?: unknown } = {};
    try {
      body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as typeof body;
    } catch {
      body = {};
    }
    const q = typeof body.textQuery === "string" ? body.textQuery : "";
    if (typeof body.maxResultCount !== "number") {
      if (q.trim().toLowerCase() === "goa") {
        return { ok: true, status: 200, json: async () => ({ places: [{ id: "goa-centre", location: GOA_CENTRE }] }) };
      }
      return { ok: false, status: 400, json: async () => ({}) };
    }
    for (const [key, p] of Object.entries(P)) {
      if (q === `${p.name}, Goa`) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            places: [
              {
                id: `ChIJ-goa-${key}`,
                displayName: { text: p.name },
                formattedAddress: `${p.area}, Goa ${p.pin}, India`,
                location: { latitude: p.lat, longitude: p.lng },
              },
            ],
          }),
        };
      }
    }
    return { ok: true, status: 200, json: async () => ({ places: [] }) };
  };

  const deps: BatchDeps = {
    invokeModel,
    fetchImpl,
    hasKey: () => true,
    ground: async () => EMPTY_BUNDLE("disabled"),
    verificationCache: createVerificationCache(),
    now,
    logger: (l) => lines.push(l),
    diagLogger: (l) => diag.push(l),
  };
  return { deps, trace, lines, diag, repairLog };
}

const CONTEXT: TripContext = {
  origin: "Delhi",
  destination: "Goa",
  durationDays: TOTAL_DAYS,
  budgetLevel: "mid",
  pace: "balanced",
  travellers: { adults: 2, children: 0 },
  interests: ["culture", "food"],
} as TripContext;

const AUTO_RETRY = { type: "auto-retry" } as unknown as BatchEvent;

interface RunResult {
  state: BatchState;
  report: string;
  responses: BatchResponse[];
}

/** Mimics the planner driver effect, plus the fix's auto-retry event. */
async function drive(h: Harness, label: string, stageNote: string): Promise<RunResult> {
  let state = batchReducer(initBatchState(), { type: "start", tripKey: TRIP_KEY, totalDays: TOTAL_DAYS });
  const responses: BatchResponse[] = [];
  const report: string[] = [`[planner-missing-days] CASE "${label}"`, `  expected stage that loses the day: ${stageNote}`];
  for (let i = 0; i < 12; i++) {
    const slot = nextSlot(state);
    if (!slot) break;
    state = batchReducer(state, { type: "request", slotId: slot.id });
    const req = buildRequest(state, slot, CONTEXT, "2025-03-01");
    report.push(`  request #${i + 1}: days ${req.fromDay}-${req.fromDay + req.dayCount - 1}, usedPlaces=${req.usedPlaces?.length ?? 0}`);
    const before = h.trace.length;
    const resp = await runItineraryBatch(req, TOTAL_DAYS, h.deps);
    responses.push(resp);
    report.push(...h.trace.slice(before));
    report.push(
      `    result: source=${resp.source} reason=${resp.reason ?? "-"} verifiedDays=[${resp.verifiedDays}] withheld=[${resp.withheldDays}] stats=${JSON.stringify(resp.stats)}`,
    );
    state = batchReducer(state, { type: "response", slotId: slot.id, tripKey: TRIP_KEY, resp });
    const afterResponse = state;
    state = batchReducer(state, AUTO_RETRY);
    // Totality: the unknown (unfixed) event must leave a valid state behind.
    expect(state, "reducer must be total for auto-retry").toBeTruthy();
    report.push(
      `    after response: verified=[${afterResponse.verified}] withheld=[${afterResponse.withheld}] pending=[${afterResponse.pending}] phase=${afterResponse.phase}; after auto-retry: withheld=[${state.withheld}] pending=[${state.pending}] slots=${state.slots.length}`,
    );
  }
  report.push(`  FINAL: verified=[${state.verified}] withheld=[${state.withheld}] pending=[${state.pending}] phase=${state.phase}`);
  report.push(`  log: ${h.lines.join(" | ")}`);
  const text = report.join("\n");
  console.log(text);
  return { state, report: text, responses };
}

function expectAllDays(r: RunResult): void {
  const msg = `Bug reproduced: fewer than ${TOTAL_DAYS} verified days.\n${r.report}`;
  expect(r.state.verified, msg).toEqual([1, 2, 3, 4]);
  expect(r.state.days.length, msg).toBe(TOTAL_DAYS);
  for (const day of r.state.days) {
    for (const a of day.activities) {
      expect(typeof a.placeId === "string" && a.placeId.length > 0, msg).toBe(true);
      expect(a.verified, msg).toBe(true);
    }
    expect(/^\s*day\s*\d+\s*[:\-\u2013\u2014]/i.test(day.title), `title keeps "Day N:" prefix: "${day.title}"\n${r.report}`).toBe(false);
  }
}

beforeEach(() => {
  vi.stubEnv("GOOGLE_PLACES_API_KEY", "test-key");
  clearGroundingMemo();
});
afterEach(() => {
  vi.unstubAllEnvs();
  clearGroundingMemo();
});

describe("planner missing days: 4-day balanced Goa trip (bug condition)", () => {
  it("control: a clean model run verifies all 4 days (harness sanity)", async () => {
    const h = makeHarness((from, count) => goodDays(from, count), '{"replacements":[]}');
    const r = await drive(h, "control, no defect", "none");
    expect(r.state.verified, r.report).toEqual([1, 2, 3, 4]);
  }, 60_000);

  it("model proposes 2 stops on full day 2: the day is retried and verified", async () => {
    const script: Script = (from, count, n) => {
      const days = goodDays(from, count);
      if (from === 1 && count === 3 && n === 0) {
        days[1] = { title: GOOD[2].title, stops: [{ key: "fontainhas" }, { key: "reis" }] };
      }
      return days;
    };
    const h = makeHarness(script, '{"replacements":[]}');
    const r = await drive(h, "2 stops on a full day", "model proposal count -> evaluateDay too-few (min 3), repair empty, no range retry");
    expectAllDays(r);
  }, 60_000);

  // NOTE: the rejected-stop cases use day 1 (arrival day, balanced: min = max = 2,
  // no slack) inside the multi-day batch 1-3. A rejected stop on day 4 alone is a
  // single-day batch; if it verifies nothing the whole slot fails and the existing
  // AUTO_RETRY_MAX = 1 retry already fills it, so that variant does not reproduce.

  it("one stop on day 1 has no Places match and the repair reply is unusable", async () => {
    const script: Script = (from, count, n) => {
      const days = goodDays(from, count);
      if (from === 1 && count === 3 && n === 0) {
        days[0] = { title: GOOD[1].title, stops: [{ key: "basilica" }, { key: BOGUS }] };
      }
      return days;
    };
    const h = makeHarness(script, "not json at all");
    const r = await drive(h, "day 1 stop rejected, repair unusable", "partial day min=max=2: one no-name-match stop -> evaluateDay too-few, repair unusable, no range retry");
    expectAllDays(r);
  }, 60_000);

  it("repair is skipped because the clock leaves less than REPAIR_MIN_MS", async () => {
    const script: Script = (from, count, n) => {
      const days = goodDays(from, count);
      if (from === 1 && count === 3 && n === 0) {
        days[0] = { title: GOOD[1].title, stops: [{ key: "basilica" }, { key: BOGUS }] };
      }
      return days;
    };
    const usable =
      '{"replacements":[{"day":1,"slot":1,"activity":{"time":"15:30","place":"Se Cathedral","area":"Velha Goa","kind":"sight","description":"A visit","cost":300}}]}';
    const h = makeHarness(script, usable, (from, count, n) => (from === 1 && count === 3 && n === 0 ? 21_500 : 0));
    const r = await drive(h, "repair skipped by clock", "repair gate (phaseDeadline - now < REPAIR_MIN_MS) skipped repair, no range retry");
    expect(h.repairLog, `repair should have been skipped by the clock gate on the first proposal\n${r.report}`).not.toContain("1-3#0");
    expectAllDays(r);
  }, 60_000);

  it('model title "Day 1: Arrival in Panaji" comes back without the prefix', async () => {
    const script: Script = (from, count) => {
      const days = goodDays(from, count);
      if (from === 1) days[0] = { title: "Day 1: Arrival in Panaji", stops: GOOD[1].stops };
      return days;
    };
    const h = makeHarness(script, '{"replacements":[]}');
    const r = await drive(h, "title prefix", "uniqueTitle keeps the model title as is");
    expectAllDays(r);
  }, 60_000);
});
