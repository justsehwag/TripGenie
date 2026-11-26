import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { AIRPORTS, resolveAirport } from "@/lib/airports";
import { resolveDestination } from "@/lib/destination-airports";
import { collectItineraries, flightParams, type ResolvedFlightQuery } from "@/lib/providers/serpapi-flights";
import { stopsLabel } from "@/lib/flight-list";

/** A provider itinerary with `segmentCount` segments; layovers listed only when `withLayovers`. */
function rawItinerary(id: string, segmentCount: number, withLayovers: boolean) {
  const codes = ["MAA", "DXB", "DOH", "ADD", "CPT"];
  const flights = Array.from({ length: segmentCount }, (_, i) => ({
    departure_airport: { id: codes[i], name: `Airport ${codes[i]}`, time: `2030-01-01 0${i}:00` },
    arrival_airport: { id: codes[i + 1], name: `Airport ${codes[i + 1]}`, time: `2030-01-01 0${i}:30` },
    airline: "Test Air",
    flight_number: `TA ${100 + i}`,
    duration: 60,
  }));
  const layovers = withLayovers
    ? Array.from({ length: segmentCount - 1 }, (_, i) => ({ id: codes[i + 1], duration: 45 }))
    : undefined;
  return {
    price: 50000,
    total_duration: 600,
    booking_token: `booking-token-${id}`,
    flights,
    ...(layovers ? { layovers } : {}),
  };
}

const cases = (s: string) =>
  fc.constantFrom(s, s.toUpperCase(), s.toLowerCase(), s.replace(/\b[a-z]/g, (c) => c.toUpperCase()));
const pad = fc.constantFrom("", " ", "  ", "\t");

describe("flights-coverage-itinerary", () => {
  // Feature: flights-coverage-itinerary, Property 1: Cape Town typed forms resolve to CPT
  // **Validates: Requirements 1.1, 1.2, 1.3**
  it("Property 1: Cape Town typed forms resolve to CPT", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("cape town", "capetown", "cpt").chain((s) => cases(s)),
        pad,
        pad,
        (form, l, r) => {
          const res = resolveDestination(`${l}${form}${r}`);
          expect(res.kind).toBe("airport");
          if (res.kind === "airport") expect(res.code).toBe("CPT");
        },
      ),
      { numRuns: 100 },
    );
    fc.assert(
      fc.property(cases("cpaetown"), (form) => {
        const res = resolveDestination(form);
        expect(res.kind).toBe("airport");
        if (res.kind === "airport") {
          expect(res.code).toBe("CPT");
          expect(res.corrected).toBeDefined();
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: flights-coverage-itinerary, Property 2: every Airport_Table entry round-trips through resolution
  // **Validates: Requirements 1.1, 1.4**
  it("Property 2: every airport table entry round-trips through resolution", () => {
    const pairs = AIRPORTS.flatMap((e) => [
      ...e.names.map((n) => [e.code, n] as const),
      [e.code, e.code] as const,
    ]);
    fc.assert(
      fc.property(fc.constantFrom(...pairs), pad, (pair, p) => {
        const [code, name] = pair;
        const input = `${p}${name}${p}`;
        expect(resolveAirport(input)).toBe(code);
        const res = resolveDestination(input);
        if (res.kind === "airport") expect(res.code).toBe(code);
        else {
          // Country aliases expand to several airports; the entry's code must be among them.
          expect(res.kind).toBe("country");
          if (res.kind === "country") expect(res.airports.map((a) => a.code)).toContain(code);
        }
      }),
      { numRuns: Math.max(100, pairs.length) },
    );
  });

  // Feature: flights-coverage-itinerary, Property 3: Connecting itineraries are preserved and labelled by true stop count
  // **Validates: Requirements 2.2, 2.3**
  it("Property 3: connecting itineraries keep their true stop count and label", () => {
    // 0, 1 and 2 layovers with provider-listed layovers.
    const listed = [0, 1, 2].map((n) => rawItinerary(`listed${n}`, n + 1, n > 0));
    // A 3-layover itinerary without a layovers array: stops falls back to segments - 1.
    const fallback = rawItinerary("fallback3", 4, false);
    const out = collectItineraries({ best_flights: [listed[0]], other_flights: [listed[1], listed[2], fallback] }, 1);

    // Nothing is dropped for being a connecting flight.
    expect(out).toHaveLength(4);
    expect(out.map((f) => f.stops)).toEqual([0, 1, 2, 3]);
    for (const f of out) {
      expect(f.stops).toBe(f.segments.length - 1);
      expect(stopsLabel(f.stops) === "Non-stop").toBe(f.stops === 0);
    }
    expect(stopsLabel(0)).toBe("Non-stop");
    expect(stopsLabel(1)).toBe("1 stop");
    expect(stopsLabel(2)).toBe("2 stops");
    expect(stopsLabel(3)).toBe("3 stops");
  });

  // Feature: flights-coverage-itinerary, Property 4: The flight provider query never carries a stops filter
  // **Validates: Requirements 2.1**
  it("Property 4: flightParams never carries a stops filter or undocumented key", () => {
    const allowed = new Set([
      "engine", "departure_id", "arrival_id", "outbound_date", "return_date",
      "type", "travel_class", "adults", "currency", "gl", "hl",
    ]);
    const code = fc.stringMatching(/^[A-Z]{3}$/);
    const date = fc
      .tuple(fc.integer({ min: 2026, max: 2030 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }))
      .map(([y, m, d]) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    const query: fc.Arbitrary<ResolvedFlightQuery> = fc.record({
      originCode: code,
      destinationCode: code,
      type: fc.constantFrom<1 | 2>(1, 2),
      travelClass: fc.constantFrom<1 | 2 | 3 | 4>(1, 2, 3, 4),
      departDate: date,
      returnDate: fc.option(date, { nil: undefined }),
      adults: fc.integer({ min: 1, max: 9 }),
      currency: fc.constant("INR"),
    });
    fc.assert(
      fc.property(query, (q) => {
        const p = flightParams(q);
        expect(Object.keys(p)).not.toContain("stops");
        for (const k of Object.keys(p)) expect(allowed.has(k)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
