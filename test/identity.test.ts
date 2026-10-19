import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  greeting,
  landingControls,
  persistenceTarget,
  postAuth,
  type Provider,
} from "@/lib/identity";

/** Feature: tripgenie - identity tests (Property 48 + greeting/persistence). */

const ALL: Provider[] = ["email", "google", "facebook", "github"];

describe("Feature: tripgenie, identity", () => {
  it("Property 48: Account landing controls match the enabled provider policy", () => {
    fc.assert(
      fc.property(fc.subarray(ALL), (enabled) => {
        const controls = landingControls({ enabledProviders: enabled });
        const shown = controls.map((c) => c.provider);
        // Exactly the enabled providers are shown (no more, no less).
        expect(shown.slice().sort()).toEqual([...new Set(enabled)].sort());
        // Every shown control has a non-empty label.
        for (const c of controls) expect(c.label.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });

  it("greets by first name when present, else a generic no-name greeting (Req 1.8/1.9)", () => {
    expect(greeting({ userId: "u1", firstName: "Asha" })).toContain("Asha");
    const generic = greeting({ userId: "u1" });
    expect(generic).not.toContain("@");
    expect(generic.toLowerCase()).toContain("tripgenie");
    // A blank/missing first name is treated as generic.
    expect(greeting({ userId: "u1", firstName: "  " })).toBe(generic);
  });

  it("anonymous visitors persist to browser-local, authenticated to DynamoDB (Req 1.5/13.1)", () => {
    expect(persistenceTarget(null)).toBe("browser-local");
    expect(persistenceTarget({ userId: "" })).toBe("browser-local");
    expect(persistenceTarget({ userId: "u1" })).toBe("dynamodb");
  });

  it("on auth failure/cancel/timeout returns to landing and preserves drafts (Req 1.10)", () => {
    for (const o of ["failed", "cancelled", "timeout"] as const) {
      const r = postAuth(o);
      expect(r.landing).toBe(true);
      expect(r.preserveDrafts).toBe(true);
      expect(r.error).toBeDefined();
    }
    const ok = postAuth("success");
    expect(ok.landing).toBe(false);
  });
});
