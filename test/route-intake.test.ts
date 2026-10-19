import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseRoute, emptyRouteState, routeConfirmed } from "@/lib/route-intake";

/** Feature: tripgenie - route intake property tests (Properties 1-6). */

const city = fc
  .string({ minLength: 2, maxLength: 12 })
  .map((s) => s.replace(/[^a-zA-Z]/g, "x"))
  .filter((s) => s.length >= 2);

describe("Feature: tripgenie, route intake", () => {
  it("Property 1: Route assignment never swaps origin and destination", () => {
    fc.assert(
      fc.property(city, city, (a, b) => {
        const r = parseRoute(`from ${a} to ${b}`, emptyRouteState());
        expect(r.origin.toLowerCase()).toContain(a.toLowerCase().slice(0, 3));
        expect(r.destination.toLowerCase()).toContain(b.toLowerCase().slice(0, 3));
      }),
      { numRuns: 100 },
    );
  });

  it("Property 2: Verb-command prefix is excluded and treated as destination-only", () => {
    fc.assert(
      fc.property(city, (d) => {
        const r = parseRoute(`travel to ${d}`, emptyRouteState());
        expect(r.destination.toLowerCase()).not.toContain("travel");
        expect(r.destinationConfirmed).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("Property 3: Bare place name without direction is held as a route candidate", () => {
    fc.assert(
      fc.property(city, (p) => {
        const r = parseRoute(p, emptyRouteState());
        expect(r.routeCandidate.length).toBeGreaterThan(0);
        expect(r.origin).toBe("");
        expect(r.destination).toBe("");
      }),
      { numRuns: 100 },
    );
  });

  it("Property 4: Stored place names are bounded to 100 characters", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 120, maxLength: 200 }).map((s) => s.replace(/[^a-zA-Z]/g, "x")),
        city,
        (long, b) => {
          const r = parseRoute(`from ${long} to ${b}`, emptyRouteState());
          expect(r.origin.length).toBeLessThanOrEqual(100);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Property 5: Confirmed route hydrates and advances, even on restored values", () => {
    fc.assert(
      fc.property(city, city, (a, b) => {
        const restored = parseRoute(`from ${a} to ${b}`, emptyRouteState());
        const again = parseRoute(`from ${a} to ${b}`, restored);
        expect(routeConfirmed(again)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("Property 6: Unparseable route input preserves state", () => {
    fc.assert(
      fc.property(city, city, (a, b) => {
        const base = parseRoute(`from ${a} to ${b}`, emptyRouteState());
        const after = parseRoute("!!! ??? ### 12345", base);
        expect(after.origin).toBe(base.origin);
        expect(after.destination).toBe(base.destination);
      }),
      { numRuns: 100 },
    );
  });
});
