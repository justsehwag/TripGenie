import { describe, it, expect } from "vitest";
import { sanitizeWebDetails } from "@/lib/itinerary/web-details";
import { CANDIDATE_FIELD_MASK } from "@/lib/providers/google-places";

const GOOD = {
  text: "Book ahead on weekends.",
  sourceUrl: "https://asi.example.org/fort",
  sourceHost: "asi.example.org",
  checkedAt: "2025-03-12T09:00:00.000Z",
};

describe("sanitizeWebDetails", () => {
  it("drops non-objects and a non-boolean checked", () => {
    for (const v of [undefined, null, 1, "x", [], {}, { checked: "yes" }]) {
      expect(sanitizeWebDetails(v)).toBeUndefined();
    }
  });

  it("keeps valid details and priceKind", () => {
    const out = sanitizeWebDetails({
      checked: true,
      tip: GOOD,
      booking: GOOD,
      bestTime: GOOD,
      priceKind: "entry",
      extra: 1,
    });
    expect(out).toEqual({
      checked: true,
      tip: GOOD,
      booking: GOOD,
      bestTime: GOOD,
      priceKind: "entry",
    });
  });

  it("drops only the invalid detail", () => {
    const out = sanitizeWebDetails({
      checked: false,
      tip: { ...GOOD, sourceUrl: "http://asi.example.org/fort" },
      booking: { ...GOOD, sourceHost: "other.example.org" },
      bestTime: { ...GOOD, text: "" },
      priceKind: "typical",
    });
    expect(out).toEqual({ checked: false, priceKind: "typical" });
  });

  it("enforces the 1 to 240 character text bound", () => {
    expect(
      sanitizeWebDetails({ checked: true, tip: { ...GOOD, text: "a".repeat(240) } })?.tip,
    ).toBeDefined();
    expect(
      sanitizeWebDetails({ checked: true, tip: { ...GOOD, text: "a".repeat(241) } })?.tip,
    ).toBeUndefined();
  });

  it("rejects an unknown priceKind and a bad checkedAt", () => {
    const out = sanitizeWebDetails({
      checked: true,
      priceKind: "free",
      tip: { ...GOOD, checkedAt: "not a date" },
    });
    expect(out).toEqual({ checked: true });
  });
});

describe("CANDIDATE_FIELD_MASK", () => {
  it("lists exactly the 13 fields with no wildcard", () => {
    const parts = CANDIDATE_FIELD_MASK.split(",");
    expect(parts).toHaveLength(13);
    expect(new Set(parts).size).toBe(13);
    expect(CANDIDATE_FIELD_MASK).not.toContain("*");
    expect(parts.every((p) => p.startsWith("places."))).toBe(true);
  });
});
