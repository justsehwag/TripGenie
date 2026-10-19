import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { runSearch, searchError } from "@/lib/search";
import { buildFlightOffers } from "@/lib/inventory-adapter";

/** Feature: tripgenie - search/inventory property tests (Properties 18-23). */

const q = { origin: "Delhi", destination: "Goa", cabin: "Economy", stayStyle: "Comfort", nights: 3 };

describe("Feature: tripgenie, search", () => {
  it("Property 18: Search returns exactly six or a labelled partial set", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10 }), (avail) => {
        const r = runSearch(q, { flights: avail, hotels: avail, places: avail });
        const expected = Math.min(6, avail);
        expect(r.flights.length).toBe(expected);
        expect(r.hotels.length).toBe(expected);
        expect(r.places.length).toBe(expected);
        expect(r.partial.flights).toBe(avail < 6);
        expect(r.partial.hotels).toBe(avail < 6);
        expect(r.partial.places).toBe(avail < 6);
      }),
      { numRuns: 100 },
    );
  });

  it("Property 19: Prominent places lie within the destination metropolitan area", () => {
    fc.assert(
      fc.property(fc.constantFrom("Goa", "Dubai", "Paris", "Tokyo"), (dest) => {
        const r = runSearch({ ...q, destination: dest });
        for (const p of r.places) expect(p.metroArea).toBe(dest);
      }),
      { numRuns: 100 },
    );
  });

  it("Property 20: Offer contract is well-formed with ordered timestamps", () => {
    fc.assert(
      fc.property(fc.boolean(), (cred) => {
        const r = runSearch({ ...q, credentialed: cred });
        for (const o of [...r.flights, ...r.hotels, ...r.places]) {
          expect(o.meta.provider.length).toBeGreaterThan(0);
          expect(Date.parse(o.meta.retrievedAt)).toBeLessThanOrEqual(Date.parse(o.meta.expiresAt));
        }
      }),
      { numRuns: 100 },
    );
  });

  it("Property 21: Estimated offers are calibrated and carry no commercial brand attribution", () => {
    fc.assert(
      fc.property(fc.constantFrom("Economy", "Business", "Premium Economy"), (cabin) => {
        const eco = buildFlightOffers({ ...q, cabin: "Economy" })[0];
        const other = buildFlightOffers({ ...q, cabin })[0];
        if (cabin === "Business") expect(other.farePerPerson).toBeGreaterThan(eco.farePerPerson);
        expect(other.meta.provider).toBe("tripgenie-estimator");
      }),
      { numRuns: 100 },
    );
  });

  it("Property 22: Payload provenance is exactly one of the allowed values", () => {
    const allowed = new Set(["live", "estimated", "cached", "demo"]);
    fc.assert(
      fc.property(fc.boolean(), (cred) => {
        const r = runSearch({ ...q, credentialed: cred });
        for (const o of [...r.flights, ...r.hotels]) {
          expect(allowed.has(o.meta.mode)).toBe(true);
          if (o.meta.mode === "estimated")
            expect(o.meta.disclaimer.toLowerCase()).toContain("no payment");
        }
      }),
      { numRuns: 100 },
    );
  });
});
