/**
 * Feature: welcome-screen-polish
 * Chrome hiding helper, hero rotation helpers, welcome markup and gate wiring.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";

const seenQueries = vi.hoisted(() => [] as string[]);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/client/account-session", () => ({
  fetchSession: async () => ({ signedIn: false }),
  notifySession: () => {},
}));
vi.mock("@/components/destination-image", () => ({
  useDestinationImage: (query: string) => {
    seenQueries.push(query);
    return { url: null, loading: false, status: "idle", onError: () => {} };
  },
}));

import AuthLanding from "@/components/auth-landing";
import { hidesChrome, WELCOME_CHROME_ATTR } from "@/lib/welcome-chrome";
import {
  ROTATION_INTERVAL_MS,
  WELCOME_HERO_QUERIES,
  nextIndexOnFailure,
  queryForIndex,
  shouldAdvance,
} from "@/lib/welcome-hero-rotation";

const RUNS = { numRuns: 100 };

describe("hidesChrome", () => {
  it("hides chrome for pending and welcome, not for app", () => {
    expect(hidesChrome("pending")).toBe(true);
    expect(hidesChrome("welcome")).toBe(true);
    expect(hidesChrome("app")).toBe(false);
  });
  it("uses the data-welcome-gate attribute", () => {
    expect(WELCOME_CHROME_ATTR).toBe("data-welcome-gate");
  });
});

describe("welcome hero rotation properties", () => {
  // Feature: welcome-screen-polish, Property 1: Curated query selection is always a valid list member
  it("Property 1: queryForIndex always returns a curated query", () => {
    // **Validates: Requirements 3.1**
    fc.assert(
      fc.property(fc.integer(), (i) => {
        expect(WELCOME_HERO_QUERIES as readonly string[]).toContain(queryForIndex(i));
      }),
      RUNS,
    );
  });

  // Feature: welcome-screen-polish, Property 2: Failure advances to a different, valid next index
  it("Property 2: nextIndexOnFailure returns a different valid index", () => {
    // **Validates: Requirements 3.4**
    expect(WELCOME_HERO_QUERIES.length).toBeGreaterThan(1);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: WELCOME_HERO_QUERIES.length - 1 }), (i) => {
        const next = nextIndexOnFailure(i);
        expect(Number.isInteger(next)).toBe(true);
        expect(next).toBeGreaterThanOrEqual(0);
        expect(next).toBeLessThan(WELCOME_HERO_QUERIES.length);
        expect(next).not.toBe(i);
      }),
      RUNS,
    );
  });

  // Feature: welcome-screen-polish, Property 3: Rotation advances exactly when elapsed time, load state, and motion preference allow it
  it("Property 3: shouldAdvance iff elapsed >= interval && loaded && !reducedMotion", () => {
    // **Validates: Requirements 3.5, 3.6**
    fc.assert(
      fc.property(
        fc.oneof(fc.integer({ min: 0, max: 20000 }), fc.constantFrom(ROTATION_INTERVAL_MS - 1, ROTATION_INTERVAL_MS, ROTATION_INTERVAL_MS + 1)),
        fc.boolean(),
        fc.boolean(),
        (elapsedMs, loaded, reducedMotion) => {
          expect(shouldAdvance({ elapsedMs, loaded, reducedMotion })).toBe(
            elapsedMs >= ROTATION_INTERVAL_MS && loaded && !reducedMotion,
          );
        },
      ),
      RUNS,
    );
  });
});

describe("AuthLanding welcome backdrop", () => {
  it("renders the backdrop with a curated query", () => {
    seenQueries.length = 0;
    const html = renderToStaticMarkup(
      createElement(AuthLanding, { policy: { enabledProviders: ["email", "google"] } } as never),
    );
    expect(html).toContain("account-cine");
    expect(seenQueries.length).toBeGreaterThan(0);
    for (const q of seenQueries) {
      expect(WELCOME_HERO_QUERIES as readonly string[]).toContain(q);
    }
  });
});

describe("WelcomeGate source wiring", () => {
  it("toggles WELCOME_CHROME_ATTR on document.documentElement via hidesChrome", () => {
    const src = readFileSync(join(process.cwd(), "components", "welcome-gate.tsx"), "utf8");
    expect(src).toContain("WELCOME_CHROME_ATTR");
    expect(src).toContain("hidesChrome");
    expect(src).toContain("document.documentElement");
    expect(src).toMatch(/setAttribute\(\s*WELCOME_CHROME_ATTR/);
    expect(src).toMatch(/removeAttribute\(\s*WELCOME_CHROME_ATTR/);
  });
});
