/**
 * Bug condition exploration: a realistic Goa first batch (from Delhi, 4 days,
 * batch days 1-3, balanced, 2 travellers, Culture & food) must not end
 * `unverified` when the model names real places and Google Places answers with
 * matching, in-destination results.
 *
 * Only the Places HTTP responses (Text Search (New) shape) and the model text
 * are faked. The real runItineraryBatch, verifier, geo and match code run.
 * The key is a fake value set with vi.stubEnv.
 *
 * Variants meeting the bug condition assert the fixed behaviour. Genuine
 * failure variants (429, truncated first day, tight deadline) only log the
 * stage observed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runItineraryBatch, type BatchDeps } from "../lib/itinerary/batch-service";
import { parseBatchText } from "../lib/itinerary/batch-parse";
import { type BatchRequest, type BatchResponse } from "../lib/itinerary/batch-wire";
import { clearGroundingMemo } from "../lib/itinerary/grounding-memo";
import { createVerificationCache } from "../lib/itinerary/verification-cache";
import { isWithinDestination } from "../lib/itinerary/geo";
import { dayLimits, resolvePace } from "../lib/itinerary/pace";
import { isGenericTitle, isNonStopTitle, isVenueSpecificMeal } from "../lib/itinerary/place-key";
import { placeMatches } from "../lib/grounding/place-match";
import { EMPTY_BUNDLE } from "../lib/grounding/types";
import {
  resolveLocation,
  searchPlaceForVerification,
  type PostFetchLike,
} from "../lib/providers/google-places";
import type { TripContext } from "../lib/types";

const DETAILS_BASE = "https://places.googleapis.com/v1/places/";
const TOTAL_DAYS = 4;
// Text Search for the state of Goa returns roughly its centroid.
const GOA_CENTRE = { latitude: 15.2993, longitude: 74.124 };

interface Fixture {
  /** Name the model writes. */
  model: string;
  /** Alternative model spelling used by the name-variant runs. */
  alt?: string;
  /** Google display name. */
  google: string;
  /** Address without the pin code. */
  area: string;
  /** Address pin code. */
  pin: string;
  lat: number;
  lng: number;
  kind: "sight" | "meal";
  time: string;
}

const F: Record<string, Fixture> = {
  basilica: { model: "Basilica of Bom Jesus", google: "Basilica of Bom Jesus", area: "Bainguinim, Old Goa", pin: "403402", lat: 15.5009, lng: 73.9116, kind: "sight", time: "14:00" },
  se: { model: "Se Cathedral", google: "Sé Cathedral", area: "Velha Goa", pin: "403402", lat: 15.5031, lng: 73.9125, kind: "sight", time: "15:30" },
  fontainhas: { model: "Fontainhas", alt: "Fontainhas Latin Quarter", google: "Fontainhas", area: "Panaji", pin: "403001", lat: 15.4965, lng: 73.8294, kind: "sight", time: "09:30" },
  reis: { model: "Reis Magos Fort", google: "Reis Magos Fort", area: "Verem, Reis Magos", pin: "403114", lat: 15.4929, lng: 73.8088, kind: "sight", time: "11:30" },
  mums: { model: "Mum's Kitchen", google: "Mum's Kitchen", area: "Porvorim", pin: "403521", lat: 15.5069, lng: 73.8171, kind: "meal", time: "13:30" },
  museum: { model: "Goa State Museum", google: "Goa State Museum", area: "Patto, Panaji", pin: "403001", lat: 15.4985, lng: 73.8285, kind: "sight", time: "15:30" },
  aguada: { model: "Fort Aguada", alt: "Aguada Fort", google: "Fort Aguada", area: "Sinquerim, Candolim", pin: "403515", lat: 15.4925, lng: 73.7737, kind: "sight", time: "09:30" },
  chapora: { model: "Chapora Fort", google: "Chapora Fort", area: "Chapora", pin: "403509", lat: 15.6055, lng: 73.736, kind: "sight", time: "11:30" },
  mangueshi: { model: "Mangueshi Temple", alt: "Shri Mangueshi Temple", google: "Shree Mangueshi Temple", area: "Priol, Ponda", pin: "403401", lat: 15.4486, lng: 73.9763, kind: "sight", time: "14:30" },
  gunpowder: { model: "Gunpowder", google: "Gunpowder", area: "Assagao", pin: "403507", lat: 15.5883, lng: 73.7747, kind: "meal", time: "19:30" },
};

const DAYS: Array<{ title: string; keys: string[] }> = [
  { title: "Arrival and Old Goa", keys: ["basilica", "se"] },
  { title: "Panaji heritage and Latin quarter", keys: ["fontainhas", "reis", "mums", "museum"] },
  { title: "Forts, temples and coast", keys: ["aguada", "chapora", "mangueshi", "gunpowder"] },
];

interface Variant {
  name: string;
  destination: string;
  pin: boolean;
  /** Use the model's alternative spellings for the stops that have one. */
  altNames?: "some" | "all";
  /** Genuine failure: log the stage only, do not assert the fixed behaviour. */
  genuine?: boolean;
  places?: "ok" | "429";
  truncateFirstDay?: boolean;
  /** Delay of every Places answer, ms. */
  placesDelayMs?: number;
  budgetMs?: number;
}

function modelName(f: Fixture, v: Variant, key: string): string {
  if (!f.alt) return f.model;
  if (v.altNames === "all") return f.alt;
  if (v.altNames === "some" && (key === "aguada" || key === "fontainhas")) return f.alt;
  return f.model;
}

function modelText(v: Variant): string {
  const days = DAYS.map((d) => ({
    title: d.title,
    dayTrip: false,
    activities: d.keys.map((k) => {
      const f = F[k];
      const place = modelName(f, v, k);
      return {
        time: f.time,
        place,
        area: f.area.split(", ").pop(),
        kind: f.kind,
        description: `A visit to ${place}`,
        cost: f.kind === "meal" ? 900 : 300,
      };
    }),
  }));
  const text = JSON.stringify({ days });
  if (!v.truncateFirstDay) return text;
  const cutAt = text.indexOf('"place":"Se Cathedral"');
  return text.slice(0, cutAt + 12);
}

function addressOf(f: Fixture, v: Variant): string {
  return v.pin ? `${f.area}, Goa ${f.pin}, India` : `${f.area}, Goa, India`;
}

function makeFetch(v: Variant, calls: { search: number; failed: number }): PostFetchLike {
  return async (url, init) => {
    if (v.placesDelayMs) await new Promise((r) => setTimeout(r, v.placesDelayMs));
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
    calls.search += 1;
    if (v.places === "429") {
      calls.failed += 1;
      return { ok: false, status: 429, json: async () => ({}) };
    }
    // destination-centre lookup (resolveLocation sends no maxResultCount)
    if (typeof body.maxResultCount !== "number") {
      if (q.trim().toLowerCase() === v.destination.trim().toLowerCase()) {
        return { ok: true, status: 200, json: async () => ({ places: [{ id: "goa-centre", location: GOA_CENTRE }] }) };
      }
      calls.failed += 1;
      return { ok: false, status: 400, json: async () => ({}) };
    }
    for (const [key, f] of Object.entries(F)) {
      const name = modelName(f, v, key);
      if (q === `${name}, ${v.destination}`) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            places: [
              {
                id: `ChIJ-goa-${key}`,
                displayName: { text: f.google },
                formattedAddress: addressOf(f, v),
                location: { latitude: f.lat, longitude: f.lng },
              },
            ],
          }),
        };
      }
    }
    return { ok: true, status: 200, json: async () => ({ places: [] }) };
  };
}

interface StopStage {
  destination: string;
  modelName: string;
  displayName: string;
  address: string;
  stage: string;
}

/**
 * Classify the stage that drops each proposed stop, with the real helpers the
 * verifier uses (pre-filter, lookup, name match, destination check, min stops).
 */
async function classify(v: Variant, text: string, fetchImpl: PostFetchLike): Promise<{ stops: StopStage[]; days: string[] }> {
  const parsed = parseBatchText(text, 3);
  if (parsed.days.length === 0) {
    return {
      stops: [
        { destination: v.destination, modelName: "-", displayName: "-", address: "-", stage: `parse (text length ${text.length}, truncated ${parsed.truncated})` },
      ],
      days: [],
    };
  }
  const centre = await resolveLocation(v.destination, fetchImpl);
  const stops: StopStage[] = [];
  const days: string[] = [];
  const pace = resolvePace("balanced");
  for (let i = 0; i < parsed.days.length; i++) {
    let okCount = 0;
    for (const s of parsed.days[i].stops) {
      const base = { destination: v.destination, modelName: s.place, displayName: "-", address: "-" };
      if (isGenericTitle(s.place) || isNonStopTitle(s.place, { destination: v.destination }) || (s.kind === "meal" && !isVenueSpecificMeal(s.place))) {
        stops.push({ ...base, stage: "pre-filter" });
        continue;
      }
      const lookup = await searchPlaceForVerification(`${s.place}, ${v.destination}`, fetchImpl, { maxResults: 3 });
      if (lookup.kind === "failed") {
        stops.push({ ...base, stage: "lookup failed" });
        continue;
      }
      const first = lookup.candidates[0];
      if (first) {
        base.displayName = first.displayName;
        base.address = first.formattedAddress;
      }
      const named = lookup.candidates.filter((c) => c.placeId && c.location && placeMatches(s.place, [c.displayName]));
      if (named.length === 0) {
        stops.push({ ...base, stage: lookup.candidates.length === 0 ? "no Places result" : "no name match" });
        continue;
      }
      const inside = named.some((c) =>
        isWithinDestination({ address: c.formattedAddress, location: c.location }, v.destination, centre, false),
      );
      if (!inside) {
        stops.push({ ...base, stage: "outside destination" });
        continue;
      }
      okCount += 1;
      stops.push({ ...base, stage: "ok" });
    }
    const lim = dayLimits(pace, 1 + i, TOTAL_DAYS);
    days.push(`day ${1 + i}: ${okCount} ok stops, min ${lim.min}${okCount < lim.min ? " -> too few" : ""}`);
  }
  return { stops, days };
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

interface Observed {
  resp: BatchResponse;
  lines: string[];
  report: string;
}

async function runVariant(v: Variant): Promise<Observed> {
  const text = modelText(v);
  const calls = { search: 0, failed: 0 };
  const fetchImpl = makeFetch(v, calls);
  const lines: string[] = [];
  const deps: BatchDeps = {
    invokeModel: async () => text,
    fetchImpl,
    hasKey: () => true,
    ground: async () => EMPTY_BUNDLE("disabled"),
    verificationCache: createVerificationCache(),
    logger: (l) => lines.push(l),
    ...(v.budgetMs ? { budgetMs: v.budgetMs } : {}),
  };
  const req: BatchRequest = {
    action: "itinerary-batch",
    context: { ...CONTEXT, destination: v.destination },
    fromDay: 1,
    dayCount: 3,
    usedPlaces: [],
    startDate: "2025-03-01",
  };
  const resp = await runItineraryBatch(req, TOTAL_DAYS, deps);

  // Stage analysis runs after the real run, on a fresh fetch (own counters).
  const analysis = await classify(v, text, makeFetch({ ...v, placesDelayMs: 0 }, { search: 0, failed: 0 }));
  const dropped = analysis.stops.filter((s) => s.stage !== "ok");
  const report = [
    `[unv-first-batch] VARIANT "${v.name}" destination="${v.destination}" pin=${v.pin} genuine=${v.genuine === true}`,
    `  result: source=${resp.source} reason=${resp.reason ?? "-"} verifiedDays=[${resp.verifiedDays}] withheld=[${resp.withheldDays}] stats=${JSON.stringify(resp.stats)} placesCalls=${calls.search}`,
    `  log: ${lines.join(" | ")}`,
    `  stage analysis: ${analysis.stops.length - dropped.length}/${analysis.stops.length} stops ok; ${analysis.days.join("; ")}`,
    ...dropped.map(
      (s) => `  DROPPED stage="${s.stage}" destination="${s.destination}" model="${s.modelName}" display="${s.displayName}" address="${s.address}"`,
    ),
  ].join("\n");
  console.log(report);
  return { resp, lines, report };
}

function expectVerified(o: Observed): void {
  const { resp } = o;
  const msg = `Defect A reproduced (bug condition met but batch not verified).\n${o.report}`;
  expect(resp.days.length, msg).toBeGreaterThan(0);
  for (const day of resp.days) {
    for (const a of day.activities) {
      expect(typeof a.placeId === "string" && a.placeId.length > 0, msg).toBe(true);
      expect(a.verified, msg).toBe(true);
      expect(
        !!a.location && Number.isFinite(a.location.lat) && Number.isFinite(a.location.lng),
        msg,
      ).toBe(true);
    }
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

describe("planner unverified first batch: Goa from Delhi (bug condition)", () => {
  const bug: Variant[] = [
    { name: "Goa, plain addresses", destination: "Goa", pin: false },
    { name: "Goa, pin-coded addresses", destination: "Goa", pin: true },
    { name: "Goa, India, plain addresses", destination: "Goa, India", pin: false },
    { name: "Goa, India, pin-coded addresses", destination: "Goa, India", pin: true },
    { name: "name variants (some stops), Goa", destination: "Goa", pin: true, altNames: "some" },
    { name: "name variants (all stops with an alt), Goa", destination: "Goa", pin: true, altNames: "all" },
    { name: "name variants + Goa, India + pin codes", destination: "Goa, India", pin: true, altNames: "some" },
  ];

  for (const v of bug) {
    it(`verifies days: ${v.name}`, async () => {
      expectVerified(await runVariant(v));
    }, 40_000);
  }
});

describe("planner unverified first batch: genuine failures (stage logged only)", () => {
  it("429 from Places for every lookup", async () => {
    const o = await runVariant({ name: "429", destination: "Goa", pin: true, places: "429", genuine: true });
    expect(o.resp.source).toBe("unavailable");
  }, 40_000);

  it("truncated first day", async () => {
    const o = await runVariant({ name: "truncated first day", destination: "Goa", pin: true, truncateFirstDay: true, genuine: true });
    expect(o.resp.days.length).toBe(0);
  }, 40_000);

  it("tight deadline with slow Places", async () => {
    await runVariant({
      name: "tight deadline",
      destination: "Goa",
      pin: true,
      placesDelayMs: 1500,
      budgetMs: 9_400,
      genuine: true,
    });
  }, 40_000);
});
