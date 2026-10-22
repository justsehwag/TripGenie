// Feature: realtime-ai-integration — Shared_Trip_Context ⇄ Search_Criteria mappers.
//
// Property-based coverage for the pure mappers in `lib/trip-context-map.ts`
// (spec tasks 4.2 and 4.3). Runs in the project's `node` vitest environment
// with `fast-check`; each property runs >= 100 iterations.
//
//   Property 1 (task 4.2, Req 4.2/4.3/4.5): Trip_Context ⇄ SearchCriteria
//     round-trip — for any valid context + date hints and each category,
//     parseCriteria(cat, serializeCriteria(toXCriteria(ctx, hints))) deep-equals
//     toXCriteria(ctx, hints).
//
//   Property 4 (task 4.3, Req 4.6): mapper never fabricates a missing field —
//     for any context with a mapped field omitted, the corresponding criteria
//     field equals the documented default/empty value (not an invented value).

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { TripContext } from "@/lib/types";
import type { Category } from "@/lib/search-criteria";
import { serializeCriteria, parseCriteria } from "@/lib/search-criteria";
import {
  toStaysCriteria,
  toFlightsCriteria,
  toCarsCriteria,
  type DateHints,
} from "@/lib/trip-context-map";

// Documented defaults mirrored from `lib/search-criteria.ts` (module-private
// there). The round-trip property is the tripwire if these ever drift.
const DEFAULT_GUESTS = 1;
const DEFAULT_ROOMS = 1;
const DEFAULT_TRAVELLERS = 1;
const DEFAULT_DRIVER_AGE = 18;
const DEFAULT_CABIN = "economy";

// ---------------------------------------------------------------------------
// Arbitraries — valid-enough context/hint values. URLSearchParams round-trips
// arbitrary strings, so we exercise empties, unicode, and reserved chars too.
// ---------------------------------------------------------------------------

/** A free-form place/text value, including the empty string. */
const placeArb = fc.string({ maxLength: 40 });

/** An ISO-ish date string, or the empty string (caller omitted the hint). */
const dateHintArb = fc.oneof(
  fc.constant(""),
  fc
    .date({ min: new Date("2024-01-01"), max: new Date("2030-12-31") })
    .map((d) => d.toISOString().slice(0, 10)),
);

/** An ISO-ish time string, or the empty string. */
const timeHintArb = fc.oneof(
  fc.constant(""),
  fc
    .tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
    .map(([h, m]) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`),
);

/** A traveller party, sometimes absent, with small non-negative counts. */
const travellersArb = fc.option(
  fc.record({
    adults: fc.integer({ min: 0, max: 9 }),
    children: fc.integer({ min: 0, max: 9 }),
  }),
  { nil: undefined },
);

/** A valid `TripContext` exercising present/absent shared fields. */
const contextArb: fc.Arbitrary<TripContext> = fc.record({
  origin: fc.option(placeArb, { nil: undefined }),
  destination: fc.option(placeArb, { nil: undefined }),
  durationDays: fc.option(fc.integer({ min: 1, max: 30 }), { nil: undefined }),
  travellers: travellersArb,
  budgetLevel: fc.option(fc.constantFrom("budget", "mid", "luxury"), { nil: undefined }),
  diet: fc.option(placeArb, { nil: undefined }),
  pace: fc.option(fc.constantFrom("relaxed", "balanced", "packed"), { nil: undefined }),
  interests: fc.option(fc.array(placeArb, { maxLength: 5 }), { nil: undefined }),
});

/** All seven date/time hints, each independently present or empty. */
const hintsArb: fc.Arbitrary<DateHints> = fc.record({
  checkIn: dateHintArb,
  checkOut: dateHintArb,
  departDate: dateHintArb,
  returnDate: dateHintArb,
  pickupDate: dateHintArb,
  pickupTime: timeHintArb,
  returnTime: timeHintArb,
});

// ---------------------------------------------------------------------------
// Property 1 — round-trip through serialize/parse (per category).
// ---------------------------------------------------------------------------

describe("Feature: realtime-ai-integration, Property 1 — Trip_Context ⇄ SearchCriteria round-trip", () => {
  it("stays: parseCriteria(serializeCriteria(toStaysCriteria)) deep-equals the mapped criteria", () => {
    fc.assert(
      fc.property(contextArb, hintsArb, (ctx, hints) => {
        const built = toStaysCriteria(ctx, hints);
        const back = parseCriteria("stays" as Category, serializeCriteria(built));
        expect(back).toEqual(built);
      }),
      { numRuns: 200 },
    );
  });

  it("flights: parseCriteria(serializeCriteria(toFlightsCriteria)) deep-equals the mapped criteria", () => {
    fc.assert(
      fc.property(contextArb, hintsArb, (ctx, hints) => {
        const built = toFlightsCriteria(ctx, hints);
        const back = parseCriteria("flights" as Category, serializeCriteria(built));
        expect(back).toEqual(built);
      }),
      { numRuns: 200 },
    );
  });

  it("cars: parseCriteria(serializeCriteria(toCarsCriteria)) deep-equals the mapped criteria", () => {
    fc.assert(
      fc.property(contextArb, hintsArb, (ctx, hints) => {
        const built = toCarsCriteria(ctx, hints);
        const back = parseCriteria("cars" as Category, serializeCriteria(built));
        expect(back).toEqual(built);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4 — no fabrication: omitted mapped fields fall to documented defaults.
// ---------------------------------------------------------------------------

describe("Feature: realtime-ai-integration, Property 4 — mapper never fabricates a missing field", () => {
  it("stays: absent destination/travellers → empty/default; rooms always the documented default", () => {
    fc.assert(
      fc.property(contextArb, hintsArb, (ctx, hints) => {
        const noDest: TripContext = { ...ctx, destination: undefined };
        const noParty: TripContext = { ...noDest, travellers: undefined };
        const c = toStaysCriteria(noParty, hints);

        expect(c.destination).toBe(""); // omitted → empty, not invented
        expect(c.guests).toBe(DEFAULT_TRAVELLERS); // no party → default 1
        expect(c.rooms).toBe(DEFAULT_ROOMS); // unmapped → documented default
      }),
      { numRuns: 150 },
    );
  });

  it("flights: absent origin/destination/travellers/trip-type/cabin → defaults", () => {
    fc.assert(
      fc.property(contextArb, hintsArb, (ctx, hints) => {
        const bare: TripContext = {
          ...ctx,
          origin: undefined,
          destination: undefined,
          travellers: undefined,
        };
        const c = toFlightsCriteria(bare, hints);

        expect(c.origin).toBe(""); // omitted → empty
        expect(c.destination).toBe(""); // omitted → empty
        expect(c.travellers).toBe(DEFAULT_TRAVELLERS); // no party → 1
        expect(c.tripType).toBe("round-trip"); // unmapped → documented default
        expect(c.cabin).toBe(DEFAULT_CABIN); // unmapped → documented default
      }),
      { numRuns: 150 },
    );
  });

  it("cars: absent destination/travellers → empty pickup + default age; no dropoff fabricated", () => {
    fc.assert(
      fc.property(contextArb, hintsArb, (ctx, hints) => {
        const bare: TripContext = { ...ctx, destination: undefined, travellers: undefined };
        const c = toCarsCriteria(bare, hints);

        expect(c.pickupLocation).toBe(""); // omitted → empty
        expect(c.driverAge).toBe(DEFAULT_DRIVER_AGE); // unmapped → documented default
        expect(c.dropoffLocation).toBeUndefined(); // no distinct drop-off → omitted
      }),
      { numRuns: 150 },
    );
  });

  it("date/time hints are forwarded verbatim; an absent hint maps to empty (never invented)", () => {
    fc.assert(
      fc.property(contextArb, (ctx) => {
        const stays = toStaysCriteria(ctx, {});
        const flights = toFlightsCriteria(ctx, {});
        const cars = toCarsCriteria(ctx, {});

        expect(stays.checkIn).toBe("");
        expect(stays.checkOut).toBe("");
        expect(flights.departDate).toBe("");
        expect(flights.returnDate).toBe(""); // round-trip default → present, empty
        expect(cars.pickupDate).toBe("");
        expect(cars.pickupTime).toBe("");
        expect(cars.returnTime).toBe("");
      }),
      { numRuns: 100 },
    );
  });

  it("guests/travellers collapse adults+children with a floor of 1 (deterministic, never 0)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 9 }),
        fc.integer({ min: 0, max: 9 }),
        (adults, children) => {
          const ctx: TripContext = { travellers: { adults, children } };
          const expected = Math.max(1, adults + children);
          expect(toStaysCriteria(ctx).guests).toBe(expected);
          expect(toFlightsCriteria(ctx).travellers).toBe(expected);
          // Determinism: repeat call yields the same value.
          expect(toStaysCriteria(ctx).guests).toBe(expected);
        },
      ),
      { numRuns: 150 },
    );
  });
});
