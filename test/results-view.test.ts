/**
 * Results view engine tests (lib/results-view.ts).
 *
 * Each correctness property from the live-travel-pricing design lives in its
 * own describe block so later tasks can append blocks to this file.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  DEFAULT_STAYS_VIEW,
  DEFAULT_FLIGHTS_VIEW,
  STAYS_SORTS,
  STAY_STYLES,
  MIN_RATINGS,
  FLIGHTS_SORTS,
  STOP_BANDS,
  DEPART_WINDOWS,
  parseStaysView,
  serializeStaysView,
  parseFlightsView,
  serializeFlightsView,
  buildResultsHref,
  isValidAirlineName,
  type StaysView,
  type FlightsView,
  type StopBand,
  type DepartWindow,
} from "../lib/results-view";
import {
  parseCriteria,
  type StaysCriteria,
  type FlightsCriteria,
} from "../lib/search-criteria";

// ---------------------------------------------------------------------------
// Shared generators
// ---------------------------------------------------------------------------

const SHOWS = [10, 20, 30] as const;

const arbPrice = fc.integer({ min: 1, max: 1_000_000_000 });

/** Canonical Stays view: minPrice <= maxPrice when both are set. */
const arbStaysView: fc.Arbitrary<StaysView> = fc
  .record({
    sort: fc.constantFrom(...STAYS_SORTS),
    style: fc.constantFrom(...STAY_STYLES),
    minPrice: fc.option(arbPrice, { nil: null }),
    maxPrice: fc.option(arbPrice, { nil: null }),
    minRating: fc.constantFrom(...MIN_RATINGS),
    freeCancel: fc.boolean(),
    show: fc.constantFrom(...SHOWS),
  })
  .map((v) =>
    v.minPrice !== null && v.maxPrice !== null && v.minPrice > v.maxPrice
      ? { ...v, minPrice: v.maxPrice, maxPrice: v.minPrice }
      : v,
  );

/** Characters allowed in an airline name, plus a few non-ASCII letters and digits. */
const AIRLINE_CHARS = [
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  " ", ".", "&", "'", "-", "é", "ñ", "ü", "Ø", "क", "र", "٣",
];

const arbAirlineName: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...AIRLINE_CHARS), { minLength: 1, maxLength: 24 })
  .map((cs) => cs.join(""))
  .filter(isValidAirlineName);

/** Canonical Flights view: lists unique and in canonical order; airlines sorted. */
const arbFlightsView: fc.Arbitrary<FlightsView> = fc.record({
  sort: fc.constantFrom(...FLIGHTS_SORTS),
  stops: fc.subarray([...STOP_BANDS]) as fc.Arbitrary<StopBand[]>,
  airlines: fc.uniqueArray(arbAirlineName, { maxLength: 4 }).map((a) => [...a].sort()),
  windows: fc.subarray([...DEPART_WINDOWS]) as fc.Arbitrary<DepartWindow[]>,
  maxFare: fc.option(arbPrice, { nil: null }),
  show: fc.constantFrom(...SHOWS),
});

/** Keys that neither view nor criteria uses. */
const arbUnknownParam: fc.Arbitrary<[string, string]> = fc.tuple(
  fc.constantFrom("foo", "utm_source", "page", "q", "ref", "x-y", "SORT", "Show"),
  fc.string({ maxLength: 12 }),
);

/**
 * A field spec for the malformed-param property: absent, a valid value
 * (with its parsed result) or a malformed raw value (expected: default).
 */
type FieldSpec<T> = { raw: string | null; expected: T; valid: boolean };

function field<T>(
  valid: fc.Arbitrary<[string, T]>,
  malformed: readonly string[],
  dflt: T,
): fc.Arbitrary<FieldSpec<T>> {
  return fc.oneof(
    fc.constant<FieldSpec<T>>({ raw: null, expected: dflt, valid: false }),
    valid.map(([raw, expected]) => ({ raw, expected, valid: true })),
    fc.constantFrom(...malformed).map((raw) => ({ raw, expected: dflt, valid: false })),
  );
}

const MALFORMED_INT = ["0", "-5", "1.5", "abc", " 12", "012", "1e3", "", "+7", "99999999999999999"];
const MALFORMED_SHOW = ["0", "15", "40", "abc", "10.0", "", "-10", "020", "100"];

const arbIntSpec = field<number | null>(arbPrice.map((n) => [String(n), n]), MALFORMED_INT, null);
const arbShowSpec = field<number>(
  fc.constantFrom(...SHOWS).map((n) => [String(n), n]),
  MALFORMED_SHOW,
  DEFAULT_STAYS_VIEW.show,
);

function buildQuery(entries: Array<[string, string | null]>, unknown: Array<[string, string]>): string {
  const p = new URLSearchParams();
  for (const [k, v] of unknown) p.append(k, v);
  for (const [k, v] of entries) if (v !== null) p.append(k, v);
  return p.toString();
}

const queryOf = (href: string): string => {
  const i = href.indexOf("?");
  return i < 0 ? "" : href.slice(i + 1);
};

// ---------------------------------------------------------------------------
// Property 16
// ---------------------------------------------------------------------------

// Feature: live-travel-pricing, Property 16: View state round-trips through the URL
describe("Property 16: View state round-trips through the URL", () => {
  // **Validates: Requirements 12.2, 12.4, 12.5**
  it("canonical Stays views round-trip and the default serialises to empty", () => {
    expect(serializeStaysView(DEFAULT_STAYS_VIEW).toString()).toBe("");
    expect(parseStaysView("")).toEqual(DEFAULT_STAYS_VIEW);
    fc.assert(
      fc.property(arbStaysView, (v) => {
        const qs = serializeStaysView(v).toString();
        expect(parseStaysView(qs)).toEqual(v);
        expect(parseStaysView(new URLSearchParams(qs))).toEqual(v);
      }),
      { numRuns: 200 },
    );
  });

  // **Validates: Requirements 12.2, 12.4, 12.5**
  it("canonical Flights views round-trip and the default serialises to empty", () => {
    expect(serializeFlightsView(DEFAULT_FLIGHTS_VIEW).toString()).toBe("");
    expect(parseFlightsView("")).toEqual(DEFAULT_FLIGHTS_VIEW);
    fc.assert(
      fc.property(arbFlightsView, (v) => {
        const qs = serializeFlightsView(v).toString();
        expect(parseFlightsView(qs)).toEqual(v);
        expect(parseFlightsView(new URLSearchParams(qs))).toEqual(v);
      }),
      { numRuns: 200 },
    );
  });

  // **Validates: Requirements 12.3**
  it("Stays: unknown params are ignored and malformed fields take their defaults", () => {
    const d = DEFAULT_STAYS_VIEW;
    const arbSpecs = fc.record({
      sort: field(
        fc.constantFrom(...STAYS_SORTS).map((s) => [s, s] as [string, StaysView["sort"]]),
        ["Rating", "price", "cheapest", "", "price-asc ", "toString", "__proto__"],
        d.sort,
      ),
      style: field(
        fc.constantFrom(...STAY_STYLES).map((s) => [s, s] as [string, StaysView["style"]]),
        ["budget", "LUXURY", "", "Premium", "constructor"],
        d.style,
      ),
      minPrice: arbIntSpec,
      maxPrice: arbIntSpec,
      minRating: field(
        fc.constantFrom(...MIN_RATINGS).map((r) => [String(r), r] as [string, StaysView["minRating"]]),
        ["5", "3", "4.25", "abc", "", "-4", " 4", "4.5.0"],
        d.minRating,
      ),
      freeCancel: field(fc.constant(["1", true] as [string, boolean]), ["true", "0", "yes", "", "01"], d.freeCancel),
      show: arbShowSpec,
      unknown: fc.array(arbUnknownParam, { maxLength: 4 }),
    });

    fc.assert(
      fc.property(arbSpecs, (s) => {
        const qs = buildQuery(
          [
            ["sort", s.sort.raw],
            ["stayStyle", s.style.raw],
            ["minPrice", s.minPrice.raw],
            ["maxPrice", s.maxPrice.raw],
            ["minRating", s.minRating.raw],
            ["freeCancel", s.freeCancel.raw],
            ["show", s.show.raw],
          ],
          s.unknown,
        );
        let minPrice = s.minPrice.expected;
        let maxPrice = s.maxPrice.expected;
        // A valid pair with min > max is ignored as a pair.
        if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
          minPrice = null;
          maxPrice = null;
        }
        const expected: StaysView = {
          sort: s.sort.expected,
          style: s.style.expected,
          minPrice,
          maxPrice,
          minRating: s.minRating.expected,
          freeCancel: s.freeCancel.expected,
          show: s.show.expected,
        };
        const parsed = parseStaysView(qs);
        expect(parsed).toEqual(expected);
        // The parsed view is canonical, so it round-trips itself.
        expect(parseStaysView(serializeStaysView(parsed))).toEqual(parsed);
      }),
      { numRuns: 300 },
    );
  });

  // **Validates: Requirements 12.3**
  it("Flights: unknown params are ignored and malformed fields take their defaults", () => {
    const d = DEFAULT_FLIGHTS_VIEW;
    const arbAirlinesSpec: fc.Arbitrary<FieldSpec<string[]> & { raws: string[] }> = fc.oneof(
      fc.constant({ raw: null, raws: [] as string[], expected: [] as string[], valid: false }),
      // Valid repeated names in any order, possibly duplicated: canonical result.
      fc.array(arbAirlineName, { minLength: 1, maxLength: 4 }).map((raws) => ({
        raw: "",
        raws,
        expected: [...new Set(raws)].sort(),
        valid: true,
      })),
      // One invalid member drops the whole parameter.
      fc
        .tuple(
          fc.array(arbAirlineName, { maxLength: 3 }),
          fc.constantFrom("", "   ", "<script>", "a".repeat(61), "Air/India", "Indi_Go", "a+b"),
        )
        .map(([good, bad]) => ({ raw: "", raws: [...good, bad], expected: [] as string[], valid: false })),
    );

    const arbSpecs = fc.record({
      sort: field(
        fc.constantFrom(...FLIGHTS_SORTS).map((s) => [s, s] as [string, FlightsView["sort"]]),
        ["Cheapest", "price-asc", "rating", "", "hasOwnProperty", "__proto__", "constructor"],
        d.sort,
      ),
      stops: field(
        fc
          .array(fc.constantFrom(...STOP_BANDS), { minLength: 1, maxLength: 5 })
          .map((xs) => [xs.join(","), STOP_BANDS.filter((b) => xs.includes(b))] as [string, StopBand[]]),
        ["3", "0,3", "x", "", "0,,1", "0, 1", "-1", "1.0"],
        [] as StopBand[],
      ),
      windows: field(
        fc
          .array(fc.constantFrom(...DEPART_WINDOWS), { minLength: 1, maxLength: 5 })
          .map((xs) => [xs.join(","), DEPART_WINDOWS.filter((w) => xs.includes(w))] as [string, DepartWindow[]]),
        ["night", "early,", "Early", "", "morning,noon", "morning;evening"],
        [] as DepartWindow[],
      ),
      airlines: arbAirlinesSpec,
      maxFare: arbIntSpec,
      show: arbShowSpec,
      unknown: fc.array(arbUnknownParam, { maxLength: 4 }),
    });

    fc.assert(
      fc.property(arbSpecs, (s) => {
        const p = new URLSearchParams(
          buildQuery(
            [
              ["sort", s.sort.raw],
              ["stops", s.stops.raw],
              ["window", s.windows.raw],
              ["maxFare", s.maxFare.raw],
              ["show", s.show.raw],
            ],
            s.unknown,
          ),
        );
        for (const name of s.airlines.raws) p.append("airline", name);
        const qs = p.toString();

        const expected: FlightsView = {
          sort: s.sort.expected,
          stops: s.stops.expected,
          airlines: s.airlines.expected,
          windows: s.windows.expected,
          maxFare: s.maxFare.expected,
          show: s.show.expected,
        };
        const parsed = parseFlightsView(qs);
        expect(parsed).toEqual(expected);
        expect(parseFlightsView(serializeFlightsView(parsed))).toEqual(parsed);
      }),
      { numRuns: 300 },
    );
  });

  // Search-form hrefs: criteria + view both parse back (Req 3.5, 12.6).
  const arbText = fc.string({ maxLength: 20 });
  const arbDate = fc
    .date({ min: new Date("2024-01-01T00:00:00Z"), max: new Date("2030-12-31T00:00:00Z"), noInvalidDate: true })
    .map((dt) => dt.toISOString().slice(0, 10));

  const arbStaysCriteria: fc.Arbitrary<StaysCriteria> = fc.record({
    category: fc.constant("stays" as const),
    destination: arbText,
    checkIn: arbDate,
    checkOut: arbDate,
    guests: fc.integer({ min: 1, max: 30 }),
    rooms: fc.integer({ min: 1, max: 10 }),
  });

  const arbFlightsCriteria: fc.Arbitrary<FlightsCriteria> = fc
    .record({
      tripType: fc.constantFrom("round-trip" as const, "one-way" as const),
      origin: arbText,
      destination: arbText,
      departDate: arbDate,
      returnDate: arbDate,
      travellers: fc.integer({ min: 1, max: 9 }),
      cabin: fc.constantFrom("economy", "premium-economy", "business", "first"),
    })
    .map(({ returnDate, ...rest }) => {
      const c: FlightsCriteria = { category: "flights", ...rest };
      if (rest.tripType === "round-trip") c.returnDate = returnDate;
      return c;
    });

  // **Validates: Requirements 3.5, 12.6**
  it("Stays search hrefs parse back to the same criteria and view", () => {
    fc.assert(
      fc.property(arbStaysCriteria, arbStaysView, (c, v) => {
        const href = buildResultsHref("/stays", c, serializeStaysView(v));
        expect(href.startsWith("/stays?")).toBe(true);
        const qs = queryOf(href);
        expect(parseCriteria("stays", qs)).toEqual(c);
        expect(parseStaysView(qs)).toEqual(v);
      }),
      { numRuns: 200 },
    );
  });

  // **Validates: Requirements 3.5, 12.6**
  it("Flights search hrefs parse back to the same criteria and view", () => {
    fc.assert(
      fc.property(arbFlightsCriteria, arbFlightsView, (c, v) => {
        const href = buildResultsHref("/flights", c, serializeFlightsView(v));
        expect(href.startsWith("/flights?")).toBe(true);
        const qs = queryOf(href);
        expect(parseCriteria("flights", qs)).toEqual(c);
        expect(parseFlightsView(qs)).toEqual(v);
        // Passing the view as a query string gives the same href.
        expect(buildResultsHref("/flights", c, serializeFlightsView(v).toString())).toBe(href);
      }),
      { numRuns: 200 },
    );
  });

  it("a view param never overrides a criteria param", () => {
    const c: StaysCriteria = {
      category: "stays",
      destination: "Goa",
      checkIn: "2025-01-10",
      checkOut: "2025-01-12",
      guests: 2,
      rooms: 1,
    };
    const href = buildResultsHref("/stays", c, "destination=Paris&guests=9&sort=rating&empty=");
    const qs = queryOf(href);
    expect(parseCriteria("stays", qs)).toEqual(c);
    expect(parseStaysView(qs).sort).toBe("rating");
    expect(new URLSearchParams(qs).has("empty")).toBe(false);
  });

  // Legacy flights mapping table (Req 11.5, 12.3).
  describe("legacy flights parameters", () => {
    it.each([
      ["sort=price", "cheapest"],
      ["sort=duration", "fastest"],
      ["sort=departure", "earliest"],
    ] as const)("%s maps to sort %s", (qs, sort) => {
      expect(parseFlightsView(qs)).toEqual({ ...DEFAULT_FLIGHTS_VIEW, sort });
    });

    it.each([
      ["maxStops=0", ["0"]],
      ["maxStops=1", ["0", "1"]],
    ] as const)("%s maps to stops %j", (qs, stops) => {
      expect(parseFlightsView(qs)).toEqual({ ...DEFAULT_FLIGHTS_VIEW, stops: [...stops] });
    });

    it("unsupported legacy values fall back to defaults", () => {
      expect(parseFlightsView("maxStops=2").stops).toEqual([]);
      expect(parseFlightsView("maxStops=abc").stops).toEqual([]);
      expect(parseFlightsView("sort=toString").sort).toBe("recommended");
    });

    it("a valid stops param takes precedence over maxStops; an invalid one does not", () => {
      expect(parseFlightsView("stops=2&maxStops=0").stops).toEqual(["2"]);
      expect(parseFlightsView("stops=9&maxStops=1").stops).toEqual(["0", "1"]);
    });

    it("legacy URLs re-serialise in the current canonical form", () => {
      const v = parseFlightsView("sort=price&maxStops=1");
      const out = serializeFlightsView(v);
      expect(out.get("sort")).toBe("cheapest");
      expect(out.get("stops")).toBe("0,1");
      expect(out.has("maxStops")).toBe(false);
      expect(parseFlightsView(out)).toEqual(v);
    });
  });
});

// ---------------------------------------------------------------------------
// Property 11
// ---------------------------------------------------------------------------

import {
  staysCaps,
  effectiveStaysView,
  filterStays,
  sortStays,
  page,
  PAGE_SIZE,
  type StayItem,
} from "../lib/results-view";
import { scoreStays } from "../lib/pick-engine";

// A StayItem whose key is unique within the generated array (set-equality checks
// below depend on keys being distinct). Live items carry hotelClass/rating/
// reviews/freeCancellation/locationRating/amenityCount; estimate items carry a
// `style`. The `live` flag for the whole Result_Set is generated separately.
const arbStayItem: fc.Arbitrary<Omit<StayItem, "key" | "order">> = fc.oneof(
  // Live hotel.
  fc.record({
    price: fc.integer({ min: 1, max: 200_000 }),
    rating: fc.option(fc.integer({ min: 0, max: 50 }).map((n) => n / 10), { nil: null }),
    reviews: fc.option(fc.integer({ min: 0, max: 50_000 }), { nil: null }),
    hotelClass: fc.option(fc.integer({ min: 1, max: 5 }), { nil: null }),
    style: fc.constant(null),
    freeCancellation: fc.option(fc.boolean(), { nil: null }),
    locationRating: fc.option(fc.integer({ min: 0, max: 50 }).map((n) => n / 10), { nil: null }),
    amenityCount: fc.option(fc.integer({ min: 0, max: 12 }), { nil: null }),
  }),
  // Estimate stay.
  fc.record({
    price: fc.integer({ min: 1, max: 200_000 }),
    rating: fc.constant(null),
    reviews: fc.constant(null),
    hotelClass: fc.constant(null),
    style: fc.constantFrom("Budget" as const, "Comfort" as const, "Luxury" as const),
    freeCancellation: fc.constant(null),
    locationRating: fc.constant(null),
    amenityCount: fc.constant(null),
  }),
);

const arbStayItems: fc.Arbitrary<StayItem[]> = fc
  .array(arbStayItem, { maxLength: 35 })
  .map((parts) => parts.map((p, i) => ({ ...p, key: `k${i}`, order: i })));

/** Independent re-statement of each active filter (design "8" filter rules). */
function satisfiesActiveFilters(item: StayItem, v: StaysView): boolean {
  // Style.
  if (v.style !== "Any") {
    if (item.style !== null) {
      if (item.style !== v.style) return false;
    } else {
      if (item.hotelClass === null || !Number.isFinite(item.hotelClass)) return false;
      const cls = Math.round(item.hotelClass);
      const band = v.style === "Budget" ? [2, 3] : v.style === "Comfort" ? [3, 4] : [4, 5];
      if (cls < band[0] || cls > band[1]) return false;
    }
  }
  if (v.minPrice !== null && item.price < v.minPrice) return false;
  if (v.maxPrice !== null && item.price > v.maxPrice) return false;
  if (v.minRating > 0 && (item.rating === null || item.rating < v.minRating)) return false;
  if (v.freeCancel && item.freeCancellation !== true) return false;
  return true;
}

// Feature: live-travel-pricing, Property 11: Stays view contains exactly the matching offers across pages
describe("Property 11: Stays view contains exactly the matching offers across pages", () => {
  // **Validates: Requirements 10.5, 10.6, 10.8, 16.4, 17.3, 6.1**
  it("walking show from PAGE_SIZE upward reconstructs the filtered, sorted set with no dup or omission", () => {
    fc.assert(
      fc.property(arbStayItems, arbStaysView, fc.boolean(), (items, rawView, live) => {
        const caps = staysCaps(items, live);
        const view = effectiveStaysView(rawView, caps);

        const filtered = filterStays(items, view);
        const scores = scoreStays(filtered);
        const sorted = sortStays(filtered, view, scores);

        const filteredKeys = new Set(filtered.map((i) => i.key));
        expect(filteredKeys.size).toBe(filtered.length); // generated keys are unique

        // Walk show = 10, 20, 30, ... until hasMore is false, concatenating pages.
        const seen: StayItem[] = [];
        const seenKeys = new Set<string>();
        let show = PAGE_SIZE;
        let guard = 0;
        for (;;) {
          if (++guard > 1000) throw new Error("show walk did not terminate");
          const { visible, hasMore } = page(sorted, show);

          // visible.length === min(show, filtered.length).
          expect(visible.length).toBe(Math.min(show, filtered.length));
          // hasMore === filtered.length > show.
          expect(hasMore).toBe(filtered.length > show);

          // This page's prefix is exactly the previous concatenation plus new items.
          for (let i = 0; i < seen.length; i++) {
            expect(visible[i].key).toBe(seen[i].key);
          }
          for (let i = seen.length; i < visible.length; i++) {
            const item = visible[i];
            expect(seenKeys.has(item.key)).toBe(false); // no duplicate across pages
            seenKeys.add(item.key);
            seen.push(item);
            // Every visible item satisfies each active filter.
            expect(filteredKeys.has(item.key)).toBe(true);
            expect(satisfiesActiveFilters(item, view)).toBe(true);
          }

          if (!hasMore) break;
          show += PAGE_SIZE;
        }

        // The concatenation of all pages equals the filtered set by key:
        // no omission (every filtered key seen) and no extra.
        expect(seen.length).toBe(filtered.length);
        expect(seenKeys).toEqual(filteredKeys);
        // And it is exactly the sorted order.
        expect(seen.map((i) => i.key)).toEqual(sorted.map((i) => i.key));
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 12
// ---------------------------------------------------------------------------

import {
  flightsCaps,
  effectiveFlightsView,
  airlineFacets,
  filterFlights,
  sortFlights,
  type FlightItem,
} from "../lib/results-view";
import { scoreFlights } from "../lib/pick-engine";

// Airline-name pool: a few present names the view may select plus names that
// never appear in any generated item (so effectiveFlightsView must drop them).
const PRESENT_AIRLINES = ["IndiGo", "Air India", "Vistara", "SpiceJet", "Akasa Air"] as const;
const ABSENT_AIRLINES = ["Lufthansa", "Emirates", "Qatar Airways"] as const;

/** A flight normalised for the view engine; fields chosen to exercise each filter. */
const arbFlightItem: fc.Arbitrary<Omit<FlightItem, "key" | "order">> = fc.record({
  fare: fc.integer({ min: 1, max: 500_000 }),
  durationMin: fc.integer({ min: 30, max: 2_000 }),
  stops: fc.integer({ min: 0, max: 3 }),
  // "HH:MM" departKey; departHour is the matching hour so the window filter is coherent.
  departHour: fc.integer({ min: 0, max: 23 }),
  // Airlines: a subset of the present pool (possibly empty for estimate-style items).
  airlines: fc.uniqueArray(fc.constantFrom(...PRESENT_AIRLINES), { maxLength: 3 }),
}).map((p) => {
  const hh = String(p.departHour).padStart(2, "0");
  const mm = String(p.durationMin % 60).padStart(2, "0");
  return { ...p, departKey: `${hh}:${mm}` };
});

const arbFlightItems: fc.Arbitrary<FlightItem[]> = fc
  .array(arbFlightItem, { maxLength: 35 })
  .map((parts) => parts.map((p, i) => ({ ...p, key: `f${i}`, order: i })));

/** Airline names the view may try to filter on: present names and absent names. */
const arbViewAirlines: fc.Arbitrary<string[]> = fc
  .uniqueArray(fc.constantFrom(...PRESENT_AIRLINES, ...ABSENT_AIRLINES), { maxLength: 5 })
  .map((a) => [...a].sort());

/** Generate a Flights view with filters that can actually match the items. */
const arbFlightsViewForItems: fc.Arbitrary<FlightsView> = fc.record({
  sort: fc.constantFrom(...FLIGHTS_SORTS),
  stops: fc.subarray([...STOP_BANDS]) as fc.Arbitrary<StopBand[]>,
  airlines: arbViewAirlines,
  windows: fc.subarray([...DEPART_WINDOWS]) as fc.Arbitrary<DepartWindow[]>,
  maxFare: fc.option(fc.integer({ min: 1, max: 500_000 }), { nil: null }),
  show: fc.constantFrom(...SHOWS),
});

/** Independent re-statement of each active flights filter (design "8" filter rules). */
function flightSatisfiesActiveFilters(item: FlightItem, v: FlightsView): boolean {
  // Stops: band of min(stops, 2) must be in the selected set; empty = any.
  if (v.stops.length > 0) {
    const band = String(Math.min(item.stops, 2));
    if (!v.stops.includes(band as StopBand)) return false;
  }
  // Airlines: at least one of the item's airlines is selected; empty = any.
  if (v.airlines.length > 0) {
    if (!item.airlines.some((a) => v.airlines.includes(a))) return false;
  }
  // Departure window by departHour: early 0-5, morning 6-11, afternoon 12-17, evening 18-23.
  if (v.windows.length > 0) {
    const h = item.departHour;
    const w =
      h < 6 ? "early" : h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
    if (!v.windows.includes(w as DepartWindow)) return false;
  }
  // Max fare: inclusive.
  if (v.maxFare !== null && item.fare > v.maxFare) return false;
  return true;
}

// Feature: live-travel-pricing, Property 12: Flights view contains exactly the matching offers across pages
describe("Property 12: Flights view contains exactly the matching offers across pages", () => {
  // **Validates: Requirements 11.2, 11.6, 6.1**
  it("walking show from PAGE_SIZE upward reconstructs the filtered, sorted set with no dup or omission", () => {
    fc.assert(
      fc.property(arbFlightItems, arbFlightsViewForItems, fc.boolean(), (items, rawView, live) => {
        const caps = flightsCaps(items, live);
        // Airlines actually present in the Result_Set drive effectiveFlightsView's drop.
        const present = airlineFacets(items).map((f) => f.name);
        const view = effectiveFlightsView(rawView, caps, present);

        const filtered = filterFlights(items, view);
        const scores = scoreFlights(filtered);
        const sorted = sortFlights(filtered, view, scores);

        const filteredKeys = new Set(filtered.map((i) => i.key));
        expect(filteredKeys.size).toBe(filtered.length); // generated keys are unique

        // Any airline still selected in the effective view must be present in the set.
        for (const a of view.airlines) {
          expect(present.includes(a)).toBe(true);
        }

        // Walk show = 10, 20, 30, ... until hasMore is false, concatenating pages.
        const seen: FlightItem[] = [];
        const seenKeys = new Set<string>();
        let show = PAGE_SIZE;
        let guard = 0;
        for (;;) {
          if (++guard > 1000) throw new Error("show walk did not terminate");
          const { visible, hasMore } = page(sorted, show);

          // visible.length === min(show, filtered.length).
          expect(visible.length).toBe(Math.min(show, filtered.length));
          // hasMore === filtered.length > show.
          expect(hasMore).toBe(filtered.length > show);

          // This page's prefix is exactly the previous concatenation plus new items.
          for (let i = 0; i < seen.length; i++) {
            expect(visible[i].key).toBe(seen[i].key);
          }
          for (let i = seen.length; i < visible.length; i++) {
            const item = visible[i];
            expect(seenKeys.has(item.key)).toBe(false); // no duplicate across pages
            seenKeys.add(item.key);
            seen.push(item);
            // Every visible item satisfies each active filter.
            expect(filteredKeys.has(item.key)).toBe(true);
            expect(flightSatisfiesActiveFilters(item, view)).toBe(true);
          }

          if (!hasMore) break;
          show += PAGE_SIZE;
        }

        // The concatenation of all pages equals the filtered set by key:
        // no omission (every filtered key seen) and no extra.
        expect(seen.length).toBe(filtered.length);
        expect(seenKeys).toEqual(filteredKeys);
        // And it is exactly the sorted order.
        expect(seen.map((i) => i.key)).toEqual(sorted.map((i) => i.key));
      }),
      { numRuns: 100 },
    );
  });
});
