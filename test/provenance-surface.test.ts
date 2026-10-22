// Feature: realtime-ai-integration, Property 6 — Inventory provenance labelling.
//
// Validates Req 2.9, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6.
//
// For ANY InventoryQuery (constructed across all three booking categories —
// flights / stays / cars), every offer returned by `runSearch` over the pure
// inventory adapter (deterministic sample data — NO network, NO live provider)
// must satisfy the provenance discipline when no live/confirmed source backs it:
//
//   1. EXACTLY ONE mode — each offer's `meta.mode` is a single, defined value
//      drawn from the `Provenance` union (`live | estimated | cached | demo`).
//   2. NOT A CONFIRMED / LIVE SOURCE — an uncredentialed query carries no live
//      provider, so every offer is labelled `estimated` (or `demo`) and NONE is
//      labelled live availability or a confirmed booking.
//   3. DISCLAIMER PRESENT — each estimated/demo offer carries the no-payment /
//      no-confirmed-booking disclaimer in `meta.disclaimer`.
//
// Runs in the project's `node` vitest environment with `fast-check`; the
// property runs >= 100 iterations. Asserts on the offer DATA (OfferMeta), never
// on rendered JSX.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { Provenance } from "@/lib/types";
import type { InventoryQuery } from "@/lib/inventory-adapter";
import { runSearch, type SearchResult } from "@/lib/search";

// ---------------------------------------------------------------------------
// The authoritative Provenance union, mirrored for exhaustive assertions. The
// set below is the tripwire if `lib/types.ts` ever grows/renames a mode: the
// `exactly one mode` assertion checks membership against exactly these values.
// ---------------------------------------------------------------------------
const ALL_MODES: readonly Provenance[] = ["live", "estimated", "cached", "demo"];

// Modes that denote NEITHER live availability NOR a confirmed booking. An
// estimator-sourced offer (no credentialed provider) must land here.
const NON_CONFIRMED_MODES: readonly Provenance[] = ["estimated", "demo"];

// ---------------------------------------------------------------------------
// Arbitrary — a valid InventoryQuery spanning all categories. Fields mirror the
// adapter's `InventoryQuery` contract (origin/destination/cabin/stayStyle/
// nights plus the optional car fields). `credentialed` is intentionally left
// false/undefined: this property is about the estimator path, where no live or
// confirmed source exists. URLSearchParams-style free text (empties, unicode,
// reserved chars) is exercised for the place fields.
// ---------------------------------------------------------------------------

/** A free-form place/text value, including the empty string. */
const placeArb = fc.string({ maxLength: 40 });

/** Known calibrated destinations plus arbitrary ones, to span the catalogue. */
const destinationArb = fc.oneof(
  fc.constantFrom("Dubai", "Singapore", "London", "Goa", "Bali", "Paris", "Tokyo"),
  placeArb,
);

const cabinArb = fc.constantFrom("Economy", "Premium Economy", "Business");
const stayStyleArb = fc.constantFrom("Budget", "Comfort", "Luxury");
const carClassArb = fc.constantFrom("Economy", "Compact", "SUV", "Luxury");

const queryArb: fc.Arbitrary<InventoryQuery> = fc.record({
  origin: placeArb,
  destination: destinationArb,
  cabin: cabinArb,
  stayStyle: stayStyleArb,
  nights: fc.integer({ min: 1, max: 30 }),
  // No live/confirmed source: either explicitly uncredentialed or omitted.
  credentialed: fc.constantFrom<boolean | undefined>(false, undefined),
  pickupLocation: fc.option(placeArb, { nil: undefined }),
  dropoffLocation: fc.option(placeArb, { nil: undefined }),
  carClass: fc.option(carClassArb, { nil: undefined }),
  rentalDays: fc.option(fc.integer({ min: 1, max: 30 }), { nil: undefined }),
});

/** Optional upstream caps so the per-category offer counts also vary. */
const upstreamArb = fc.record({
  flights: fc.option(fc.integer({ min: 0, max: 10 }), { nil: undefined }),
  hotels: fc.option(fc.integer({ min: 0, max: 10 }), { nil: undefined }),
  places: fc.option(fc.integer({ min: 0, max: 10 }), { nil: undefined }),
  cars: fc.option(fc.integer({ min: 0, max: 10 }), { nil: undefined }),
});

/** Flatten every offer across the four categories into one list of OfferMetas. */
function allOffers(result: SearchResult) {
  return [...result.flights, ...result.hotels, ...result.places, ...result.cars];
}

// ---------------------------------------------------------------------------
// Property 6 — inventory provenance labelling.
// ---------------------------------------------------------------------------

describe("Feature: realtime-ai-integration, Property 6 — inventory provenance labelling", () => {
  it("every offer carries EXACTLY ONE mode from the Provenance union", () => {
    fc.assert(
      fc.property(queryArb, upstreamArb, (q, upstream) => {
        const result = runSearch(q, upstream);
        for (const offer of allOffers(result)) {
          // Exactly one mode: a single defined value, member of the union.
          expect(typeof offer.meta.mode).toBe("string");
          expect(ALL_MODES).toContain(offer.meta.mode);
        }
      }),
      { numRuns: 150 },
    );
  });

  it("no live/confirmed source → every offer is estimated/demo with the no-payment disclaimer", () => {
    fc.assert(
      fc.property(queryArb, upstreamArb, (q, upstream) => {
        const result = runSearch(q, upstream);
        for (const offer of allOffers(result)) {
          // (2) Labelled estimated or demo — NEVER live availability.
          expect(NON_CONFIRMED_MODES).toContain(offer.meta.mode);
          // (3) The disclaimer states no payment is taken and no valid
          // ticket/room/booking is issued.
          const disclaimer = offer.meta.disclaimer;
          expect(typeof disclaimer).toBe("string");
          expect(disclaimer.length).toBeGreaterThan(0);
          expect(disclaimer.toLowerCase()).toContain("no payment");
        }
      }),
      { numRuns: 150 },
    );
  });

  it("NONE is labelled live availability or a confirmed booking", () => {
    fc.assert(
      fc.property(queryArb, upstreamArb, (q, upstream) => {
        const result = runSearch(q, upstream);
        for (const offer of allOffers(result)) {
          // Absence of a live / confirmed-booking label on the offer data.
          expect(offer.meta.mode).not.toBe("live" as Provenance);
          // No confirmed-booking / live-availability flag is present on meta.
          const meta = offer.meta as unknown as Record<string, unknown>;
          expect(meta.confirmed).toBeUndefined();
          expect(meta.booked).toBeUndefined();
          expect(meta.available).toBeUndefined();
        }
      }),
      { numRuns: 150 },
    );
  });
});
