// Feature: places-first-itinerary, Property 12: Unpriced Stops carry no estimate and totals count only accepted prices
// Validates: Requirements 6.8, 6.9, 6.11, 6.12, 6.14, 12.7, 12.8
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { mapDays, type MapDayIn } from "@/lib/itinerary/map-days";
import { enrichStops, type EnrichedStop, type EnrichInput } from "@/lib/itinerary/enrichment";
import type { PolishAppliedStop } from "@/lib/itinerary/polish-check";
import type { PlaceCandidate } from "@/lib/providers/google-places";
import { computeSummary, unpricedStopCount } from "@/lib/trip-summary";
import { normalizeItineraryToInr } from "@/lib/itinerary-inr";
import type { Itinerary } from "@/lib/types";

type Mode = "absent" | "unchecked" | "checked" | "priced";

interface StopSpec {
  mode: Mode;
  inr: number;
  kind: "entry" | "typical";
  photos: number;
}

const stopArb: fc.Arbitrary<StopSpec> = fc.record({
  mode: fc.constantFrom<Mode>("absent", "unchecked", "checked", "priced", "priced"),
  inr: fc.integer({ min: 0, max: 20000 }),
  kind: fc.constantFrom<"entry" | "typical">("entry", "typical"),
  photos: fc.integer({ min: 0, max: 3 }),
});
const daysArb = fc.array(fc.array(stopArb, { minLength: 0, maxLength: 6 }), { minLength: 1, maxLength: 4 });

function candidate(id: string, photos: number): PlaceCandidate {
  return {
    placeId: id,
    name: `Place ${id}`,
    address: `${id} Main Road, Old Town, Jaipur, Rajasthan 302001, India`,
    location: { lat: 26.9, lng: 75.8 },
    rating: 4.4,
    userRatingCount: 120,
    hours: null,
    utcOffsetMinutes: 330,
    types: ["tourist_attraction"],
    primaryType: "tourist_attraction",
    businessStatus: "OPERATIONAL",
    googleMapsUri: null,
    photos: Array.from({ length: photos }, (_, i) => `places/${id}/photos/${i}`),
  };
}

function build(days: StopSpec[][]) {
  const mapIn: MapDayIn[] = [];
  const enrichment = new Map<string, EnrichedStop>();
  const specById = new Map<string, StopSpec>();
  let n = 0;
  days.forEach((stops, di) => {
    const out: PolishAppliedStop[] = stops.map((s, si) => {
      const id = `p${n++}`;
      specById.set(id, s);
      if (s.mode === "unchecked") enrichment.set(id, { placeId: id, webDetails: { checked: false } });
      else if (s.mode === "checked") enrichment.set(id, { placeId: id, webDetails: { checked: true } });
      else if (s.mode === "priced") {
        enrichment.set(id, {
          placeId: id,
          webDetails: { checked: true, priceKind: s.kind },
          price: {
            inr: s.inr,
            sourceUrl: `https://site${id}.example.test/fees`,
            sourceHost: `site${id}.example.test`,
            checkedAt: "2025-01-01T00:00:00.000Z",
            basis: "per person",
            kind: s.kind,
          },
        });
      }
      const start = 9 * 60 + si * 90;
      return {
        candidate: candidate(id, s.photos),
        sentence: "",
        scheduled: { placeId: id, startMin: start, endMin: start + 60, visitMin: 60, hoursLabel: null, hoursText: null },
      };
    });
    mapIn.push({ day: di + 1, title: null, stops: out });
  });
  return { mapIn, enrichment, specById };
}

describe("Property 12: unpriced Stops carry no estimate, totals count accepted prices only", () => {
  it("mapDays, trip summary and INR normalisation agree on accepted prices", () => {
    fc.assert(
      fc.property(daysArb, fc.integer({ min: 1, max: 9 }), (days, travellers) => {
        const { mapIn, enrichment, specById } = build(days);
        const res = mapDays({ days: mapIn, enrichment, startDate: "2025-03-01", destination: "Jaipur" });

        const built = res.days.flatMap((d) => d.activities);
        const accepted = (id: string) => specById.get(id)!.mode === "priced";
        let expectedUnpriced = 0;

        for (const a of built) {
          const spec = specById.get(a.placeId!)!;
          if (spec.mode === "priced") {
            expect(a.priceSource).toBe("web");
            expect(a.cost).toBe(Math.round(spec.inr));
            expect(typeof a.sourceUrl).toBe("string");
            expect(a.webDetails?.checked).toBe(true);
          } else {
            expectedUnpriced += 1;
            expect(a.cost).toBe(0);
            expect(a.priceSource).toBeUndefined();
            expect(a.costBasis).toBeUndefined();
            expect(a.sourceUrl).toBeUndefined();
            expect(a.sourceHost).toBeUndefined();
            expect(a.checkedAt).toBeUndefined();
            expect(a.priceBasis).toBeUndefined();
            expect(a.category).toBeUndefined();
            expect(a.costClass).toBeUndefined();
            expect(a.costNote).toBeUndefined();
            if (spec.mode === "unchecked") expect(a.webDetails?.checked).toBe(false);
            if (spec.mode === "checked") expect(a.webDetails?.checked).toBe(true);
          }
        }

        // Every Stop is present.
        expect(built.length).toBe(days.reduce((n, d) => n + d.length, 0));

        // Day totals and trip total equal the sum of accepted prices.
        const sumAccepted = (acts: typeof built) =>
          acts.reduce((s, a) => s + (accepted(a.placeId!) ? Math.round(specById.get(a.placeId!)!.inr) : 0), 0);
        let trip = 0;
        for (const d of res.days) {
          expect(d.total).toBe(sumAccepted(d.activities));
          trip += d.total;
        }

        // Unpriced counts.
        expect(res.unpriced).toBe(expectedUnpriced);
        expect(Object.values(res.unpricedByDay).reduce((s, n) => s + n, 0)).toBe(expectedUnpriced);
        for (const d of res.days) {
          expect(res.unpricedByDay[d.day]).toBe(d.activities.filter((a) => !accepted(a.placeId!)).length);
        }
        // unpricedStopCount counts Stops that carry webDetails; "absent" ones have none.
        const withDetails = built.filter((a) => specById.get(a.placeId!)!.mode !== "absent");
        const expectedWithDetails = withDetails.filter((a) => !accepted(a.placeId!)).length;
        expect(unpricedStopCount(built)).toBe(expectedWithDetails);

        // Trip summary (costUnit inr): activities line = accepted prices x travellers.
        const it: Itinerary = { title: "t", totalCost: trip, days: res.days, costUnit: "inr", currency: "INR" };
        const summary = computeSummary({
          itinerary: it,
          stayInr: 0,
          flightPerPerson: 0,
          travellers,
          noFlight: true,
        });
        expect(summary.activities).toBe(trip * travellers);

        // The inr path of normalizeItineraryToInr leaves Stops untouched: no estimate is added.
        const norm = normalizeItineraryToInr(it, 83, { budgetLevel: "mid", destination: "Jaipur" } as never);
        expect(norm).toBe(it);
        for (const a of norm.days.flatMap((d) => d.activities)) {
          if (!accepted(a.placeId!)) {
            expect(a.cost).toBe(0);
            expect(a.priceSource).toBeUndefined();
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("enrichStops never throws and leaves every Stop unchecked and unpriced when disabled or failing", async () => {
    const inputArb = fc.array(
      fc.record({
        name: fc.string({ minLength: 1, maxLength: 20 }),
        kind: fc.constantFrom<"sight" | "meal">("sight", "meal"),
      }),
      { minLength: 0, maxLength: 8 },
    );
    await fc.assert(
      fc.asyncProperty(
        inputArb,
        fc.constantFrom("disabled", "no-url", "throws", "rejects"),
        async (items, mode) => {
          const stops: EnrichInput[] = items.map((s, i) => ({
            placeId: `e${i}`,
            name: s.name,
            primaryType: null,
            kind: s.kind,
          }));
          const config =
            mode === "disabled"
              ? { enabled: false, baseUrl: "https://sx.example.test", secretHeader: null }
              : mode === "no-url"
                ? { enabled: true, baseUrl: "", secretHeader: null }
                : { enabled: true, baseUrl: "https://sx.example.test", secretHeader: null };
          const research = (() => {
            if (mode === "throws") throw new Error("boom");
            return Promise.reject(new Error("boom"));
          }) as never;
          const r = await enrichStops(stops, { destination: "Jaipur", budgetLevel: "mid" }, { config, research });
          expect(r.stops.size).toBe(stops.length);
          expect(r.status).toBe("not-checked");
          for (const e of r.stops.values()) {
            expect(e.price).toBeUndefined();
            expect(e.webDetails.checked).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
