import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { searxngEnabled, webPricingEnabled } from "../lib/config";

const WEB = "TRIPGENIE_WEB_PRICING_ENABLED";
const SX = "TRIPGENIE_SEARXNG_ENABLED";

let savedWeb: string | undefined;
let savedSx: string | undefined;

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  savedWeb = process.env[WEB];
  savedSx = process.env[SX];
});

afterEach(() => {
  setEnv(WEB, savedWeb);
  setEnv(SX, savedSx);
});

// Feature: web-grounded-pricing, Property 5: Research flag parsing
describe("webPricingEnabled (Property 5)", () => {
  it("is true exactly for trimmed, case-insensitive 'true' or '1'", () => {
    // **Validates: Requirements 4.1, 4.4**
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: undefined }), (value) => {
        setEnv(WEB, value);
        const norm = (value ?? "").trim().toLowerCase();
        expect(webPricingEnabled()).toBe(norm === "true" || norm === "1");
      }),
      { numRuns: 200 },
    );
  });

  it("accepts case and whitespace variants of true", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("true", "1"),
        fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
        fc.constantFrom("", " ", "\t", "\n"),
        fc.constantFrom("", " ", "\t", "\n"),
        (base, flips, pre, post) => {
          const cased = base
            .split("")
            .map((ch, i) => (flips[i % flips.length] ? ch.toUpperCase() : ch))
            .join("");
          setEnv(WEB, pre + cased + post);
          expect(webPricingEnabled()).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("is independent of the SearXNG flag for all four combinations", () => {
    fc.assert(
      fc.property(
        fc.option(fc.string(), { nil: undefined }),
        fc.option(fc.string(), { nil: undefined }),
        (web, sx) => {
          setEnv(WEB, web);
          setEnv(SX, undefined);
          const alone = webPricingEnabled();
          setEnv(SX, sx);
          expect(webPricingEnabled()).toBe(alone);
        },
      ),
      { numRuns: 100 },
    );
    for (const web of ["true", "off"]) {
      for (const sx of ["true", "off"]) {
        setEnv(WEB, web);
        setEnv(SX, sx);
        expect(webPricingEnabled()).toBe(web === "true");
        expect(searxngEnabled()).toBe(sx === "true");
      }
    }
  });

  it("is off when unset", () => {
    setEnv(WEB, undefined);
    expect(webPricingEnabled()).toBe(false);
  });
});
