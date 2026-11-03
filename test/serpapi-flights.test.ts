import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  collectItineraries,
  normalizeItinerary,
  fareFromProvider,
  MAX_FLIGHTS,
  FLIGHT_TOKEN,
  type Json,
} from "@/lib/providers/serpapi-flights";

// Feature: live-travel-pricing, Property 3: Itinerary normalisation keeps only real, safe, unique fares

/* ------------------------------------------------------------------------- *
 * Generators
 *
 * Each generated itinerary records, alongside the raw provider shape, enough
 * information to decide independently whether it is renderable and what the
 * normalised output must look like. This lets the property compare the
 * adapter's output against a self-contained reference prediction.
 * ------------------------------------------------------------------------- */

type RawItinerary = Record<string, unknown>;

interface GenItinerary {
  raw: RawItinerary;
  /** Expected to survive normalisation on its own merits (before de-dup/cap). */
  valid: boolean;
  /** The token the output carries when valid. */
  token: string | null;
  price: number | null;
  expectHttpsLogo: boolean;
  expectAirlines: string[];
  expectFlightNumbers: string[];
  expectStops: number | null;
}

const AIRPORT_IDS = ["DEL", "BOM", "BLR", "GOI", "MAA", "CCU", "HYD", "COK", "DXB", "SIN"];
const AIRLINES = ["IndiGo", "Air India", "Vistara", "SpiceJet", "Emirates", "Singapore Airlines"];

/** A token that matches FLIGHT_TOKEN. */
const validToken = fc
  .string({ minLength: 8, maxLength: 40, unit: fc.constantFrom(..."ABCDEFghijkl0123456789+/=_-".split("")) })
  .filter((s) => FLIGHT_TOKEN.test(s));

/** A token that does NOT match FLIGHT_TOKEN (too short or illegal chars). */
const invalidToken = fc.oneof(
  fc.constant(""),
  fc.string({ minLength: 1, maxLength: 7, unit: fc.constantFrom(..."ABC123".split("")) }), // too short
  fc.constant("has spaces here"),
  fc.constant("illegal*chars!"),
);

/** A price field that may be valid (>0 number) or junk. */
const priceGen = fc.oneof(
  fc.integer({ min: 1, max: 500_000 }), // valid
  fc.constant(0),
  fc.integer({ min: -100_000, max: -1 }),
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant("4000"), // non-number
  fc.constant(null),
  fc.constant(undefined),
);

const httpsLogo = fc.constantFrom(
  "https://cdn.example.com/a.png",
  "https://img.serp/x.svg",
);
const nonHttpsLogo = fc.constantFrom(
  "http://cdn.example.com/a.png",
  "ftp://x/y.png",
  "javascript:alert(1)",
  "not a url",
);

/** Build one raw segment. endpointsOk controls whether it has usable id+time pairs. */
function rawSegment(opts: {
  endpointsOk: boolean;
  from: string;
  to: string;
  airline: string | null;
  flightNumber: string | null;
  duration: number | null;
}): Record<string, unknown> {
  const dep: Record<string, unknown> = { id: opts.from, time: "2026-11-01 08:00", name: `${opts.from} Airport` };
  const arr: Record<string, unknown> = { id: opts.to, time: "2026-11-01 10:00", name: `${opts.to} Airport` };
  if (!opts.endpointsOk) {
    // Remove a required field so normalizeSegment drops it.
    delete dep.time;
  }
  const s: Record<string, unknown> = { departure_airport: dep, arrival_airport: arr };
  if (opts.airline !== null) s.airline = opts.airline;
  if (opts.flightNumber !== null) s.flight_number = opts.flightNumber;
  if (opts.duration !== null) s.duration = opts.duration;
  return s;
}

const genItinerary: fc.Arbitrary<GenItinerary> = fc
  .record({
    price: priceGen,
    tokenChoice: fc.oneof(
      fc.record({ kind: fc.constant("booking" as const), value: validToken }),
      fc.record({ kind: fc.constant("departure" as const), value: validToken }),
      fc.record({ kind: fc.constant("none" as const), value: invalidToken }),
    ),
    // Each segment: whether its endpoints are usable, and its airline/flightNumber/duration.
    segs: fc.array(
      fc.record({
        endpointsOk: fc.boolean(),
        from: fc.constantFrom(...AIRPORT_IDS),
        to: fc.constantFrom(...AIRPORT_IDS),
        airline: fc.option(fc.constantFrom(...AIRLINES), { nil: null }),
        flightNumber: fc.option(fc.constantFrom("6E 123", "AI 456", "UK 789"), { nil: null }),
        duration: fc.option(fc.integer({ min: 30, max: 600 }), { nil: null }),
      }),
      { minLength: 0, maxLength: 4 },
    ),
    totalDuration: fc.option(fc.integer({ min: 1, max: 2000 }), { nil: null }),
    logo: fc.oneof(httpsLogo, nonHttpsLogo, fc.constant(undefined)),
    layovers: fc.array(
      fc.record({
        hasId: fc.boolean(),
        id: fc.constantFrom(...AIRPORT_IDS),
        duration: fc.option(fc.integer({ min: 20, max: 300 }), { nil: null }),
      }),
      { minLength: 0, maxLength: 3 },
    ),
    type: fc.option(fc.constantFrom("Round trip", "One way"), { nil: undefined }),
  })
  .map((r) => {
    const raw: RawItinerary = {};

    // price
    if (r.price !== undefined) raw.price = r.price as unknown;

    // segments
    const usableSegs = r.segs.filter((s) => s.endpointsOk);
    raw.flights = r.segs.map((s) =>
      rawSegment({
        endpointsOk: s.endpointsOk,
        from: s.from,
        to: s.to,
        airline: s.airline,
        flightNumber: s.flightNumber,
        duration: s.duration,
      }),
    );

    // token
    let token: string | null = null;
    if (r.tokenChoice.kind === "booking") {
      raw.booking_token = r.tokenChoice.value;
      token = r.tokenChoice.value;
    } else if (r.tokenChoice.kind === "departure") {
      raw.departure_token = r.tokenChoice.value;
      token = r.tokenChoice.value;
    } else {
      // invalid token(s)
      raw.booking_token = r.tokenChoice.value;
    }

    // total_duration / layovers
    if (r.totalDuration !== null) raw.total_duration = r.totalDuration;
    raw.layovers = r.layovers.map((l) => {
      const lo: Record<string, unknown> = {};
      if (l.hasId) lo.id = l.id;
      if (l.duration !== null) lo.duration = l.duration;
      return lo;
    });

    // logo
    if (r.logo !== undefined) raw.airline_logo = r.logo;

    // type
    if (r.type !== undefined) raw.type = r.type;

    // --- Reference prediction of validity ---------------------------------
    const priceValid =
      typeof r.price === "number" && Number.isFinite(r.price) && r.price > 0;
    const hasUsableSegment = usableSegs.length > 0;
    const tokenValid = r.tokenChoice.kind !== "none";

    // Duration resolvable? total_duration>0, else sum of all usable-segment
    // durations + all layover durations when every one is present and sum>0.
    let durationOk: boolean;
    if (r.totalDuration !== null && r.totalDuration > 0) {
      durationOk = true;
    } else if (hasUsableSegment) {
      const allSegDurations = usableSegs.every((s) => s.duration !== null && s.duration > 0);
      const allLayoverDurations = r.layovers.every((l) => l.duration !== null && l.duration > 0);
      let sum = 0;
      if (allSegDurations) for (const s of usableSegs) sum += s.duration as number;
      if (allLayoverDurations) for (const l of r.layovers) sum += l.duration as number;
      durationOk = allSegDurations && allLayoverDurations && sum > 0;
    } else {
      durationOk = false;
    }

    const valid = priceValid && hasUsableSegment && tokenValid && durationOk;

    // Expected airlines (distinct, order of usable segments) and flight numbers.
    const expectAirlines: string[] = [];
    const expectFlightNumbers: string[] = [];
    for (const s of usableSegs) {
      if (s.airline && !expectAirlines.includes(s.airline)) expectAirlines.push(s.airline);
      if (s.flightNumber) expectFlightNumbers.push(s.flightNumber);
    }

    const expectStops =
      r.layovers.length > 0 ? r.layovers.length : usableSegs.length - 1;

    return {
      raw,
      valid,
      token: valid ? token : null,
      price: priceValid ? (r.price as number) : null,
      expectHttpsLogo: typeof r.logo === "string" && r.logo.startsWith("https://"),
      expectAirlines,
      expectFlightNumbers,
      expectStops: valid ? expectStops : null,
    };
  });

describe("Feature: live-travel-pricing, Property 3: Itinerary normalisation keeps only real, safe, unique fares", () => {
  it("normalizeItinerary keeps only real, safe fares with correct derived fields", () => {
    fc.assert(
      fc.property(genItinerary, fc.integer({ min: 1, max: 9 }), (gen, adults) => {
        const out = normalizeItinerary(gen.raw, adults);

        if (!gen.valid) {
          expect(out).toBeNull();
          return;
        }

        expect(out).not.toBeNull();
        const flight = out!;

        // Positive total fare, equal to the provider price.
        expect(flight.totalFare).toBe(gen.price);
        expect(flight.totalFare).toBeGreaterThan(0);

        // Per-person fare matches the single fare-basis definition.
        expect(flight.farePerPerson).toBe(fareFromProvider(gen.price as number, adults).perPerson);

        // Logo: https or null only.
        if (gen.expectHttpsLogo) {
          expect(flight.airlineLogo).not.toBeNull();
          expect(flight.airlineLogo!.startsWith("https://")).toBe(true);
        } else {
          expect(flight.airlineLogo).toBeNull();
        }

        // Airlines distinct and only when supplied.
        expect(flight.airlines).toEqual(gen.expectAirlines);
        expect(new Set(flight.airlines).size).toBe(flight.airlines.length);
        expect(flight.flightNumbers).toEqual(gen.expectFlightNumbers);

        // Stops = layovers.length else segments.length - 1.
        expect(flight.stops).toBe(gen.expectStops);

        // Token present and valid.
        expect(flight.token).toBe(gen.token);
        expect(FLIGHT_TOKEN.test(flight.token)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("collectItineraries de-dupes by token, keeps best before other, and caps at MAX_FLIGHTS", () => {
    fc.assert(
      fc.property(
        fc.array(genItinerary, { minLength: 0, maxLength: 25 }),
        fc.array(genItinerary, { minLength: 0, maxLength: 25 }),
        fc.integer({ min: 1, max: 9 }),
        (best, other, adults) => {
          const data: Json = {
            best_flights: best.map((g) => g.raw),
            other_flights: other.map((g) => g.raw),
          };
          const out = collectItineraries(data, adults);

          // Reference: best first then other, keep valid only, de-dup by token, cap 30.
          const seen = new Set<string>();
          const expected: string[] = [];
          for (const g of [...best, ...other]) {
            if (expected.length >= MAX_FLIGHTS) break;
            if (!g.valid || g.token === null) continue;
            if (seen.has(g.token)) continue;
            seen.add(g.token);
            expected.push(g.token);
          }

          expect(out.length).toBeLessThanOrEqual(MAX_FLIGHTS);
          expect(out.map((f) => f.token)).toEqual(expected);

          // Unique tokens in the result.
          expect(new Set(out.map((f) => f.token)).size).toBe(out.length);

          // Every emitted offer has a positive total fare and the agreed per-person basis.
          for (const f of out) {
            expect(f.totalFare).toBeGreaterThan(0);
            expect(f.farePerPerson).toBe(fareFromProvider(f.totalFare, adults).perPerson);
            expect(f.airlineLogo === null || f.airlineLogo.startsWith("https://")).toBe(true);
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
