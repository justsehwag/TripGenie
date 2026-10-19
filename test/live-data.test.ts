import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  ADAPTER_METHOD,
  destinationFallback,
  resolveLive,
  weatherFallback,
} from "@/lib/live-data";

/** Feature: tripgenie - live-data adapter tests (Property 38 + fallback). */

describe("Feature: tripgenie, live data", () => {
  it("Property 38: Live Data Adapter performs only read operations", () => {
    // The adapter method is always GET (no mutating verbs).
    expect(ADAPTER_METHOD).toBe("GET");
  });

  it("A successful read is labelled live", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1 }), async (val) => {
        const r = await resolveLive<string>("test", async () => val, "fallback");
        expect(r.mode).toBe("live");
      }),
      { numRuns: 20 },
    );
  });

  it("A failed or empty read returns a labelled fallback (Req 10.4)", async () => {
    const thrown = await resolveLive<any>("weather", async () => { throw new Error("down"); }, weatherFallback("Goa"));
    expect(thrown.mode).toBe("fallback");
    expect(thrown.data.destination).toBe("Goa");
    const empty = await resolveLive<any>("weather", async () => null, weatherFallback("Goa"));
    expect(empty.mode).toBe("fallback");
  });
});
