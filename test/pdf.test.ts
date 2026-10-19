import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { buildItineraryPdf } from "@/lib/pdf";
import { buildItinerary } from "@/lib/itinerary-engine";
import { calculateTripPricing } from "@/lib/pricing";

/** Feature: tripgenie - PDF exporter tests (Property 35 + no-dependency unit). */

describe("Feature: tripgenie, pdf", () => {
  it("Property 35: Exported PDF is well-formed and embeds engine pricing", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 7 }),
        fc.integer({ min: 0, max: 99999 }),
        (days, flight) => {
          const it = buildItinerary({ destination: "Goa", startDate: "2027-05-01", days });
          const pricing = calculateTripPricing({ flight, stay: 5000, activities: 3000 });
          const bytes = buildItineraryPdf("Trip", "Delhi to Goa", it.days, pricing);
          const text = Buffer.from(bytes).toString("latin1");
          expect(text.startsWith("%PDF-")).toBe(true);
          expect(text).toContain("%%EOF");
          expect(text).toContain(String(pricing.finalPayable));
          expect(text).toContain(String(pricing.gross));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("PDF module imports no external runtime dependency (Req 14.2)", () => {
    const src = readFileSync("lib/pdf.ts", "utf8");
    const imports = [...src.matchAll(/import\s.*?from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of imports) {
      const external = !spec.startsWith(".") && !spec.startsWith("node:");
      expect(external, `pdf.ts should not import external ${spec}`).toBe(false);
    }
  });
});
