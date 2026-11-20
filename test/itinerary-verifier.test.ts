import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  attachHeroes,
  attachHeroStops,
  verifyProposed,
  verifyReplacements,
  type BatchVerification,
  type VerifyContext,
  type VerifyDeps,
} from "../lib/itinerary/verifier";
import { createVerificationCache } from "../lib/itinerary/verification-cache";
import type { ProposedDay, ProposedStop } from "../lib/itinerary/batch-parse";
import { HERO_LOOKUP_RESERVE, HERO_TRIES_PER_DAY, MAX_VERIFY_LOOKUPS_PER_BATCH } from "../lib/itinerary/constants";
import { isWithinDestination } from "../lib/itinerary/geo";
import { buildMapsUrl, isSafeMapsUrl, isValidPhotoRef } from "../lib/itinerary/maps-link";
import { isGenericTitle, nameKey, type StopKind } from "../lib/itinerary/place-key";
import { placeMatches } from "../lib/grounding/place-match";
import { VERIFY_CONCURRENCY } from "../lib/grounding/verify-places";
import type { PostFetchLike } from "../lib/providers/google-places";
import type { VerifiedStop } from "../lib/itinerary/structure";

const NUM_RUNS = 100;
const KEY_ENV = "GOOGLE_PLACES_API_KEY";
const TEST_KEY = "test-key-not-real";
const DEST = "Testville";
const CENTRE = { lat: 10, lng: 20 };
const FIELD_MASK = "places.id,places.displayName,places.formattedAddress,places.location";
const VERIFY_CAP = MAX_VERIFY_LOOKUPS_PER_BATCH - HERO_LOOKUP_RESERVE;
const SHORT_DEADLINE_MS = 25; // real-timer budget for scripted hangs

// ---------------------------------------------------------------------------
// Environment: the Places key is read from process.env by lib/config.ts
// ---------------------------------------------------------------------------

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env[KEY_ENV];
  process.env[KEY_ENV] = TEST_KEY;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = savedKey;
});

// ---------------------------------------------------------------------------
// Fake Places
// ---------------------------------------------------------------------------

const FIRSTS = ["Aurelia", "Brightwater", "Cedar", "Dunmore", "Eastgate", "Fernhill", "Glenmarrow", "Harrow", "Ivory", "Juniper"];
const NOUNS = ["Fort", "Museum", "Gardens", "Cathedral", "Lighthouse", "Observatory", "Palace", "Bridge"];
const NAMES: string[] = FIRSTS.flatMap((f) => NOUNS.map((n) => `${f} ${n}`));
const GENERIC_TITLES = ["Free time", "Local lunch", "Check-in at the hotel", "Explore the city", "Evening walk"];

type Behaviour =
  | "ok" | "okSecond" | "okFourth" | "far" | "mid" | "noid" | "noloc" | "empty" | "emptyNoKey"
  | "wrongname" | "nonok" | "throw" | "badjson" | "hang" | "shared"
  | { custom: unknown[] };

/** Behaviours whose answer may legitimately verify the stop. */
const MAY_VERIFY = new Set<string>(["ok", "okSecond", "mid", "shared"]);

interface Req {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string;
  textQuery: string;
  isSearch: boolean;
  keys: string[];
}
interface Returned {
  id: string;
  displayName: string;
  address: string;
  location: { lat: number; lng: number } | null;
}

function rawPlace(id: string | null, name: string, address: string, loc: { lat: number; lng: number } | null) {
  const p: Record<string, unknown> = { displayName: { text: name }, formattedAddress: address };
  if (id !== null) p.id = id;
  if (loc) p.location = { latitude: loc.lat, longitude: loc.lng };
  return p;
}

interface World {
  fetchImpl: PostFetchLike;
  requests: Req[];
  returned: Returned[];
  okQueries: Set<string>;
  maxInflight: () => number;
  searches: () => Req[];
  centreRequests: () => Req[];
}

function makeWorld(
  behaviourOf: (place: string) => Behaviour,
  opts: { destination?: string; centre?: boolean } = {},
): World {
  const dest = opts.destination ?? DEST;
  const suffix = `, ${dest}`;
  const requests: Req[] = [];
  const returned: Returned[] = [];
  const okQueries = new Set<string>();
  let inflight = 0;
  let maxInflight = 0;

  const fetchImpl: PostFetchLike = async (url, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    let parsed: { textQuery?: unknown; maxResultCount?: unknown } = {};
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      // keep empty
    }
    const textQuery = typeof parsed.textQuery === "string" ? parsed.textQuery : "";
    const isSearch = typeof parsed.maxResultCount === "number";
    requests.push({
      url,
      method: init?.method,
      headers: { ...(init?.headers ?? {}) },
      body,
      textQuery,
      isSearch,
      keys: Object.keys(parsed).sort(),
    });
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    try {
      await Promise.resolve();
      await Promise.resolve();
      if (!isSearch) {
        if (opts.centre === false || textQuery !== dest) {
          return { ok: false, status: 500, json: async () => ({}) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            places: [{ id: "centre-id", location: { latitude: CENTRE.lat, longitude: CENTRE.lng } }],
          }),
        };
      }
      if (!textQuery.endsWith(suffix)) return { ok: false, status: 400, json: async () => ({}) };
      const place = textQuery.slice(0, textQuery.length - suffix.length);
      const idx = NAMES.indexOf(place);
      const n = idx < 0 ? 90 : idx;
      const id = `test-id-${n}`;
      const near = { lat: CENTRE.lat + (n % 7) * 0.01, lng: CENTRE.lng + (n % 5) * 0.01 };
      const addr = n % 2 === 0 ? `${place}, Old Town, ${dest}, Testland` : `${place}, Old Town, Testland`;
      const good = (gid: string, name: string) => rawPlace(gid, name, addr, near);
      const b = behaviourOf(place);

      if (b === "throw") throw new Error("network down");
      if (b === "hang") {
        await new Promise<never>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(new Error("aborted"));
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      if (b === "nonok") return { ok: false, status: 503, json: async () => ({}) };
      if (b === "badjson") {
        return { ok: true, status: 200, json: async () => { throw new Error("bad json"); } };
      }

      let places: unknown[];
      if (typeof b === "object") places = b.custom;
      else if (b === "ok") places = [good(id, place)];
      else if (b === "okSecond") places = [good(`x-${n}`, "Unrelated Garage"), good(id, place)];
      else if (b === "okFourth") {
        places = [good("w1", "Unrelated Garage"), good("w2", "Unrelated Depot"), good("w3", "Unrelated Yard"), good(id, place)];
      } else if (b === "far") places = [rawPlace(id, place, "Faraway City", { lat: CENTRE.lat + 5, lng: CENTRE.lng })];
      else if (b === "mid") places = [rawPlace(id, place, "Faraway Town", { lat: CENTRE.lat + 0.9, lng: CENTRE.lng })];
      else if (b === "noid") places = [rawPlace(null, place, addr, near)];
      else if (b === "noloc") places = [rawPlace(id, place, `${place}, ${dest}`, null)];
      else if (b === "wrongname") places = [good(id, "Unrelated Garage")];
      else if (b === "shared") places = [good("shared-id", place)];
      else places = []; // empty, emptyNoKey

      for (const raw of places) {
        const r = raw as { id?: unknown; displayName?: { text?: unknown }; formattedAddress?: unknown; location?: { latitude?: number; longitude?: number } };
        if (typeof r.id === "string" && typeof r.displayName?.text === "string") {
          returned.push({
            id: r.id,
            displayName: r.displayName.text,
            address: typeof r.formattedAddress === "string" ? r.formattedAddress : "",
            location:
              r.location && typeof r.location.latitude === "number" && typeof r.location.longitude === "number"
                ? { lat: r.location.latitude, lng: r.location.longitude }
                : null,
          });
        }
      }
      okQueries.add(textQuery.trim().toLowerCase());
      const payload = b === "emptyNoKey" ? {} : { places };
      return { ok: true, status: 200, json: async () => payload };
    } finally {
      inflight -= 1;
    }
  };

  return {
    fetchImpl,
    requests,
    returned,
    okQueries,
    maxInflight: () => maxInflight,
    searches: () => requests.filter((r) => r.isSearch),
    centreRequests: () => requests.filter((r) => !r.isSearch),
  };
}

// ---------------------------------------------------------------------------
// Builders and invariant checks
// ---------------------------------------------------------------------------

function stopOf(place: string, kind: StopKind = "sight"): ProposedStop {
  return { time: "10:00", place, area: "TravellerArea-private", kind, description: "TravellerDesc-private", cost: 0 };
}

function ctxOf(over: Partial<VerifyContext> = {}): VerifyContext {
  return {
    destination: DEST,
    totalDays: 5,
    fromDay: 1,
    pace: "balanced",
    usedKeys: new Set<string>(),
    dayTripsAllowed: 0,
    deadlineMs: SHORT_DEADLINE_MS,
    ...over,
  };
}

function depsOf(world: World, over: Partial<VerifyDeps> = {}): VerifyDeps {
  return { fetchImpl: world.fetchImpl, now: () => 0, cache: createVerificationCache(), ...over };
}

function allStops(res: BatchVerification): Array<{ stop: VerifiedStop; dayTrip: boolean }> {
  const out: Array<{ stop: VerifiedStop; dayTrip: boolean }> = [];
  for (const d of res.days) {
    for (const s of d.evaluation.stops) out.push({ stop: s, dayTrip: d.dayTrip });
    for (const s of d.evaluation.removed) out.push({ stop: s, dayTrip: d.dayTrip });
  }
  return out;
}

/** Property 13 output checks. */
function assertSound(
  res: BatchVerification,
  world: World,
  behaviourOf: (p: string) => Behaviour,
  destination: string,
  centre: { lat: number; lng: number } | null,
): void {
  const ids = new Set<string>();
  for (const { stop, dayTrip } of allStops(res)) {
    expect(typeof stop.placeId).toBe("string");
    expect(stop.placeId.length).toBeGreaterThan(0);
    expect(stop.key).toBe(stop.placeId);
    expect(ids.has(stop.placeId)).toBe(false);
    ids.add(stop.placeId);

    const rec = world.returned.find(
      (r) =>
        r.id === stop.placeId &&
        r.displayName === stop.placeName &&
        r.location !== null &&
        r.location.lat === stop.location.lat &&
        r.location.lng === stop.location.lng,
    );
    expect(rec).toBeDefined();
    expect(placeMatches(stop.place, [stop.placeName])).toBe(true);
    expect(isWithinDestination({ address: rec!.address, location: rec!.location }, destination, centre, dayTrip)).toBe(true);
    expect(isSafeMapsUrl(stop.mapsUrl)).toBe(true);
    expect(stop.mapsUrl).toBe(buildMapsUrl(stop.placeId, stop.placeName));
    expect(isGenericTitle(stop.place)).toBe(false);
    const b = behaviourOf(stop.place);
    expect(typeof b === "string" && MAY_VERIFY.has(b)).toBe(true);
  }
}

/** Property 13/14 request checks. */
function assertRequests(world: World, proposedPlaces: ReadonlySet<string>, usedKeys: ReadonlySet<string>, destination = DEST): void {
  const searches = world.searches();
  expect(searches.length).toBeLessThanOrEqual(VERIFY_CAP);
  const seen = new Set<string>();
  for (const r of searches) {
    expect(r.method).toBe("POST");
    expect(r.url.startsWith("https://places.googleapis.com/")).toBe(true);
    expect(r.url.endsWith("/places:searchText")).toBe(true);
    expect(r.headers["X-Goog-FieldMask"]).toBe(FIELD_MASK);
    expect(Object.keys(r.headers).sort()).toEqual(["Content-Type", "X-Goog-Api-Key", "X-Goog-FieldMask"]);
    expect(r.keys).toEqual(["maxResultCount", "textQuery"]);
    expect(r.textQuery.endsWith(`, ${destination}`)).toBe(true);
    const place = r.textQuery.slice(0, r.textQuery.length - destination.length - 2);
    expect(proposedPlaces.has(place)).toBe(true);
    expect(isGenericTitle(place)).toBe(false);
    expect(usedKeys.has(nameKey(place))).toBe(false);
    const q = r.textQuery.trim().toLowerCase();
    expect(seen.has(q)).toBe(false); // same query at most once, no retry
    seen.add(q);
    expect(r.body).not.toContain("Traveller");
  }
  for (const r of world.centreRequests()) {
    expect(r.keys).toEqual(["textQuery"]);
    expect(r.textQuery).toBe(destination);
  }
  expect(world.centreRequests().length).toBeLessThanOrEqual(1);
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const behaviourArb = fc.constantFrom<Behaviour>(
  "ok", "ok", "ok", "ok", "ok", "okSecond", "far", "mid", "noid", "noloc", "empty", "emptyNoKey",
  "wrongname", "nonok", "throw", "badjson", "shared", "okFourth", "hang",
);
const FAILING: Behaviour[] = ["far", "noid", "noloc", "empty", "emptyNoKey", "wrongname", "nonok", "throw", "badjson", "okFourth", "hang"];
const failingArb = fc.constantFrom<Behaviour>(...FAILING);
const kindArb = fc.constantFrom<StopKind>("sight", "meal", "experience");

const stopArb = fc.oneof(
  { weight: 9, arbitrary: fc.record({ place: fc.nat(NAMES.length - 1).map((i) => NAMES[i]), kind: kindArb }) },
  { weight: 1, arbitrary: fc.record({ place: fc.constantFrom(...GENERIC_TITLES), kind: kindArb }) },
);
const dayArb = fc.record({
  title: fc.constantFrom("Old town", "Coast", "Hills"),
  dayTrip: fc.boolean(),
  stops: fc.array(stopArb, { maxLength: 9 }),
});

const scenarioArb = fc.record({
  behaviours: fc.array(behaviourArb, { minLength: NAMES.length, maxLength: NAMES.length }),
  days: fc.array(dayArb, { minLength: 1, maxLength: 5 }),
  used: fc.array(fc.nat(NAMES.length - 1), { maxLength: 8 }),
  dayTripsAllowed: fc.integer({ min: 0, max: 2 }),
  pace: fc.constantFrom("relaxed", "balanced", "packed"),
  totalDays: fc.integer({ min: 1, max: 14 }),
  fromDay: fc.integer({ min: 1, max: 4 }),
  concurrency: fc.option(fc.integer({ min: 1, max: 6 }), { nil: undefined }),
  replacements: fc.array(
    fc.record({ dayOffset: fc.nat(6), slot: fc.nat(10), place: fc.nat(NAMES.length - 1).map((i) => NAMES[i]), kind: kindArb }),
    { maxLength: 12 },
  ),
});
type Scenario = typeof scenarioArb extends fc.Arbitrary<infer T> ? T : never;

function toDays(sc: Scenario): ProposedDay[] {
  return sc.days.map((d) => ({
    title: d.title,
    dayTrip: d.dayTrip,
    stops: d.stops.map((s) => stopOf(s.place, s.kind)),
  }));
}
function behaviourFn(sc: Scenario): (place: string) => Behaviour {
  return (place) => {
    const i = NAMES.indexOf(place);
    return i < 0 ? "ok" : sc.behaviours[i];
  };
}
function ctxFor(sc: Scenario): VerifyContext {
  return ctxOf({
    totalDays: sc.totalDays,
    fromDay: sc.fromDay,
    pace: sc.pace as VerifyContext["pace"],
    dayTripsAllowed: sc.dayTripsAllowed,
    usedKeys: new Set(sc.used.map((i) => nameKey(NAMES[i]))),
  });
}
function replacementsFor(sc: Scenario) {
  return sc.replacements.map((r) => ({
    day: sc.fromDay + r.dayOffset,
    slot: r.slot,
    stop: stopOf(r.place, r.kind),
  }));
}
function proposedPlaces(sc: Scenario): Set<string> {
  const set = new Set<string>();
  for (const d of sc.days) for (const s of d.stops) set.add(s.place);
  for (const r of sc.replacements) set.add(r.place);
  return set;
}

// ---------------------------------------------------------------------------
// Property 13
// ---------------------------------------------------------------------------

// Feature: trustworthy-itinerary, Property 13: Verifier soundness
describe("Property 13: Verifier soundness", () => {
  it("every output stop is a verified place and only '<place>, <destination>' is sent", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (sc) => {
        const behaviourOf = behaviourFn(sc);
        const world = makeWorld(behaviourOf);
        const deps = depsOf(world, { concurrency: sc.concurrency });
        const ctx = ctxFor(sc);

        const res = await verifyProposed(toDays(sc), ctx, deps);
        expect(res.days).toHaveLength(sc.days.length);
        assertSound(res, world, behaviourOf, DEST, CENTRE);

        const reps = replacementsFor(sc);
        const res2 = await verifyReplacements(res, reps, ctx, deps);
        assertSound(res2, world, behaviourOf, DEST, CENTRE);

        assertRequests(world, proposedPlaces(sc), ctx.usedKeys);
        expect(JSON.stringify(res2)).not.toContain(TEST_KEY);
      }),
      { numRuns: NUM_RUNS },
    );
  }, 120_000);

  it("a stop known only from a SearXNG snippet is not verified", async () => {
    // The verifier has no snippet input at all; a name that exists only in a
    // snippet gets no Places result and so cannot become a stop.
    const snippet = "Travellers rave about the Hidden Cove Teahouse near the harbour.";
    expect(snippet).toContain("Hidden Cove Teahouse");
    const world = makeWorld((p) => (p === "Hidden Cove Teahouse" ? "empty" : "ok"));
    const res = await verifyProposed(
      [{ title: "Day", dayTrip: false, stops: [stopOf("Hidden Cove Teahouse", "meal"), stopOf(NAMES[0])] }],
      ctxOf(),
      depsOf(world),
    );
    const places = allStops(res).map((x) => x.stop.place);
    expect(places).not.toContain("Hidden Cove Teahouse");
    expect(places).toContain(NAMES[0]);
  });

  it("a hallucinated place with no Places result is dropped", async () => {
    const world = makeWorld((p) => (p === "Starlight Spire of Atlantis" ? "empty" : "ok"));
    const res = await verifyProposed(
      [{ title: "Day", dayTrip: false, stops: [stopOf(NAMES[1]), stopOf("Starlight Spire of Atlantis"), stopOf(NAMES[2])] }],
      ctxOf({ totalDays: 3, fromDay: 2 }),
      depsOf(world),
    );
    const places = allStops(res).map((x) => x.stop.place);
    expect(places).not.toContain("Starlight Spire of Atlantis");
    expect(places).toEqual(expect.arrayContaining([NAMES[1], NAMES[2]]));
    expect(res.stats.removed).toBeGreaterThanOrEqual(1);
  });

  it("an address containing the destination is accepted without a centre", async () => {
    const dest = "Noctrium";
    const place = "Lantern Hall Museum";
    const far = { lat: 55, lng: 5 }; // nowhere near any centre
    const mk = (address: string) => ({
      custom: [rawPlace("test-id-addr", place, address, far)],
    });

    const accept = makeWorld(() => mk(`Old Quarter, ${dest}, Testland`), { destination: dest, centre: false });
    const ok = await verifyProposed(
      [{ title: "Day", dayTrip: false, stops: [stopOf(place)] }],
      ctxOf({ destination: dest }),
      depsOf(accept),
    );
    expect(allStops(ok).map((x) => x.stop.placeId)).toEqual(["test-id-addr"]);

    const reject = makeWorld(() => mk("Old Quarter, Elsewhere, Testland"), { destination: dest, centre: false });
    const no = await verifyProposed(
      [{ title: "Day", dayTrip: false, stops: [stopOf(place)] }],
      ctxOf({ destination: dest }),
      depsOf(reject),
    );
    expect(allStops(no)).toHaveLength(0);
  });

  it("a duplicate placeId from two different names keeps the first", async () => {
    const world = makeWorld(() => "shared");
    const res = await verifyProposed(
      [{ title: "Day", dayTrip: false, stops: [stopOf("Aurelia Fort"), stopOf("Fort of Aurelia"), stopOf(NAMES[9])] }],
      ctxOf(),
      depsOf(world),
    );
    const got = allStops(res).map((x) => ({ place: x.stop.place, id: x.stop.placeId }));
    expect(got).toEqual([{ place: "Aurelia Fort", id: "shared-id" }]);
  });

  it("a candidate with a missing id, missing location or wrong name is rejected", async () => {
    for (const b of ["noid", "noloc", "wrongname", "far", "okFourth"] as Behaviour[]) {
      const world = makeWorld(() => b);
      const res = await verifyProposed(
        [{ title: "Day", dayTrip: false, stops: [stopOf(NAMES[3]), stopOf(NAMES[4])] }],
        ctxOf(),
        depsOf(world),
      );
      expect(allStops(res)).toHaveLength(0);
    }
  });

  it("a later candidate among the first three is accepted; a day trip widens the area", async () => {
    const world = makeWorld((p) => (p === NAMES[5] ? "okSecond" : "mid"));
    const res = await verifyProposed(
      [
        { title: "Day", dayTrip: false, stops: [stopOf(NAMES[5]), stopOf(NAMES[6])] },
        { title: "Trip", dayTrip: true, stops: [stopOf(NAMES[7])] },
      ],
      ctxOf({ dayTripsAllowed: 1 }),
      depsOf(world),
    );
    const byPlace = new Map(allStops(res).map((x) => [x.stop.place, x.stop.placeId]));
    expect(byPlace.get(NAMES[5])).toBe(`test-id-5`);
    expect(byPlace.has(NAMES[6])).toBe(false); // 100 km away on an ordinary day
    expect(byPlace.has(NAMES[7])).toBe(true); // 100 km away on an accepted day trip
  });
});

// ---------------------------------------------------------------------------
// Property 14
// ---------------------------------------------------------------------------

// Feature: trustworthy-itinerary, Property 14: Verifier resilience and bounds
describe("Property 14: Verifier resilience and bounds", () => {
  it("never throws, stays within the lookup cap and concurrency, never repeats a query", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (sc) => {
        const behaviourOf = behaviourFn(sc);
        const world = makeWorld(behaviourOf);
        const concurrency = sc.concurrency ?? VERIFY_CONCURRENCY;
        const deps = depsOf(world, { concurrency: sc.concurrency });
        const ctx = ctxFor(sc);

        const res = await verifyProposed(toDays(sc), ctx, deps);
        const res2 = await verifyReplacements(res, replacementsFor(sc), ctx, deps);

        expect(res2.stats.lookups).toBeLessThanOrEqual(VERIFY_CAP);
        expect(world.searches().length).toBeLessThanOrEqual(res2.stats.lookups);
        expect(world.maxInflight()).toBeLessThanOrEqual(concurrency);
        assertRequests(world, proposedPlaces(sc), ctx.usedKeys);
      }),
      { numRuns: NUM_RUNS },
    );
  }, 120_000);

  it("failures, throws, bad responses and timeouts verify nothing and are not retried", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(failingArb, { minLength: NAMES.length, maxLength: NAMES.length }),
        fc.array(dayArb, { minLength: 1, maxLength: 4 }),
        async (behaviours, days) => {
          const behaviourOf = (p: string): Behaviour => {
            const i = NAMES.indexOf(p);
            return i < 0 ? "empty" : behaviours[i];
          };
          const world = makeWorld(behaviourOf);
          const proposed: ProposedDay[] = days.map((d) => ({
            title: d.title,
            dayTrip: d.dayTrip,
            stops: d.stops.map((s) => stopOf(s.place, s.kind)),
          }));
          const ctx = ctxOf({ totalDays: 4 });
          const deps = depsOf(world);
          const res = await verifyProposed(proposed, ctx, deps);
          const reps = proposed.flatMap((d, i) => d.stops.slice(0, 2).map((s, k) => ({ day: 1 + i, slot: k, stop: s })));
          const res2 = await verifyReplacements(res, reps, ctx, deps);

          for (const r of [res, res2]) {
            expect(allStops(r)).toHaveLength(0);
            for (const d of r.days) expect(d.evaluation.status).toBe("withheld");
          }
          const places = new Set<string>();
          for (const d of days) for (const s of d.stops) places.add(s.place);
          assertRequests(world, places, new Set());
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, 120_000);

  it("serves a repeated query from the cache without a new lookup", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (sc) => {
        const behaviourOf = behaviourFn(sc);
        const cache = createVerificationCache();
        const ctx = ctxFor(sc);
        const first = makeWorld(behaviourOf);
        await verifyProposed(toDays(sc), ctx, { fetchImpl: first.fetchImpl, now: () => 0, cache });
        const second = makeWorld(behaviourOf);
        await verifyProposed(toDays(sc), ctx, { fetchImpl: second.fetchImpl, now: () => 0, cache });
        for (const r of second.searches()) {
          expect(first.okQueries.has(r.textQuery.trim().toLowerCase())).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  }, 120_000);

  it("a lookup beyond the cap is a failed verification", async () => {
    const world = makeWorld(() => "ok");
    const days: ProposedDay[] = [0, 1, 2, 3, 4].map((d) => ({
      title: `Day ${d}`,
      dayTrip: false,
      stops: NAMES.slice(d * 8, d * 8 + 8).map((n) => stopOf(n)),
    })); // 40 distinct names
    const res = await verifyProposed(days, ctxOf({ totalDays: 7, fromDay: 2, pace: "packed" }), depsOf(world));
    expect(world.searches()).toHaveLength(VERIFY_CAP);
    expect(res.stats.lookups).toBe(VERIFY_CAP);
    expect(allStops(res).length).toBeLessThanOrEqual(VERIFY_CAP);
    const verifiedPlaces = new Set(allStops(res).map((x) => x.stop.place));
    for (const r of world.searches()) {
      expect(r.textQuery.endsWith(`, ${DEST}`)).toBe(true);
    }
    expect(verifiedPlaces.size).toBe(allStops(res).length);
  });

  it("the same failed place on two days is queried once", async () => {
    const world = makeWorld(() => "nonok");
    await verifyProposed(
      [
        { title: "A", dayTrip: false, stops: [stopOf(NAMES[0])] },
        { title: "B", dayTrip: false, stops: [stopOf(NAMES[0])] },
      ],
      ctxOf(),
      depsOf(world),
    );
    expect(world.searches()).toHaveLength(1);
  });

  it("with no Places key nothing is requested and every day is withheld", async () => {
    delete process.env[KEY_ENV];
    const world = makeWorld(() => "ok");
    const days: ProposedDay[] = [
      { title: "A", dayTrip: false, stops: [stopOf(NAMES[0]), stopOf(NAMES[1])] },
      { title: "B", dayTrip: false, stops: [stopOf(NAMES[2])] },
    ];
    const deps = depsOf(world);
    const res = await verifyProposed(days, ctxOf({ fromDay: 3 }), deps);
    expect(world.requests).toHaveLength(0);
    expect(res.days.map((d) => d.day)).toEqual([3, 4]);
    for (const d of res.days) {
      expect(d.evaluation.status).toBe("withheld");
      expect(d.evaluation.stops).toHaveLength(0);
    }
    const res2 = await verifyReplacements(res, [{ day: 3, slot: 0, stop: stopOf(NAMES[5]) }], ctxOf({ fromDay: 3 }), deps);
    expect(world.requests).toHaveLength(0);
    expect(allStops(res2)).toHaveLength(0);
    const heroes = await attachHeroStops(res.days, ctxOf(), { ...deps, enrich: async () => { throw new Error("must not run"); } });
    expect(heroes.size).toBe(0);
  });

  it("finishes by the deadline when every lookup hangs", async () => {
    const world = makeWorld(() => "hang");
    const started = Date.now();
    const res = await verifyProposed(
      [{ title: "A", dayTrip: false, stops: [stopOf(NAMES[0]), stopOf(NAMES[1]), stopOf(NAMES[2])] }],
      ctxOf({ deadlineMs: 40 }),
      depsOf(world),
    );
    expect(Date.now() - started).toBeLessThan(1500);
    expect(res.timedOut).toBe(true);
    expect(allStops(res)).toHaveLength(0);
  });

  it("starts no lookup once the deadline has passed", async () => {
    const world = makeWorld(() => "ok");
    const res = await verifyProposed(
      [{ title: "A", dayTrip: false, stops: [stopOf(NAMES[0]), stopOf(NAMES[1])] }],
      ctxOf({ deadlineMs: 0 }),
      depsOf(world, { now: () => 1000 }),
    );
    expect(world.searches()).toHaveLength(0);
    expect(allStops(res)).toHaveLength(0);
  });

  it("a throwing cache or throwing fetch never escapes", async () => {
    const throwingCache = {
      get: () => { throw new Error("boom"); },
      set: () => { throw new Error("boom"); },
    };
    const world = makeWorld(() => "ok");
    const res = await verifyProposed(
      [{ title: "A", dayTrip: false, stops: [stopOf(NAMES[0])] }],
      ctxOf(),
      depsOf(world, { cache: throwingCache }),
    );
    expect(res.days).toHaveLength(1);
    const res2 = await verifyProposed(
      [{ title: "A", dayTrip: false, stops: [stopOf(NAMES[0])] }],
      ctxOf(),
      { fetchImpl: () => { throw new Error("sync throw"); }, now: () => 0, cache: createVerificationCache() },
    );
    expect(allStops(res2)).toHaveLength(0);
  });

  it("hero lookups stay in the reserve, use verified stops and valid photo refs", async () => {
    const stopFor = (n: number, i: number): VerifiedStop => ({
      key: `test-id-${n}-${i}`,
      placeId: `test-id-${n}-${i}`,
      placeName: `Test Place ${n}-${i}`,
      mapsUrl: buildMapsUrl(`test-id-${n}-${i}`, `Test Place ${n}-${i}`),
      location: { lat: 10, lng: 20 },
      time: "10:00",
      place: `Test Place ${n}-${i}`,
      area: "Centre",
      kind: "sight",
      description: "A place",
      cost: 0,
      slot: i,
    });
    const photoArb = fc.constantFrom<"good" | "bad" | "none" | "throw">("good", "bad", "none", "throw");
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            verified: fc.boolean(),
            photos: fc.array(photoArb, { minLength: 1, maxLength: 5 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        async (spec) => {
          const days: BatchVerification["days"] = spec.map((d, n) => ({
            day: n + 1,
            title: `Day ${n + 1}`,
            dayTrip: false,
            evaluation: {
              status: d.verified ? "verified" : "withheld",
              stops: d.photos.map((_, i) => stopFor(n, i)),
              removed: [],
            },
          }));
          const behaviourByPlace = new Map<string, string>();
          spec.forEach((d, n) => d.photos.forEach((p, i) => behaviourByPlace.set(`test-id-${n}-${i}`, p)));
          const calls: string[] = [];
          const enrich = (async (input: { placeId?: string }) => {
            const id = input.placeId ?? "";
            calls.push(id);
            const b = behaviourByPlace.get(id);
            if (b === "throw") throw new Error("details failed");
            const name = b === "good" ? `places/${id}/photos/ph1` : b === "bad" ? "not a photo ref" : undefined;
            return {
              mode: "live" as const,
              data: { placeId: id, photos: name ? [{ name }] : [] },
            };
          }) as unknown as VerifyDeps["enrich"];

          const out = await attachHeroStops(days, ctxOf({ deadlineMs: 1000 }), { now: () => 0, enrich });
          expect(calls.length).toBeLessThanOrEqual(HERO_LOOKUP_RESERVE);
          const perDay = new Map<string, number>();
          for (const id of calls) {
            const day = id.split("-")[2];
            perDay.set(day, (perDay.get(day) ?? 0) + 1);
          }
          perDay.forEach((n) => expect(n).toBeLessThanOrEqual(HERO_TRIES_PER_DAY));
          out.forEach((v, day) => {
            const d = days.find((x) => x.day === day)!;
            expect(d.evaluation.status).toBe("verified");
            expect(d.evaluation.stops.some((s) => s.placeId === v.placeId)).toBe(true);
            expect(v.photoRef).toBe(`places/${v.placeId}/photos/ph1`);
            expect(isValidPhotoRef(v.photoRef)).toBe(true);
          });
          const plain = await attachHeroes(days, ctxOf({ deadlineMs: 1000 }), { now: () => 0, enrich });
          plain.forEach((ref) => expect(isValidPhotoRef(ref)).toBe(true));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, 120_000);
});
