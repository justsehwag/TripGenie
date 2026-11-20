/**
 * Property tests for lib/flight-list.ts (trip-planning-v2).
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { FlightAvailability } from "../lib/flight-availability";
import { fareFromProvider } from "../lib/providers/serpapi-flights";
import {
  cheapestKey,
  decideFlightsView,
  stopsLabel,
  lowestVendorIndex,
  parseFlightSort,
  perPersonFromTotal,
  sortFlightOptions,
  sortVendorPrices,
  type FlightSortKey,
  type SortableFlight,
} from "../lib/flight-list";

const KEYS: FlightSortKey[] = ["cheapest", "fastest", "earliest"];

const numArb = fc.oneof(
  fc.integer({ min: 0, max: 20 }),
  fc.double({ min: 0, max: 100000, noNaN: true }),
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
);

const flightsArb = fc
  .array(
    fc.record({
      fare: numArb,
      durationMin: numArb,
      departKey: fc.constantFrom("2025-01-01T06:00", "2025-01-01T09:30", "2025-01-01T21:15", "2025-01-02T00:05", "2025-01-02T12:00"),
    }),
    { maxLength: 30 },
  )
  .map((rows): SortableFlight[] =>
    rows.map((r, i) => ({ key: `k${i}`, order: i, ...r })),
  );

const inf = (n: number) => (Number.isFinite(n) ? n : Number.POSITIVE_INFINITY);

function metric(f: SortableFlight, sort: FlightSortKey): number | string {
  if (sort === "fastest") return inf(f.durationMin);
  if (sort === "earliest") return f.departKey;
  return inf(f.fare);
}

describe("Feature: trip-planning-v2, Property 23: Flight sorting", () => {
  it("returns a new permutation ordered by the sort key, ties keep original order", () => {
    fc.assert(
      fc.property(flightsArb, fc.constantFrom(...KEYS), (items, sort) => {
        const snapshot = items.slice();
        const out = sortFlightOptions(items, sort);

        // input untouched, new array
        expect(out).not.toBe(items);
        expect(items).toEqual(snapshot);

        // permutation (same elements by identity)
        expect(out).toHaveLength(items.length);
        expect(new Set(out).size).toBe(items.length);
        for (const o of out) expect(items).toContain(o);

        for (let i = 1; i < out.length; i++) {
          const a = metric(out[i - 1], sort);
          const b = metric(out[i], sort);
          expect(a <= b).toBe(true);
          if (a === b) expect(out[i - 1].order).toBeLessThan(out[i].order);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("parseFlightSort maps any string to one of the three keys, defaulting to cheapest", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const r = parseFlightSort(s);
        expect(KEYS).toContain(r);
        expect(r).toBe(KEYS.includes(s as FlightSortKey) ? s : "cheapest");
      }),
      { numRuns: 100 },
    );
    for (const k of KEYS) expect(parseFlightSort(k)).toBe(k);
    expect(parseFlightSort("recommended")).toBe("cheapest");
    expect(parseFlightSort(undefined)).toBe("cheapest");
  });
});

/**
 * Feature: trip-planning-v2, Property 24: Cheapest highlight
 * Validates: Requirements 12.6, 12.15
 */
describe("Feature: trip-planning-v2, Property 24: Cheapest highlight", () => {
  it("returns exactly one key: the first option (original order) whose fare equals the minimum, for every sort", () => {
    fc.assert(
      fc.property(
        flightsArb.filter((l) => l.length > 0),
        (items) => {
          const key = cheapestKey(items);
          expect(key).not.toBeNull();

          // exactly one option carries the key (keys are unique)
          expect(items.filter((f) => f.key === key)).toHaveLength(1);
          const chosen = items.find((f) => f.key === key)!;

          const min = Math.min(...items.map((f) => inf(f.fare)));
          expect(inf(chosen.fare)).toBe(min);

          // first by original order among those equal to the minimum
          const firstMin = items.find((f) => inf(f.fare) === min)!;
          expect(chosen).toBe(firstMin);

          // unaffected by sorting: the highlighted option always carries the minimum fare.
          // The identical key is guaranteed only when the minimum is unique, because
          // cheapestKey breaks ties by position in the list it is given (see report on
          // tie-breaking by `order`).
          const minCount = items.filter((f) => inf(f.fare) === min).length;
          for (const sort of KEYS) {
            const sorted = sortFlightOptions(items, sort);
            const k = cheapestKey(sorted);
            expect(inf(sorted.find((f) => f.key === k)!.fare)).toBe(min);
            if (minCount === 1) expect(k).toBe(key);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns null for an empty list", () => {
    expect(cheapestKey([])).toBeNull();
  });
});

/**
 * Feature: trip-planning-v2, Property 25: Vendor prices
 * Validates: Requirements 12.7
 */
describe("Feature: trip-planning-v2, Property 25: Vendor prices", () => {
  const vendorsArb = fc
    .array(
      fc.record({
        name: fc.string({ maxLength: 8 }),
        // small integer range so ties are frequent
        price: fc.option(fc.integer({ min: 1, max: 12 }), { nil: null }),
      }),
      { maxLength: 30 },
    )
    .map((rows) => rows.map((r, i) => ({ ...r, idx: i })));

  it("sortVendorPrices: ascending, unpriced last, ties keep provider order, new permutation", () => {
    fc.assert(
      fc.property(vendorsArb, (opts) => {
        const snapshot = opts.slice();
        const out = sortVendorPrices(opts);

        expect(out).not.toBe(opts);
        expect(opts).toEqual(snapshot);
        expect(out).toHaveLength(opts.length);
        expect(new Set(out).size).toBe(opts.length);
        for (const o of out) expect(opts).toContain(o);

        const pricedCount = opts.filter((o) => o.price !== null).length;
        out.forEach((o, i) => {
          if (i < pricedCount) expect(o.price).not.toBeNull();
          else expect(o.price).toBeNull();
        });

        for (let i = 1; i < out.length; i++) {
          const a = out[i - 1];
          const b = out[i];
          if (a.price !== null && b.price !== null) {
            expect(a.price).toBeLessThanOrEqual(b.price);
            if (a.price === b.price) expect(a.idx).toBeLessThan(b.idx);
          } else if (a.price === null && b.price === null) {
            expect(a.idx).toBeLessThan(b.idx);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("lowestVendorIndex: first minimum-priced option, or -1 when none is priced", () => {
    fc.assert(
      fc.property(vendorsArb, (opts) => {
        const i = lowestVendorIndex(opts);
        const prices = opts.map((o) => o.price).filter((p): p is number => p !== null);
        if (prices.length === 0) {
          expect(i).toBe(-1);
          return;
        }
        const min = Math.min(...prices);
        expect(opts[i].price).toBe(min);
        expect(opts.findIndex((o) => o.price === min)).toBe(i);
        // agrees with the head of the sorted list
        expect(sortVendorPrices(opts)[0]).toBe(opts[i]);
      }),
      { numRuns: 100 },
    );
    expect(lowestVendorIndex([])).toBe(-1);
  });

  it("perPersonFromTotal equals fareFromProvider(total, adults).perPerson", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: 1, max: 1_000_000 }),
          fc.double({ min: 0.01, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        ),
        fc.integer({ min: 1, max: 9 }),
        (total, adults) => {
          expect(perPersonFromTotal(total, adults)).toBe(fareFromProvider(total, adults).perPerson);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("decideFlightsView", () => {
  const availabilityArb = fc.constantFrom<FlightAvailability>("available", "no-airport", "no-flights");
  const statusArb = fc.oneof(
    fc.constantFrom("live", "unconfigured", "invalid", "unavailable", "error", "timeout"),
    fc.string(),
  );
  const countArb = fc.oneof(fc.integer({ min: -5, max: 50 }), fc.constant(Number.NaN));

  // Feature: trip-planning-v2, Property 21: Flights page decision
  it("Property 21: chooses the view from availability, status and count", () => {
    fc.assert(
      fc.property(availabilityArb, statusArb, countArb, (availability, status, flightCount) => {
        const view = decideFlightsView({ availability, status, flightCount });
        if (availability === "no-airport") expect(view).toBe("ground-note");
        else if (availability === "no-flights") expect(view).toBe("no-flights");
        else if (status === "live" && flightCount > 0) expect(view).toBe("list");
        else expect(view).toBe("notice-only");
        // A list is never produced for a No_Flight_Route.
        if (view === "list") expect(availability).toBe("available");
      }),
      { numRuns: 100 },
    );
  });
});

describe("stopsLabel", () => {
  // Feature: trip-planning-v2, Property 26: Stops label
  it("Property 26: Non-stop iff 0, '1 stop' for 1, 'N stops' otherwise", () => {
    fc.assert(
      fc.property(fc.nat({ max: 1000 }), (n) => {
        const label = stopsLabel(n);
        if (n === 0) expect(label).toBe("Non-stop");
        else if (n === 1) expect(label).toBe("1 stop");
        else expect(label).toBe(`${n} stops`);
      }),
      { numRuns: 100 },
    );
  });
});
