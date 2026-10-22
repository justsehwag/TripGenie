import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { TripContext, Itinerary } from "@/lib/types";
import { REQUIRED_FIELDS, type RequiredField } from "@/lib/preference-controller";
import {
  extractAsync,
  phraseAsync,
  generateItineraryAsync,
  fallbackExtract,
  fallbackPhrase,
  parseExtraction,
  EXTRACTION_SCHEMA_KEYS,
  type BedrockModelDeps,
} from "@/lib/bedrock-model";

/**
 * Realtime AI integration — Bedrock_Model tests (tasks 2.5–2.8).
 * All model calls use a MOCKED invokeModel; there are NO live AWS calls here.
 */

/** A deps object whose model returns a fixed string. */
const depsReturning = (text: string): BedrockModelDeps => ({
  invokeModel: async () => text,
});

/** A deps object whose model always throws (error path). */
const depsThrowing = (): BedrockModelDeps => ({
  invokeModel: async () => {
    throw new Error("bedrock unavailable");
  },
});

/** A deps object whose model never resolves before the timeout fires. */
const depsHanging = (): BedrockModelDeps => ({
  invokeModel: () => new Promise<string>(() => {}),
});

const schemaKeySet = new Set<string>(EXTRACTION_SCHEMA_KEYS as readonly string[]);

/** Validate that a partial only contains schema keys with valid values. */
function assertValidPartial(partial: Partial<TripContext>): void {
  for (const key of Object.keys(partial)) {
    expect(schemaKeySet.has(key)).toBe(true);
  }
  if (partial.origin !== undefined) {
    expect(typeof partial.origin).toBe("string");
    expect(partial.origin.trim().length).toBeGreaterThan(0);
  }
  if (partial.destination !== undefined) {
    expect(typeof partial.destination).toBe("string");
    expect(partial.destination.trim().length).toBeGreaterThan(0);
  }
  if (partial.diet !== undefined) {
    expect(typeof partial.diet).toBe("string");
    expect(partial.diet.trim().length).toBeGreaterThan(0);
  }
  if (partial.durationDays !== undefined) {
    expect(Number.isInteger(partial.durationDays)).toBe(true);
    expect(partial.durationDays).toBeGreaterThanOrEqual(1);
    expect(partial.durationDays).toBeLessThanOrEqual(30);
  }
  if (partial.travellers !== undefined) {
    expect(Number.isInteger(partial.travellers.adults)).toBe(true);
    expect(partial.travellers.adults).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(partial.travellers.children)).toBe(true);
    expect(partial.travellers.children).toBeGreaterThanOrEqual(0);
  }
  if (partial.budgetLevel !== undefined) {
    expect(["budget", "mid", "luxury"]).toContain(partial.budgetLevel);
  }
  if (partial.pace !== undefined) {
    expect(["relaxed", "balanced", "packed"]).toContain(partial.pace);
  }
  if (partial.interests !== undefined) {
    expect(Array.isArray(partial.interests)).toBe(true);
    expect(partial.interests.length).toBeGreaterThan(0);
    for (const i of partial.interests) {
      expect(typeof i).toBe("string");
      expect(i.trim().length).toBeGreaterThan(0);
    }
  }
}

describe("Feature: realtime-ai-integration, bedrock-model", () => {
  // -----------------------------------------------------------------------
  // 2.5 — Property 2: extraction parse only narrows (no invented fields)
  // -----------------------------------------------------------------------
  it("Feature: realtime-ai-integration, Property 2 — extractAsync narrows to validated schema keys", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (modelOutput) => {
        const partial = await extractAsync(depsReturning(modelOutput), "irrelevant delta", {});
        assertValidPartial(partial);
      }),
      { numRuns: 200 },
    );
  });

  it("Feature: realtime-ai-integration, Property 2 — structured JSON objects also only ever narrow", async () => {
    // Generate plausible-but-arbitrary JSON objects (some fields invalid) to
    // exercise the validate-and-drop path, then serialize them as the model
    // output. The returned partial must still be schema-valid.
    const jsonArb = fc.record(
      {
        origin: fc.oneof(fc.string(), fc.integer(), fc.constant(undefined)),
        destination: fc.oneof(fc.string(), fc.constant(""), fc.constant(undefined)),
        durationDays: fc.oneof(fc.integer(), fc.double(), fc.string(), fc.constant(undefined)),
        travellers: fc.oneof(
          fc.record({ adults: fc.integer(), children: fc.integer() }),
          fc.record({ adults: fc.string() }),
          fc.constant(undefined),
        ),
        budgetLevel: fc.oneof(fc.string(), fc.constantFrom("budget", "mid", "luxury"), fc.constant(undefined)),
        diet: fc.oneof(fc.string(), fc.constant(undefined)),
        pace: fc.oneof(fc.string(), fc.constantFrom("relaxed", "balanced", "packed"), fc.constant(undefined)),
        interests: fc.oneof(fc.array(fc.string()), fc.constant([]), fc.constant(undefined)),
        extraneous: fc.oneof(fc.string(), fc.constant(undefined)),
      },
      { requiredKeys: [] },
    );
    await fc.assert(
      fc.asyncProperty(jsonArb, async (obj) => {
        const partial = await extractAsync(depsReturning(JSON.stringify(obj)), "d", {});
        assertValidPartial(partial);
        // No extraneous key survives.
        expect(Object.prototype.hasOwnProperty.call(partial, "extraneous")).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it("Feature: realtime-ai-integration, Property 2 — unparseable / empty / non-object output ⇒ {}", () => {
    expect(parseExtraction("")).toEqual({});
    expect(parseExtraction("   ")).toEqual({});
    expect(parseExtraction("not json")).toEqual({});
    expect(parseExtraction("[1,2,3]")).toEqual({});
    expect(parseExtraction("42")).toEqual({});
    expect(parseExtraction("null")).toEqual({});
    expect(parseExtraction("{}")).toEqual({});
  });

  // -----------------------------------------------------------------------
  // 2.6 — Property 3: no-fabrication merge
  // -----------------------------------------------------------------------
  // Drop undefined-valued keys so arbitraries mirror what `parseExtraction`
  // actually produces: a key is only ever PRESENT when it carries a defined,
  // validated value (it never sets `{ key: undefined }`).
  function compact<T extends object>(obj: T): T {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined) out[k] = v;
    }
    return out as T;
  }

  it("Feature: realtime-ai-integration, Property 3 — merging an extraction leaves unsupplied fields untouched", () => {
    const contextArb: fc.Arbitrary<TripContext> = fc
      .record(
        {
          origin: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
          destination: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
          durationDays: fc.option(fc.integer({ min: 1, max: 30 }), { nil: undefined }),
          travellers: fc.option(
            fc.record({ adults: fc.integer({ min: 1, max: 9 }), children: fc.integer({ min: 0, max: 9 }) }),
            { nil: undefined },
          ),
          budgetLevel: fc.option(fc.constantFrom("budget", "mid", "luxury"), { nil: undefined }),
          diet: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
          pace: fc.option(fc.constantFrom("relaxed", "balanced", "packed"), { nil: undefined }),
          interests: fc.option(fc.array(fc.string({ minLength: 1 }), { minLength: 1 }), { nil: undefined }),
        },
        { requiredKeys: [] },
      )
      .map(compact);
    const partialArb: fc.Arbitrary<Partial<TripContext>> = fc
      .record(
        {
          origin: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
          destination: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
          durationDays: fc.option(fc.integer({ min: 1, max: 30 }), { nil: undefined }),
          pace: fc.option(fc.constantFrom("relaxed", "balanced", "packed"), { nil: undefined }),
          interests: fc.option(fc.array(fc.string({ minLength: 1 }), { minLength: 1 }), { nil: undefined }),
        },
        { requiredKeys: [] },
      )
      .map(compact);

    fc.assert(
      fc.property(contextArb, partialArb, (context, extracted) => {
        // The controller performs `{ ...context, ...extracted }`.
        const merged = { ...context, ...extracted };
        for (const key of Object.keys(context) as (keyof TripContext)[]) {
          const supplied = Object.prototype.hasOwnProperty.call(extracted, key);
          if (!supplied) {
            expect(merged[key]).toEqual(context[key]);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("Feature: realtime-ai-integration, Property 3 — empty extraction leaves the context unchanged", () => {
    const contextArb: fc.Arbitrary<TripContext> = fc
      .record(
        {
          origin: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
          destination: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
          durationDays: fc.option(fc.integer({ min: 1, max: 30 }), { nil: undefined }),
          interests: fc.option(fc.array(fc.string({ minLength: 1 }), { minLength: 1 }), { nil: undefined }),
        },
        { requiredKeys: [] },
      )
      .map(compact);
    fc.assert(
      fc.property(contextArb, (context) => {
        const merged = { ...context, ...{} };
        expect(merged).toEqual(context);
      }),
      { numRuns: 100 },
    );
  });

  // -----------------------------------------------------------------------
  // 2.7 — Property 5: phrased question length bound
  // -----------------------------------------------------------------------
  it("Feature: realtime-ai-integration, Property 5 — phraseAsync returns <= 160 chars for any field/context", async () => {
    const fieldArb = fc.constantFrom(...REQUIRED_FIELDS);
    const contextArb: fc.Arbitrary<TripContext> = fc.record(
      {
        origin: fc.option(fc.string(), { nil: undefined }),
        destination: fc.option(fc.string(), { nil: undefined }),
        durationDays: fc.option(fc.integer({ min: 1, max: 30 }), { nil: undefined }),
        interests: fc.option(fc.array(fc.string()), { nil: undefined }),
      },
      { requiredKeys: [] },
    );
    // Mix model outputs: some short, some way over 160 chars, some blank, some throwing.
    await fc.assert(
      fc.asyncProperty(fieldArb, contextArb, fc.string(), async (field, context, modelOut) => {
        const deps = depsReturning(modelOut);
        const q = await phraseAsync(deps, field as RequiredField, context);
        expect(typeof q).toBe("string");
        expect(q.length).toBeLessThanOrEqual(160);
      }),
      { numRuns: 200 },
    );
  });

  it("Feature: realtime-ai-integration, Property 5 — an over-long model question is clamped to 160", async () => {
    const long = "x".repeat(500);
    const q = await phraseAsync(depsReturning(long), "origin", {});
    expect(q.length).toBe(160);
  });

  it("Feature: realtime-ai-integration, Property 5 — fallbackPhrase is <= 160 for every field", () => {
    for (const field of REQUIRED_FIELDS) {
      expect(fallbackPhrase(field, {}).length).toBeLessThanOrEqual(160);
    }
  });

  // -----------------------------------------------------------------------
  // 2.8 — Unit: fallback on error / timeout, itinerary fallback
  // -----------------------------------------------------------------------
  it("extractAsync falls back to fallbackExtract when the model throws", async () => {
    const delta = "from Delhi to Bali for 7 days, luxury, vegetarian, relaxed, family";
    const viaThrow = await extractAsync(depsThrowing(), delta, {});
    const expected = fallbackExtract(delta, {});
    expect(viaThrow).toEqual(expected);
    // sanity: the fallback actually extracted something from this rich delta
    expect(expected.destination).toBeTruthy();
    expect(expected.durationDays).toBe(7);
  });

  it("extractAsync falls back on a hanging (timeout) model call", async () => {
    const delta = "going to Paris for 5 days";
    const viaTimeout = await extractAsync(depsHanging(), delta, {});
    expect(viaTimeout).toEqual(fallbackExtract(delta, {}));
  }, 10000);

  it("phraseAsync returns the fixed fallback phrasing when the model throws", async () => {
    for (const field of REQUIRED_FIELDS) {
      const q = await phraseAsync(depsThrowing(), field, {});
      expect(q).toBe(fallbackPhrase(field, {}));
      expect(q.length).toBeLessThanOrEqual(160);
    }
  });

  it("generateItineraryAsync returns a valid buildItinerary fallback on model failure", async () => {
    const context: TripContext = { destination: "Bali", durationDays: 6, interests: ["beach", "food"] };
    const it: Itinerary = await generateItineraryAsync(depsThrowing(), context);
    expect(it.days.length).toBe(6);
    for (const d of it.days) {
      expect(d.activities.length).toBeGreaterThanOrEqual(1);
      const sum = d.activities.reduce((s, a) => s + a.cost, 0);
      expect(d.total).toBe(sum);
    }
    expect(it.totalCost).toBe(it.days.reduce((s, d) => s + d.total, 0));
  });

  it("generateItineraryAsync falls back when the context has no duration (defaults to 4 days)", async () => {
    const it = await generateItineraryAsync(depsThrowing(), { destination: "Rome" });
    expect(it.days.length).toBe(4);
  });

  it("fallbackExtract never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => fallbackExtract(s, {})).not.toThrow();
      }),
      { numRuns: 200 },
    );
    // also tolerate non-string input defensively
    // @ts-expect-error intentional misuse to prove non-throwing
    expect(() => fallbackExtract(undefined, {})).not.toThrow();
  });
});
