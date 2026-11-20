import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { classifyFlightAvailability, unresolvedSides } from "@/lib/flight-availability";
import { resolveAirport } from "@/lib/airports";

const VALID = ["available", "no-airport", "no-flights"];

const KNOWN_PLACES = ["Delhi", "Goa", "Mumbai", "Chennai", "Dubai", "Leh", "Paris (CDG)", "xyz", "ABC"];

// Mix of arbitrary text, three-letter inputs, known places and non-strings.
const textLike = fc.oneof(
  fc.string(),
  fc.string({ unit: "grapheme", maxLength: 12 }),
  fc.stringMatching(/^[A-Za-z]{3}$/),
  fc.constantFrom(...KNOWN_PLACES),
  fc.constantFrom("", "   ", "Vaniyambadi"),
);
const anyValue = fc.oneof(
  textLike,
  fc.constantFrom<unknown>(null, undefined, 0, 42, NaN, true, false, {}, [], ["Delhi"]),
  fc.anything(),
);

const resolvingText = fc.constantFrom("Delhi", "Goa", "Mumbai", "Chennai", "Dubai", "Leh", "xyz", "ABC", "Paris (CDG)");
const resolvableText = fc.oneof(resolvingText, fc.stringMatching(/^[A-Za-z]{3}$/));

const safeResolved = (v: unknown): string | null => {
  try {
    return typeof v === "string" ? resolveAirport(v) : null;
  } catch {
    return null;
  }
};

const outcomeArb = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.record({
    status: fc.constantFrom("live", "error", "unconfigured", "timeout", "fallback", "weird"),
    flightCount: fc.oneof(fc.nat(20), fc.integer({ min: -5, max: 5 }), fc.constant(NaN)),
  }),
);

// Feature: trip-planning-v2, Property 18: Availability is total and no-airport follows the resolver
describe("Feature: trip-planning-v2, Property 18: Availability is total and no-airport follows the resolver", () => {
  it("is total and returns no-airport iff either side fails to resolve", () => {
    fc.assert(
      fc.property(anyValue, anyValue, outcomeArb, (origin, destination, outcome) => {
        const result = classifyFlightAvailability(origin, destination, outcome);
        expect(VALID).toContain(result);
        const unresolved = safeResolved(origin) === null || safeResolved(destination) === null;
        expect(result === "no-airport").toBe(unresolved);
      }),
      { numRuns: 200 },
    );
  });

  it("handles three-letter inputs per the resolver", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z]{3}$/), (code) => {
        expect(classifyFlightAvailability(code, "Delhi")).not.toBe("no-airport");
        expect(classifyFlightAvailability("Delhi", code)).not.toBe("no-airport");
      }),
      { numRuns: 100 },
    );
  });

  it("classifies Vaniyambadi as no-airport", () => {
    expect(classifyFlightAvailability("Vaniyambadi", "Delhi")).toBe("no-airport");
    expect(classifyFlightAvailability("Delhi", "Vaniyambadi")).toBe("no-airport");
  });
});

// Feature: trip-planning-v2, Property 19: Availability follows the search outcome
describe("Feature: trip-planning-v2, Property 19: Availability follows the search outcome", () => {
  it("is no-flights iff a live outcome with zero flights is supplied", () => {
    fc.assert(
      fc.property(resolvableText, resolvableText, outcomeArb, (origin, destination, outcome) => {
        const result = classifyFlightAvailability(origin, destination, outcome);
        const zeroLive = !!outcome && outcome.status === "live" && outcome.flightCount === 0;
        expect(result).toBe(zeroLive ? "no-flights" : "available");
      }),
      { numRuns: 200 },
    );
  });

  it("is available for live outcomes with at least one flight", () => {
    fc.assert(
      fc.property(resolvableText, resolvableText, fc.integer({ min: 1, max: 500 }), (o, d, n) => {
        expect(classifyFlightAvailability(o, d, { status: "live", flightCount: n })).toBe("available");
      }),
      { numRuns: 100 },
    );
  });

  it("is available for non-live statuses even with zero flights, and with no outcome", () => {
    fc.assert(
      fc.property(
        resolvableText,
        resolvableText,
        fc.string().filter((s) => s !== "live"),
        (o, d, status) => {
          expect(classifyFlightAvailability(o, d, { status, flightCount: 0 })).toBe("available");
          expect(classifyFlightAvailability(o, d)).toBe("available");
          expect(classifyFlightAvailability(o, d, null)).toBe("available");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("classifies Delhi to Goa as available", () => {
    expect(classifyFlightAvailability("Delhi", "Goa")).toBe("available");
    expect(classifyFlightAvailability("Delhi", "Goa", { status: "live", flightCount: 3 })).toBe("available");
    expect(classifyFlightAvailability("Delhi", "Goa", { status: "live", flightCount: 0 })).toBe("no-flights");
  });
});

// Feature: trip-planning-v2, Property 22: Unresolved sides are reported
// **Validates: Requirements 11.2**
describe("Feature: trip-planning-v2, Property 22: Unresolved sides are reported", () => {
  it("contains origin iff origin fails to resolve and destination iff destination fails, origin first", () => {
    fc.assert(
      fc.property(anyValue, anyValue, (origin, destination) => {
        const sides = unresolvedSides(origin, destination);
        const expected: string[] = [];
        if (safeResolved(origin) === null) expected.push("origin");
        if (safeResolved(destination) === null) expected.push("destination");
        expect(sides).toEqual(expected);
      }),
      { numRuns: 200 },
    );
  });

  it("reports nothing for resolvable inputs and names the failing side for Vaniyambadi", () => {
    fc.assert(
      fc.property(resolvingText, resolvingText, (o, d) => {
        expect(unresolvedSides(o, d)).toEqual([]);
      }),
      { numRuns: 100 },
    );
    expect(unresolvedSides("Vaniyambadi", "Delhi")).toEqual(["origin"]);
    expect(unresolvedSides("Delhi", "Vaniyambadi")).toEqual(["destination"]);
    expect(unresolvedSides("Vaniyambadi", "Vaniyambadi")).toEqual(["origin", "destination"]);
  });
});
