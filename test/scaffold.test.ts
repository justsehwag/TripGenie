import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { awsConfig, loadAwsConfig } from "@/lib/config";
import type {
  Provenance,
  TripContext,
  OfferMeta,
  TripPricing,
  RouteState,
  DateState,
} from "@/lib/types";

/**
 * Scaffold smoke tests: confirm the project, test runner, fast-check wiring,
 * shared types, and AWS config module are in place for Task 1.
 */
describe("TripGenie scaffold", () => {
  it("runs a trivial passing test", () => {
    expect(1 + 1).toBe(2);
  });

  it("loads AWS bindings from env with sensible defaults and no inlined secrets", () => {
    const config = loadAwsConfig();
    expect(config.region).toBeTruthy();
    expect(config.tables.profiles).toBeTruthy();
    expect(config.tables.trips).toBeTruthy();
    expect(config.dynamo.ownerDraftIndex).toBe("owner-draft");
    expect(config.dynamo.ownerUpdatedIndex).toBe("owner-updated");
    expect(config.mcpToolAllowlist.length).toBeGreaterThan(0);
    expect(config.imageHostAllowlist.length).toBeGreaterThan(0);
    // The singleton mirrors a fresh load.
    expect(awsConfig.region).toBe(config.region);
  });

  it("exposes shared domain types that compile and hold the expected shapes", () => {
    const provenance: Provenance = "estimated";
    const route: RouteState = {
      origin: "",
      destination: "",
      routeCandidate: "",
      originConfirmed: false,
      destinationConfirmed: false,
    };
    const dates: DateState = { mode: "flexible", tripDays: 3 };
    const context: TripContext = { origin: "Delhi", destination: "Goa" };
    const meta: OfferMeta = {
      provider: "estimator",
      mode: provenance,
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      disclaimer: "Estimated: no payment, no ticket.",
    };
    const pricing: TripPricing = {
      flight: 0,
      stay: 0,
      activities: 0,
      gross: 0,
      discount: 0,
      coupon: "",
      finalPayable: 0,
      error: "",
    };

    expect(route.origin).toBe("");
    expect(dates.tripDays).toBe(3);
    expect(context.destination).toBe("Goa");
    expect(meta.mode).toBe("estimated");
    expect(pricing.finalPayable).toBe(0);
  });

  it("exercises fast-check so property-based testing is wired (min 100 runs)", () => {
    // Smoke-only: confirms fast-check is available and runs >= 100 iterations.
    fc.assert(
      fc.property(fc.integer(), (n) => n + 0 === n),
      { numRuns: 100 }
    );
  });
});
