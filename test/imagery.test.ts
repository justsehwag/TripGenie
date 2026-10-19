import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { fallbackFor, isAllowedImageUrl, resolveImage, type ImageKind } from "@/lib/imagery";

/** Feature: tripgenie - imagery property tests (Properties 24, 25, 26). */

const kinds = ["attraction", "hotel", "destination"] as const;

describe("Feature: tripgenie, imagery", () => {
  it("Property 24: Image requests target only allowlisted hosts", () => {
    fc.assert(
      fc.property(fc.webUrl(), (url) => {
        const allowed = isAllowedImageUrl(url);
        if (allowed) {
          const u = new URL(url);
          expect(u.protocol).toBe("https:");
        }
      }),
      { numRuns: 100 },
    );
    // Explicit allowed and disallowed examples.
    expect(isAllowedImageUrl("https://upload.wikimedia.org/a.jpg")).toBe(true);
    expect(isAllowedImageUrl("http://upload.wikimedia.org/a.jpg")).toBe(false);
    expect(isAllowedImageUrl("https://evil.example.com/a.jpg")).toBe(false);
  });

  it("Property 25: Hotel and destination imagery is labelled representative", () => {
    fc.assert(
      fc.property(fc.constantFrom(...kinds), fc.integer({ min: 0, max: 10 }), (kind, slot) => {
        const r = resolveImage({ kind, query: "Goa", slot });
        if (kind === "hotel" || kind === "destination") {
          expect(r.representative).toBe(true);
          expect(r.label.toLowerCase()).toContain("representative");
        } else {
          expect(r.representative).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
    // An authorized exact property image is not labelled representative.
    const exact = resolveImage(
      { kind: "hotel", query: "Taj", slot: 0 },
      { url: "https://upload.wikimedia.org/taj.jpg", exactProperty: true },
    );
    expect(exact.representative).toBe(false);
  });

  it("Property 26: Imagery fallback is slot-specific, bounded to four photos, and never a wordmark", () => {
    fc.assert(
      fc.property(fc.constantFrom(...kinds), fc.integer({ min: -50, max: 50 }), (kind, slot) => {
        const path = fallbackFor(kind, slot);
        // One of exactly four bundled photos per surface.
        const valid = [
          `/${kind}-fallback.jpg`,
          `/${kind}-fallback-2.jpg`,
          `/${kind}-fallback-3.jpg`,
          `/${kind}-fallback-4.jpg`,
        ];
        expect(valid).toContain(path);
        // Never a branded wordmark asset.
        expect(path.toLowerCase()).not.toContain("logo");
        expect(path.toLowerCase()).not.toContain("wordmark");
      }),
      { numRuns: 100 },
    );
  });
});
