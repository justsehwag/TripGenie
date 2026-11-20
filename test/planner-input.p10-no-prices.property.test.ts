import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  buildPlannerInput,
  buildPlannerPrompt,
  buildRepairPrompt,
  selectPlannerCandidates,
  type RepairReason,
} from "../lib/itinerary/planner";
import type { PlaceCandidate } from "../lib/providers/google-places";
import type { DaySpec } from "../lib/itinerary/scheduler";

// Feature: chat-images-bedrock-planner, Property 10: Planner input carries no prices or URLs
// **Validates: Requirements 7.2, 7.4, 7.5, 7.7, 10.5**

const RUNS = 150;

const ALLOWED_CANDIDATE_KEYS = ["hours", "lat", "lng", "name", "placeId", "primaryType", "rating"];
const ALLOWED_INPUT_KEYS = ["candidates", "days", "destination"];
const ALLOWED_DAY_KEYS = [
  "day",
  "dayWindow",
  "dinnerWindow",
  "earliestStart",
  "lunchWindow",
  "maxStops",
  "minStops",
  "weekday",
];

const NAME_WORDS = ["Old", "Fort", "Garden", "Museum", "Temple", "Market", "Harbour", "Cafe", "Bay", "Palace", "Park"];
const TYPES = ["tourist_attraction", "museum", "restaurant", "park", "cafe", null];
const HOURS_LINES = [
  "Monday: 9:00 AM \u2013 5:00 PM",
  "Tuesday: Closed",
  "Wednesday: Open 24 hours",
  "Thursday: 10:00 AM \u2013 6:30 PM",
];
const REASONS: RepairReason[] = ["shape", "fields", "days", "ids", "pace", "start", "feasibility", "text"];

const nameArb = fc
  .array(fc.constantFrom(...NAME_WORDS), { minLength: 1, maxLength: 3 })
  .map((w) => w.join(" "));

interface Gen {
  candidate: PlaceCandidate;
  forbidden: string[];
}

function candidateArb(i: number): fc.Arbitrary<Gen> {
  return fc
    .record({
      name: nameArb,
      primaryType: fc.constantFrom(...TYPES),
      lat: fc.double({ min: -80, max: 80, noNaN: true }),
      lng: fc.double({ min: -170, max: 170, noNaN: true }),
      rating: fc.oneof(fc.constant(null), fc.double({ min: 1, max: 5, noNaN: true })),
      hours: fc.oneof(
        fc.constant(null),
        fc.array(fc.constantFrom(...HOURS_LINES), { minLength: 0, maxLength: 7 }),
      ),
      price: fc.constantFrom("\u20B94,500", "$99.50", "\u20AC12", "\u00A38", "Rs 300", "SGD 45", "INR 1200", "USD 20"),
      priceLevel: fc.constantFrom("PRICE_LEVEL_FREE", "PRICE_LEVEL_EXPENSIVE", "PRICE_LEVEL_VERY_EXPENSIVE"),
      nPhotos: fc.integer({ min: 0, max: 3 }),
    })
    .map((g): Gen => {
      const id = `pid${i}x`;
      const address = `${i + 1} ADDRSENT${i} Lane, Testville`;
      const photos = Array.from({ length: g.nPhotos }, (_, k) => `places/${id}/photos/PHOTOSENT${i}n${k}`);
      const maps = `https://maps.google.com/?cid=URLSENT${i}`;
      const website = `https://www.websitesent${i}.example.com/tickets`;
      const phone = `+65 6${String(1000000 + i).slice(0, 7)}`;
      const review = `REVIEWSENT${i} costs ${g.price} per ticket`;
      const candidate = {
        placeId: id,
        name: g.name,
        address,
        location: { lat: g.lat, lng: g.lng },
        rating: g.rating,
        userRatingCount: 10 + i,
        hours: g.hours === null ? null : { periods: [], weekdayDescriptions: g.hours },
        utcOffsetMinutes: 480,
        types: ["tourist_attraction"],
        primaryType: g.primaryType,
        businessStatus: "OPERATIONAL",
        googleMapsUri: maps,
        photos,
        // Extra fields a candidate may carry at runtime.
        price: g.price,
        priceLevel: g.priceLevel,
        website,
        websiteUri: website,
        phone,
        nationalPhoneNumber: phone,
        reviews: [{ text: review }],
        webDetails: {
          checked: true,
          price: g.price,
          sources: [{ url: website, title: `SRCSENT${i}` }],
        },
        sources: [{ url: website, title: `SRCSENT${i}` }],
      } as unknown as PlaceCandidate;
      const forbidden = [
        address,
        maps,
        website,
        phone,
        review,
        g.price,
        g.priceLevel,
        `ADDRSENT${i}`,
        `URLSENT${i}`,
        `websitesent${i}`,
        `REVIEWSENT${i}`,
        `SRCSENT${i}`,
        ...photos,
        ...(photos.length > 0 ? [`PHOTOSENT${i}`] : []),
      ];
      return { candidate, forbidden };
    });
}

const candidatesArb = fc
  .integer({ min: 0, max: 40 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => candidateArb(i))))
  .map((arr) => arr as Gen[]);

const specArb = (day: number): fc.Arbitrary<DaySpec> =>
  fc
    .record({
      weekday: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 6 })),
      min: fc.integer({ min: 1, max: 3 }),
      extra: fc.integer({ min: 0, max: 3 }),
      earliestMin: fc.integer({ min: 540, max: 840 }),
    })
    .map(
      (s): DaySpec =>
        ({
          day,
          date: null,
          weekday: s.weekday,
          limits: { min: s.min, max: s.min + s.extra },
          earliestMin: s.earliestMin,
        }) as DaySpec,
    );

const specsArb = fc
  .integer({ min: 1, max: 5 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => specArb(i + 1))))
  .map((a) => a as DaySpec[]);

const destinationArb = fc.constantFrom("Singapore", "Goa", "Kyoto", "Lisbon");

const SCHEME_URL = /https?:\/\/|www\./i;
const DOMAIN = /\b[a-z0-9-]+\.(com|net|org|io|co|in|info|biz|app|me|travel)\b/i;
const CURRENCY_SYMBOL = /[$\u20AC\u00A3\u20B9\u00A5]/;
const CURRENCY_CODE = /\b(USD|INR|EUR|GBP|SGD|AUD|JPY|Rs)\b/;
const PRICE_WORDS = /PRICE_LEVEL|priceLevel|\bprice\b|photos\/|googleMapsUri|website|webDetails|\bsources?\b/i;

function expectClean(text: string, forbidden: string[]): void {
  for (const f of forbidden) expect(text.includes(f), `leaked ${f}`).toBe(false);
  expect(text).not.toMatch(SCHEME_URL);
  expect(text).not.toMatch(DOMAIN);
  expect(text).not.toMatch(CURRENCY_SYMBOL);
  expect(text).not.toMatch(CURRENCY_CODE);
  expect(text).not.toMatch(PRICE_WORDS);
}

function expectAllowedShape(user: string, extraTopKeys: string[] = []): void {
  const parsed = JSON.parse(user) as Record<string, unknown>;
  expect(Object.keys(parsed).sort()).toEqual([...ALLOWED_INPUT_KEYS, ...extraTopKeys].sort());
  for (const d of parsed.days as Array<Record<string, unknown>>) {
    expect(Object.keys(d).sort()).toEqual(ALLOWED_DAY_KEYS);
  }
  for (const c of parsed.candidates as Array<Record<string, unknown>>) {
    expect(Object.keys(c).sort()).toEqual(ALLOWED_CANDIDATE_KEYS);
  }
}

describe("Property 10: planner input carries no prices or URLs", () => {
  it("input, prompt and repair prompt contain no price, URL, address or photo, only allowed fields", () => {
    fc.assert(
      fc.property(
        candidatesArb,
        specsArb,
        destinationArb,
        fc.constantFrom(...REASONS),
        fc.integer({ min: 1000, max: 7000 }),
        (gens, specs, destination, reason, timeoutMs) => {
          const kept = gens.map((g) => g.candidate);
          const forbidden = gens.flatMap((g) => g.forbidden);
          const sent = selectPlannerCandidates(kept, specs.length);
          const input = buildPlannerInput(specs, sent, destination);

          // Serialised input.
          const json = JSON.stringify(input);
          expectClean(json, forbidden);
          expectAllowedShape(json);

          // Caps: 12 per requested day, 36 per batch.
          expect(input.candidates.length).toBeLessThanOrEqual(Math.min(12 * specs.length, 36));

          // Prompt.
          const prompt = buildPlannerPrompt(input, { timeoutMs });
          expectClean(prompt.user, forbidden);
          expectAllowedShape(prompt.user);
          for (const f of forbidden) expect(prompt.system.includes(f)).toBe(false);
          expect(prompt.system).not.toMatch(SCHEME_URL);

          // Repair prompt: feedback may only carry reason, day numbers, sent ids and an instruction.
          const ids = input.candidates.map((c) => c.placeId);
          const repair = buildRepairPrompt(
            input,
            { reason, days: specs.map((s) => s.day), placeIds: [...ids, "not-sent-id"] },
            { timeoutMs },
          );
          expect(repair.user).not.toContain("not-sent-id");
          const repairParsed = JSON.parse(repair.user) as { feedback: Record<string, unknown> };
          expect(Object.keys(repairParsed.feedback).sort()).toEqual(["days", "instruction", "placeIds", "reason"]);
          // The feedback instruction is fixed text; scan the whole payload minus the instruction word list.
          expectClean(repair.user.replace(/"instruction":"[^"]*"/, ""), forbidden);
          expectAllowedShape(
            JSON.stringify({ ...(repairParsed as object), feedback: undefined }),
          );
          for (const f of forbidden) expect(repair.system.includes(f)).toBe(false);
          expect(repair.system).not.toMatch(SCHEME_URL);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("never sends more than 12 candidates per day and 36 per batch, and keeps order", () => {
    fc.assert(
      fc.property(candidatesArb, fc.integer({ min: 0, max: 6 }), (gens, dayCount) => {
        const kept = gens.map((g) => g.candidate);
        const sent = selectPlannerCandidates(kept, dayCount);
        expect(sent.length).toBeLessThanOrEqual(Math.min(12 * dayCount, 36));
        expect(sent.length).toBe(Math.min(kept.length, 12 * dayCount, 36));
        expect(sent.map((c) => c.placeId)).toEqual(kept.slice(0, sent.length).map((c) => c.placeId));
      }),
      { numRuns: RUNS },
    );
  });

  it("never sends a candidate whose name looks like a URL", () => {
    const urlNames = [
      "https://tickets.example.com/buy",
      "http://shop.example.org",
      "www.bestdeals.example",
      "bookhere.com",
      "Visit tours.example.net now",
    ];
    fc.assert(
      fc.property(
        candidatesArb,
        fc.array(fc.constantFrom(...urlNames), { minLength: 1, maxLength: 5 }),
        specsArb,
        (gens, bad, specs) => {
          const kept = gens.map((g) => g.candidate);
          const badCands = bad.map(
            (name, i) => ({ ...(kept[0] ?? gens[0]?.candidate ?? {}), placeId: `bad${i}`, name }) as PlaceCandidate,
          );
          const mixed = [...badCands, ...kept];
          const sent = selectPlannerCandidates(mixed, specs.length);
          expect(sent.some((c) => c.placeId.startsWith("bad"))).toBe(false);
          // Even when buildPlannerInput receives them directly.
          const input = buildPlannerInput(specs, mixed, "Singapore");
          expect(input.candidates.some((c) => c.placeId.startsWith("bad"))).toBe(false);
          const prompt = buildPlannerPrompt(input, { timeoutMs: 7000 });
          for (const n of bad) expect(prompt.user.includes(n)).toBe(false);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("example: a fully loaded candidate reaches the model with the seven allowed fields only", () => {
    const gen = fc.sample(candidateArb(0), 1)[0];
    const input = buildPlannerInput(
      [{ day: 1, date: null, weekday: 1, limits: { min: 2, max: 4 }, earliestMin: 540 } as DaySpec],
      [gen.candidate],
      "Singapore",
    );
    expect(Object.keys(input.candidates[0]).sort()).toEqual(ALLOWED_CANDIDATE_KEYS);
    expectClean(JSON.stringify(input), gen.forbidden);
  });
});
