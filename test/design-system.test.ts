import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  palette,
  fonts,
  typeScale,
  typeScaleValid,
  MIN_TYPE_STEP,
  accentGlassOpacityValid,
  GLASS_OPACITY_MIN,
  GLASS_OPACITY_MAX,
  glassSurfaceRatio,
  glassProportionValid,
  bookingSurfacesOpaque,
  bookingLegible,
  contrastRatio,
  resolveMotion,
  MOTION_NORMAL_MS,
  MOTION_REDUCED_MS,
  TRIPSAATHI_LEGACY,
  type Surface,
} from "@/lib/design-system";

/** Feature: tripgenie - Editorial + Glass + Motion UI (Properties 49-53 + distinctness). */

const surfArb = fc.record<Surface>({
  kind: fc.constantFrom("glass", "opaque"),
  booking: fc.boolean(),
});

describe("Feature: tripgenie, design system", () => {
  it("Property 49: Typographic hierarchy maintains a minimum 1.25x step", () => {
    expect(typeScaleValid(typeScale)).toBe(true);
    // Any strictly decreasing scale built with >=1.25x ratios is valid;
    // inserting a sub-1.25x step makes it invalid.
    fc.assert(
      fc.property(fc.array(fc.double({ min: 1.25, max: 4, noNaN: true }), { minLength: 2, maxLength: 6 }), (ratios) => {
        let v = 1;
        const scale = [1];
        for (const r of ratios) { v *= r; scale.unshift(v); }
        expect(typeScaleValid(scale)).toBe(true);
        // A deliberate tiny step violates the minimum.
        expect(typeScaleValid([1.1, 1])).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("Property 50: Glass surfaces stay within thirty percent of card surfaces", () => {
    fc.assert(
      fc.property(fc.array(surfArb, { minLength: 1, maxLength: 40 }), (surfaces) => {
        const ratio = glassSurfaceRatio(surfaces);
        expect(glassProportionValid(surfaces)).toBe(ratio <= 0.30 + 1e-9);
      }),
      { numRuns: 100 },
    );
  });

  it("Property 51: Accent glass opacity stays within the 60 to 85 percent band", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (o) => {
        const inBand = o >= GLASS_OPACITY_MIN - 1e-9 && o <= GLASS_OPACITY_MAX + 1e-9;
        expect(accentGlassOpacityValid(o)).toBe(inBand);
      }),
      { numRuns: 100 },
    );
  });

  it("Property 52: Core booking surfaces are fully opaque and legible", () => {
    // The configured ink-on-paper booking text clears 4.5:1.
    expect(bookingLegible()).toBe(true);
    expect(contrastRatio(palette.ink, palette.paper)).toBeGreaterThanOrEqual(4.5);
    // Whenever booking surfaces are marked opaque, the invariant holds; a glass
    // booking surface breaks it.
    fc.assert(
      fc.property(fc.array(surfArb, { maxLength: 30 }), (surfaces) => {
        const opaqueBooking = surfaces.map((s) => (s.booking ? { ...s, kind: "opaque" as const } : s));
        expect(bookingSurfacesOpaque(opaqueBooking)).toBe(true);
      }),
      { numRuns: 100 },
    );
    expect(bookingSurfacesOpaque([{ kind: "glass", booking: true }])).toBe(false);
  });

  it("Property 53: Animations are triggered and time-bounded, with reduced-motion limits", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("user-action", "state-change", "none") as fc.Arbitrary<any>,
        fc.boolean(),
        fc.boolean(),
        (trigger, reducedMotion, essential) => {
          const d = resolveMotion(trigger, { reducedMotion, essential });
          // No trigger => never plays.
          if (trigger === "none") { expect(d.play).toBe(false); return; }
          if (reducedMotion) {
            if (!essential) { expect(d.play).toBe(false); return; }
            // Essential reduced motion: opacity-only within 200ms.
            expect(d.play).toBe(true);
            expect(d.opacityOnly).toBe(true);
            expect(d.durationMs).toBeLessThanOrEqual(MOTION_REDUCED_MS);
          } else {
            // Normal motion: plays and completes within 400ms.
            expect(d.play).toBe(true);
            expect(d.durationMs).toBeLessThanOrEqual(MOTION_NORMAL_MS);
            expect(d.durationMs).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("palette and typography differ from TripSaathi (Req 15.9)", () => {
    const mine = Object.values(palette).map((c) => c.toLowerCase());
    for (const legacy of TRIPSAATHI_LEGACY.colors) {
      expect(mine).not.toContain(legacy.toLowerCase());
    }
    expect(fonts.display).not.toContain(TRIPSAATHI_LEGACY.font);
    expect(fonts.body).not.toContain(TRIPSAATHI_LEGACY.font);
  });
});
