import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ILLUSTRATIONS, illustration, type IllustrationId } from "@/lib/illustrations";

// Feature: ui-redesign, Property 12: Illustration registry integrity and reuse.
//
// Property-based suite over lib/illustrations.ts (ui-redesign spec, task 6.2).
// Validates: Requirements 17.4, 17.5.

const NUM_RUNS = { numRuns: 100 } as const;

/** The seven cohesive travel illustrations the registry must expose (Req 17.4). */
const EXPECTED_IDS: readonly IllustrationId[] = [
  "traveler-globe",
  "location-pin",
  "hot-air-balloon",
  "tropical-plant",
  "winding-path",
  "suitcase",
  "abstract-landscape",
];

/** A fast-check arbitrary over every id in the registry. */
const idArb = fc.constantFrom(...(Object.keys(ILLUSTRATIONS) as IllustrationId[]));

/** Directory of this test file, for resolving on-disk asset paths. */
const here = path.dirname(fileURLToPath(import.meta.url));

describe("Feature: ui-redesign, illustration registry", () => {
  it("Property 12: every id resolves to a well-formed asset", () => {
    fc.assert(
      fc.property(idArb, (id) => {
        const asset = illustration(id);

        // id round-trips.
        expect(asset.id).toBe(id);

        // src is a non-empty public SVG path.
        expect(typeof asset.src).toBe("string");
        expect(asset.src.length).toBeGreaterThan(0);
        expect(asset.src.startsWith("/illustrations/")).toBe(true);
        expect(asset.src.endsWith(".svg")).toBe(true);

        // Positive intrinsic dimensions so aspect ratio is preserved.
        expect(typeof asset.width).toBe("number");
        expect(typeof asset.height).toBe("number");
        expect(asset.width).toBeGreaterThan(0);
        expect(asset.height).toBeGreaterThan(0);

        // Non-empty descriptive alt text.
        expect(typeof asset.alt).toBe("string");
        expect(asset.alt.trim().length).toBeGreaterThan(0);
      }),
      NUM_RUNS,
    );
  });

  it("Property 12: shared-concept reuse is deterministic (Req 17.5)", () => {
    fc.assert(
      fc.property(idArb, (id) => {
        // Two calls for the same concept resolve to the same asset src.
        expect(illustration(id).src).toBe(illustration(id).src);
        // And that src is exactly the registry's single source of truth.
        expect(illustration(id).src).toBe(ILLUSTRATIONS[id].src);
      }),
      NUM_RUNS,
    );
  });

  it("Property 12: registry exposes exactly the seven expected ids (Req 17.4)", () => {
    const keys = Object.keys(ILLUSTRATIONS).sort();
    expect(keys).toEqual([...EXPECTED_IDS].sort());
    expect(keys).toHaveLength(7);
  });

  it("Property 12: an unknown id fails fast (Req 17.4)", () => {
    expect(() => illustration("not-a-real-id" as IllustrationId)).toThrow();
  });

  it("Property 12: every asset src exists on disk under public/", () => {
    for (const id of EXPECTED_IDS) {
      const asset = illustration(id);
      const file = path.resolve(here, "../public" + asset.src);
      expect(existsSync(file), `missing SVG for "${id}" at ${file}`).toBe(true);
    }
  });
});
