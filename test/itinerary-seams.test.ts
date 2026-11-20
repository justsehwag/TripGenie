import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runItineraryBatch, type BatchDeps } from "../lib/itinerary/batch-service";
import { readBatchResponse, validateBatchRequest, type BatchResponse } from "../lib/itinerary/batch-wire";
import {
  batchReducer,
  buildRequest,
  initBatchState,
  nextSlot,
  type BatchState,
} from "../lib/itinerary/planner-batches";
import { mergeBatch } from "../lib/itinerary/completeness";
import { clearGroundingMemo } from "../lib/itinerary/grounding-memo";
import { createVerificationCache } from "../lib/itinerary/verification-cache";
import { isGenericTitle, nameKey } from "../lib/itinerary/place-key";
import { isSafeMapsUrl, isValidPhotoRef } from "../lib/itinerary/maps-link";
import { EMPTY_BUNDLE } from "../lib/grounding/types";
import {
  activityId,
  applyPriceResults,
  normalizeItineraryToInr,
  partyActivitiesInr,
  toPricerRequest,
} from "../lib/itinerary-inr";
import { computeSummary } from "../lib/trip-summary";
import { isPriceable } from "../lib/cost-classifier";
import type { PostFetchLike } from "../lib/providers/google-places";
import type { PriceResult } from "../lib/price-cache";
import type { Activity, Itinerary, TripContext, TripDay } from "../lib/types";

const KEY_ENV = "GOOGLE_PLACES_API_KEY";
const TEST_KEY = "test-key-not-real";
const DEST = "Bali Seamtest";
const TOTAL = 10;
const CENTRE = { lat: -8.4, lng: 115.2 };
const DETAILS_BASE = "https://places.googleapis.com/v1/places/";
const OPTS = { origin: "Mumbai", destination: "Bali", budgetLevel: "mid" as const };

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
});

// ---------------------------------------------------------------------------
// Fake Places: Text Search, destination centre, Place Details (photos)
// ---------------------------------------------------------------------------

function makeFetch(): PostFetchLike {
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
    const textQuery = typeof parsed.textQuery === "string" ? parsed.textQuery : "";
    if (typeof parsed.maxResultCount !== "number") {
      if (textQuery !== DEST) return { ok: false, status: 500, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ places: [{ id: "seam-centre", location: { latitude: CENTRE.lat, longitude: CENTRE.lng } }] }),
      };
    }
    const suffix = `, ${DEST}`;
    if (!textQuery.endsWith(suffix)) return { ok: false, status: 400, json: async () => ({}) };
    const place = textQuery.slice(0, textQuery.length - suffix.length);
    const key = nameKey(place);
    const id = `seam-${key.replace(/\s+/g, "-")}`;
    let n = 0;
    for (const ch of id) n += ch.charCodeAt(0);
    const loc = { latitude: CENTRE.lat + (n % 7) * 0.004, longitude: CENTRE.lng + (n % 5) * 0.004 };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        places: [
          {
            id,
            displayName: { text: place },
            formattedAddress: `${place}, Ubud, ${DEST}, Indonesia`,
            location: loc,
          },
        ],
      }),
    };
  };
}

// ---------------------------------------------------------------------------
// Fake model: repeats earlier places (case / diacritic variants), generic
// titles, and a last batch cut in the middle of its only day
// ---------------------------------------------------------------------------

const FIRSTS = ["Aurelia", "Brightwater", "Cedar", "Dunmore", "Eastgate", "Fernhill", "Glenmarrow", "Harrow", "Ivory", "Juniper"];
const NOUNS = ["Fort", "Museum", "Gardens", "Cathedral", "Lighthouse", "Observatory", "Palace", "Bridge"];
const POOL: string[] = FIRSTS.flatMap((f) => NOUNS.map((n) => `${f} ${n}`));
const MEALS = ["Cedar Kitchen", "Fernhill Bistro", "Harrow Cafe", "Ivory Bakery", "Juniper Grill", "Dunmore Kitchen"];

interface Script {
  texts: string[];
  fresh: string[];
  generic: string[];
}

function buildScript(): Script {
  let cursor = 0;
  let mealCursor = 0;
  const fresh: string[] = [];
  const nextPlace = (): string => {
    const p = POOL[cursor++];
    fresh.push(p);
    return p;
  };
  const act = (place: string, kind: "sight" | "meal" | "experience" = "sight", time = "10:00") => ({
    time,
    place,
    area: "Area",
    kind,
    description: `A visit to ${place}`,
    cost: 200,
  });
  const day = (title: string, acts: Array<ReturnType<typeof act>>) => ({ title, dayTrip: false, activities: acts });
  const sights = (n: number) => Array.from({ length: n }, () => act(nextPlace()));
  const meal = () => act(MEALS[mealCursor++ % MEALS.length], "meal", "13:00");
  const generic = ["Local lunch", "Free time", "free time", "Explore the city"];

  // Batch 1 (days 1 to 3): day 1 arrival (2 stops), generic rows, equal day titles.
  const d1 = day("Arrival in the island", sights(2));
  const d2 = day("Ubud culture", [...sights(3), act(generic[0], "meal", "13:00"), meal()]);
  const d3 = day("Ubud culture", [...sights(3), act(generic[1], "experience", "16:00"), meal()]);
  const b1 = { days: [d1, d2, d3] };
  const first = [...fresh];

  // Batch 2 (days 4 to 6): repeats of batch 1 places as case / diacritic variants,
  // a repeat of a place from an earlier day of the same batch, generic rows.
  const aurelia = first[0];
  const d4 = day("Coast road day", [
    ...sights(3),
    act(aurelia.toUpperCase()),
    act("Aur\u00e9lia Museum"),
  ]);
  const d4first = fresh[first.length];
  const d5 = day("Rice terrace day", [...sights(3), act(generic[2], "experience", "15:00"), meal()]);
  const d6 = day("Temple day", [
    ...sights(3),
    act(`  ${d4first.toLowerCase()}  `),
    act(generic[3], "sight", "17:00"),
  ]);
  const b2 = { days: [d4, d5, d6] };

  // Batch 3 (days 7 to 9): more repeats.
  const d7 = day("Beach day", [...sights(3), act(first[2].toUpperCase()), meal()]);
  const d8 = day("Volcano day", [...sights(4), act(first[3].replace("e", "\u00e9"))]);
  const d9 = day("Market lanes day", [...sights(3), meal(), act(first[4].toLowerCase())]);
  const b3 = { days: [d7, d8, d9] };

  // Batch 4 (day 10): the answer is cut in the middle of the only day.
  const cutPlace = nextPlace();
  const cut =
    `{"days":[{"title":"Departure morning","dayTrip":false,"activities":[` +
    `{"time":"09:00","place":"${cutPlace}","area":"Area","kind":"sight","description":"A visit to ${cutPlace}","cost":200},` +
    `{"time":"11:00","place":"${nextPlace()}","area":"Ar`;

  return { texts: [JSON.stringify(b1), JSON.stringify(b2), JSON.stringify(b3), cut], fresh, generic };
}

// ---------------------------------------------------------------------------
// Drive the trip like the Planner does
// ---------------------------------------------------------------------------

interface Driven {
  state: BatchState;
  merged: Itinerary;
  requests: ReturnType<typeof buildRequest>[];
  responses: BatchResponse[];
  /** Normalized (INR) batch-only itineraries, in the order they were merged. */
  batchOnly: Itinerary[];
  /** Merged itinerary snapshot after each merge. */
  snapshots: Itinerary[];
  repairCalls: number;
  batchCalls: number;
}

const CONTEXT: TripContext = {
  origin: "Mumbai",
  destination: DEST,
  durationDays: TOTAL,
  budgetLevel: "mid",
  pace: "balanced",
  travellers: { adults: 2, children: 0 },
  interests: ["culture"],
} as TripContext;

async function driveTrip(script: Script): Promise<Driven> {
  let batchCalls = 0;
  let repairCalls = 0;
  const deps: BatchDeps = {
    invokeModel: async (p) => {
      if (p.system.includes("SLOTS TO REPLACE")) {
        repairCalls += 1;
        return '{"replacements":[]}';
      }
      const i = Math.min(batchCalls, script.texts.length - 1);
      batchCalls += 1;
      return script.texts[i];
    },
    fetchImpl: makeFetch(),
    hasKey: () => true,
    ground: async () => EMPTY_BUNDLE("disabled"),
    verificationCache: createVerificationCache(),
    logger: () => undefined,
  };

  const tripKey = "seam-trip";
  let state = batchReducer(initBatchState(), { type: "start", tripKey, totalDays: TOTAL });
  let merged: Itinerary | null = null;
  const requests: Driven["requests"] = [];
  const responses: BatchResponse[] = [];
  const batchOnly: Itinerary[] = [];
  const snapshots: Itinerary[] = [];

  for (let guard = 0; guard < 12; guard++) {
    const slot = nextSlot(state);
    if (!slot) break;
    const req = buildRequest(state, slot, CONTEXT, "2025-03-01");
    requests.push(req);
    state = batchReducer(state, { type: "request", slotId: slot.id });

    // What the route does with the HTTP body.
    const checked = validateBatchRequest(JSON.parse(JSON.stringify(req)));
    expect(checked.ok).toBe(true);
    if (!checked.ok) throw new Error(checked.error);
    const raw = await runItineraryBatch(checked.value, checked.totalDays, deps);
    // What the browser does with the HTTP answer.
    const resp = readBatchResponse(JSON.parse(JSON.stringify(raw)));
    expect(resp).not.toBeNull();
    if (!resp) throw new Error("readBatchResponse rejected the server response");
    responses.push(resp);

    state = batchReducer(state, { type: "response", slotId: slot.id, tripKey, resp });
    // Same merge rule as components/planner.tsx: merge when days arrived or the withheld list changed.
    const batchDays = resp.source === "model" ? resp.days : [];
    const prevWithheld = merged?.completeness?.withheldDays ?? [];
    const withheldChanged = state.withheld.join(",") !== prevWithheld.join(",");
    if (batchDays.length > 0 || (merged && withheldChanged)) {
      const only = normalizeItineraryToInr(
        {
          title: `Trip to ${DEST}`,
          totalCost: 0,
          days: batchDays,
          completeness: {
            requestedDays: TOTAL,
            verifiedDays: batchDays.map((d) => d.day),
            withheldDays: state.withheld,
          },
        } as Itinerary,
        95,
        OPTS,
      );
      if (batchDays.length > 0) batchOnly.push(only);
      merged = mergeBatch(merged, only, { verifiedDays: batchDays.map((d) => d.day), withheldDays: state.withheld }, TOTAL);
      snapshots.push(merged);
    }
  }
  if (!merged) throw new Error("nothing was merged");
  return { state, merged, requests, responses, batchOnly, snapshots, repairCalls, batchCalls };
}

function allActivities(it: Itinerary): Array<{ day: TripDay; a: Activity; i: number }> {
  return it.days.flatMap((day) => day.activities.map((a, i) => ({ day, a, i })));
}

const TEMPLATE_RE = /^(Arrive in|Breakfast near|Lunch in|Evening around|Explore )/i;

// ---------------------------------------------------------------------------

describe("itinerary seams: 10-day Bali trip with a misbehaving model", () => {
  it("never repeats a place across the merged trip", async () => {
    const run = await driveTrip(buildScript());
    const placeIds = new Set<string>();
    const nameKeys = new Set<string>();
    for (const { a } of allActivities(run.merged)) {
      expect(a.placeId && placeIds.has(a.placeId)).toBeFalsy();
      placeIds.add(String(a.placeId));
      const k = nameKey(String(a.placeName ?? a.title));
      expect(nameKeys.has(k)).toBe(false);
      nameKeys.add(k);
    }
    expect(placeIds.size).toBeGreaterThan(20);
  });

  it("shows no generic title and no template day; every shown stop is verified", async () => {
    const run = await driveTrip(buildScript());
    const merged = run.merged;
    expect(merged.days.length).toBeGreaterThan(0);
    for (const day of merged.days) {
      expect(isGenericTitle(day.title)).toBe(false);
      for (const a of day.activities) {
        expect(isGenericTitle(a.title)).toBe(false);
        expect(TEMPLATE_RE.test(a.title)).toBe(false);
        expect(TEMPLATE_RE.test(day.title)).toBe(false);
        expect(a.verified).toBe(true);
        expect(typeof a.placeId === "string" && a.placeId.length > 0).toBe(true);
        expect(isSafeMapsUrl(a.mapsUrl)).toBe(true);
        expect(a.location && Number.isFinite(a.location.lat) && Number.isFinite(a.location.lng)).toBeTruthy();
        expect(a.mapVerified).toBeUndefined();
      }
    }
    // day titles are pairwise distinct across the trip
    const titles = merged.days.map((d) => nameKey(d.title));
    expect(new Set(titles).size).toBe(titles.length);
    // the generic rows the model proposed never reached the plan
    const shown = new Set(allActivities(merged).map(({ a }) => nameKey(a.title)));
    for (const g of buildScript().generic) expect(shown.has(nameKey(g))).toBe(false);
  });

  it("lists the withheld day and keeps completeness consistent", async () => {
    const run = await driveTrip(buildScript());
    const c = run.merged.completeness;
    expect(c).toBeDefined();
    expect(c!.requestedDays).toBe(TOTAL);
    expect(c!.verifiedDays).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(c!.withheldDays).toEqual([10]);
    expect(c!.pendingDays ?? []).toEqual([]);
    expect(run.merged.days.map((d) => d.day)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    expect(run.state.withheld).toEqual([10]);
    expect(run.state.verified).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(run.state.pending).toEqual([]);
    expect(run.state.phase).toBe("partial");

    const last = run.responses[run.responses.length - 1];
    expect(last.source).toBe("unavailable");
    expect(last.withheldDays).toEqual([10]);
    expect(last.days).toEqual([]);
    // the cut day was retried automatically once, never invented
    expect(run.requests.filter((r) => r.fromDay === 10)).toHaveLength(2);
    expect(run.merged.days.some((d) => d.day === 10)).toBe(false);
  });

  it("dates days from the start date and keeps batches non-overlapping", async () => {
    const run = await driveTrip(buildScript());
    run.merged.days.forEach((d) => {
      const base = Date.UTC(2025, 2, 1) + (d.day - 1) * 86_400_000;
      expect(d.date).toBe(new Date(base).toISOString().slice(0, 10));
    });
    const firstResp = run.responses[0];
    expect(firstResp.fromDay).toBe(1);
    expect(firstResp.verifiedDays).toEqual([1, 2, 3]);
  });

  it("carries usedPlaces from the verified stops into the next request", async () => {
    const run = await driveTrip(buildScript());
    // the first request has no history; later requests list the names the server wrote
    expect(run.requests[0].usedPlaces).toEqual([]);
    const written = new Set(run.responses[0].days.flatMap((d) => d.activities.map((a) => nameKey(String(a.placeName)))));
    expect(written.size).toBeGreaterThan(0);
    const sent = new Set(run.requests[1].usedPlaces.map((p) => nameKey(p)));
    for (const k of written) expect(sent.has(k)).toBe(true);
    // each later request is a superset of the earlier one (no stop is forgotten)
    for (let i = 2; i < run.requests.length; i++) {
      const prev = new Set(run.requests[i - 1].usedPlaces.map((p) => nameKey(p)));
      const cur = new Set(run.requests[i].usedPlaces.map((p) => nameKey(p)));
      for (const k of prev) expect(cur.has(k)).toBe(true);
    }
    // every request the Planner built passes the server's validation (done in driveTrip)
    expect(run.requests.map((r) => r.fromDay)).toEqual([1, 4, 7, 10, 10]);
  });

  it("writes every field the Planner and the Pricer read", async () => {
    const run = await driveTrip(buildScript());
    for (const day of run.merged.days) {
      expect(day.activities.length).toBeGreaterThan(0);
      for (const a of day.activities) {
        expect(typeof a.title).toBe("string");
        expect(a.title.trim().length).toBeGreaterThan(0);
        expect(typeof a.time).toBe("string");
        expect(a.time.trim().length).toBeGreaterThan(0);
        expect(a.placeName && a.placeName.trim().length > 0).toBeTruthy();
        // the Planner derives usedPlaces from placeName / title of verified stops
        expect(nameKey(a.title)).toBe(nameKey(String(a.placeName)));
        // no category: model costs are INR and must not be read as USD
        expect(a.category).toBeUndefined();
      }
      // a verified day has a hero photo that belongs to one of its stops
      const withPhoto = day.activities.filter((a) => a.photoRef !== undefined);
      expect(withPhoto.length).toBeGreaterThan(0);
      for (const a of withPhoto) {
        expect(isValidPhotoRef(a.photoRef)).toBe(true);
        expect(String(a.photoRef).startsWith(`places/${a.placeId}/photos/`)).toBe(true);
      }
    }
  });

  it("converts to INR without multiplying the model's INR costs", async () => {
    const run = await driveTrip(buildScript());
    run.responses.forEach((resp) => {
      if (resp.source !== "model") return;
      const only = run.batchOnly[run.responses.filter((r) => r.source === "model").indexOf(resp)];
      expect(only.currency).toBe("INR");
      expect(only.costUnit).toBe("inr");
      const raw = resp.days.flatMap((d) => d.activities);
      const norm = only.days.flatMap((d) => d.activities);
      expect(norm).toHaveLength(raw.length);
      norm.forEach((n, i) => {
        // never scaled by the USD rate (95): a model cost of 200 stays <= 200
        expect(n.cost).toBeLessThanOrEqual(raw[i].cost);
        expect(n.cost).toBeGreaterThanOrEqual(0);
        if (n.costClass && isPriceable(n.costClass) && n.priceBasis === undefined) {
          expect(n.cost).toBe(raw[i].cost);
        }
      });
    });
    // idempotent: a second pass leaves the batch untouched
    const again = normalizeItineraryToInr(run.batchOnly[0], 95, OPTS);
    expect(again).toBe(run.batchOnly[0]);
  });

  it("keeps pricer ids stable across merges and prices only the matching rows", async () => {
    const run = await driveTrip(buildScript());
    const finalReq = toPricerRequest("Bali", run.merged, OPTS);
    const ids = finalReq.activities.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);

    // ids of an earlier snapshot are a subset, with the same titles and times
    const finalById = new Map(finalReq.activities.map((x) => [x.id, x]));
    run.snapshots.forEach((snap) => {
      const req = toPricerRequest("Bali", snap, OPTS);
      expect(req.activities.length).toBeGreaterThan(0);
      for (const item of req.activities) {
        const same = finalById.get(item.id);
        expect(same).toBeDefined();
        expect(same!.title).toBe(item.title);
        expect(same!.time).toBe(item.time);
      }
    });

    // ids of each batch-only itinerary equal the ids computed from the merged days
    run.batchOnly.forEach((only) => {
      for (const d of only.days) {
        const mergedDay = run.merged.days.find((x) => x.day === d.day)!;
        d.activities.forEach((a, i) => {
          expect(activityId(d.day, a, i)).toBe(activityId(mergedDay.day, mergedDay.activities[i], i));
        });
      }
    });

    // apply a fake price result to the first priceable activity of day 2
    const target = finalReq.activities.find((x) => x.id.startsWith("d2-"));
    expect(target).toBeDefined();
    const result: PriceResult = { id: target!.id, inr: 350, basis: "per person", source: "ai" };
    const priced = applyPriceResults(run.merged, [result, { id: "d99-none-0", inr: 1, basis: "x", source: "ai" }], OPTS);
    const before = allActivities(run.merged);
    const after = allActivities(priced);
    expect(after).toHaveLength(before.length);
    let changed = 0;
    after.forEach(({ day, a, i }, k) => {
      if (activityId(day.day, a, i) === target!.id) {
        expect(["ai", "estimated"]).toContain(a.priceSource);
        changed += 1;
      } else {
        expect(a.cost).toBe(before[k].a.cost);
      }
    });
    expect(changed).toBe(1);
    expect(priced.days.map((d) => d.day)).toEqual(run.merged.days.map((d) => d.day));
    expect(priced.totalCost).toBe(priced.days.reduce((s, d) => s + d.total, 0));
  });

  it("sums the party total over verified days only", async () => {
    const run = await driveTrip(buildScript());
    const priced = applyPriceResults(run.merged, [], OPTS);
    const travellers = 2;
    const summary = computeSummary({
      itinerary: priced,
      stayInr: 0,
      flightPerPerson: 0,
      travellers,
      noFlight: true,
    });
    const vehicles = Math.ceil(travellers / 4);
    let expected = 0;
    for (const d of priced.days) {
      for (const a of d.activities) expected += a.cost * (a.costBasis === "group" ? vehicles : travellers);
    }
    expect(summary.activities).toBe(expected);
    expect(summary.activities).toBe(partyActivitiesInr(priced, travellers));
    expect(summary.activities).toBeGreaterThan(0);
    // no day was invented for the withheld day 10
    expect(priced.days.some((d) => d.day === 10)).toBe(false);
  });
});
