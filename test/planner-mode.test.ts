import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DEFAULT_PLANNER_MODE,
  PLANNER_MODE_KEY,
  parsePlannerMode,
  readStoredMode,
  resolveInitialMode,
  writeStoredMode,
  type PlannerMode,
} from "@/lib/planner-mode";

// Feature: trip-planning-v2, Property 1: Planner mode storage round trip and safe default
// **Validates: Requirements 1.5, 1.6, 1.7**

const modeArb = fc.constantFrom<PlannerMode>("quick", "chat");

/** Arbitrary stored values, including non-strings. */
const junkArb = fc.oneof(
  fc.string(),
  fc.constant(null),
  fc.constant(undefined),
  fc.integer(),
  fc.boolean(),
  fc.double(),
  fc.array(fc.string()),
  fc.dictionary(fc.string(), fc.string()),
  fc.constantFrom("Quick", "CHAT", " quick", "chat ", "", "quick\n"),
);

function memoryStorage(initial?: unknown) {
  const map = new Map<string, unknown>();
  if (initial !== undefined) map.set(PLANNER_MODE_KEY, initial);
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k) : null) as string | null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

const throwingStorage = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("quota");
  },
};

describe("planner-mode", () => {
  it("Feature: trip-planning-v2, Property 1: write then read returns the same mode", () => {
    fc.assert(
      fc.property(modeArb, (mode) => {
        const s = memoryStorage();
        expect(writeStoredMode(s, mode)).toBe(true);
        expect(readStoredMode(s)).toBe(mode);
        expect(resolveInitialMode(readStoredMode(s), false)).toBe(mode);
      }),
      { numRuns: 100 },
    );
  });

  it("Feature: trip-planning-v2, Property 1: absent, unrecognised or non-string values resolve to chat", () => {
    fc.assert(
      fc.property(junkArb, (raw) => {
        const expected = raw === "quick" || raw === "chat" ? raw : null;
        expect(parsePlannerMode(raw)).toBe(expected);
        expect(readStoredMode(memoryStorage(raw))).toBe(expected);
        expect(resolveInitialMode(raw, false)).toBe(expected ?? "chat");
      }),
      { numRuns: 100 },
    );
  });

  it("Feature: trip-planning-v2, Property 1: throwing or missing storage never throws", () => {
    fc.assert(
      fc.property(modeArb, junkArb, (mode, raw) => {
        expect(readStoredMode(throwingStorage)).toBeNull();
        expect(writeStoredMode(throwingStorage, mode)).toBe(false);
        expect(readStoredMode(undefined)).toBeNull();
        expect(writeStoredMode(undefined, mode)).toBe(false);
        expect(resolveInitialMode(readStoredMode(throwingStorage), false)).toBe("chat");
        expect(() => resolveInitialMode(raw, false)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it("Feature: trip-planning-v2, Property 1: a hand-off forces chat for any stored value", () => {
    fc.assert(
      fc.property(fc.oneof(modeArb, junkArb), (raw) => {
        expect(resolveInitialMode(raw, true)).toBe("chat");
      }),
      { numRuns: 100 },
    );
  });

  it("uses a tripgenie. prefixed storage key and chat default", () => {
    expect(PLANNER_MODE_KEY.startsWith("tripgenie.")).toBe(true);
    expect(DEFAULT_PLANNER_MODE).toBe("chat");
  });

  it("a hand-off forces chat even when quick is stored", () => {
    const s = memoryStorage();
    writeStoredMode(s, "quick");
    expect(resolveInitialMode(readStoredMode(s), true)).toBe("chat");
    expect(resolveInitialMode(readStoredMode(s), false)).toBe("quick");
  });

  it("does not write invalid modes", () => {
    const s = memoryStorage();
    expect(writeStoredMode(s, "bogus" as PlannerMode)).toBe(false);
    expect(readStoredMode(s)).toBeNull();
  });
});
