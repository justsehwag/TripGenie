import { describe, expect, it } from "vitest";
import { extractPlaceName, normalizePlaceText, placeMatches } from "@/lib/grounding/place-match";

describe("normalizePlaceText", () => {
  it("strips accents, punctuation and case", () => {
    expect(normalizePlaceText("  Café  du Monde!! ")).toBe("cafe du monde");
    expect(normalizePlaceText("St. Mary's—Church")).toBe("st mary s church");
  });
});

describe("placeMatches", () => {
  it("matches verbatim and accent-insensitive names", () => {
    expect(placeMatches("Baga Beach", ["Top spots: Baga Beach and more"])).toBe(true);
    expect(placeMatches("Cafe du Monde", ["Visit Café du Monde today"])).toBe(true);
    expect(placeMatches("Café", ["cafe"])).toBe(true);
  });
  it("does not match absent names", () => {
    expect(placeMatches("Eiffel Tower", ["Louvre museum"])).toBe(false);
  });
  it("is false for empty or punctuation-only names", () => {
    expect(placeMatches("", ["anything"])).toBe(false);
    expect(placeMatches(" ! ? ", ["anything ! ?"])).toBe(false);
  });
});

describe("extractPlaceName", () => {
  it("extracts after visit-style verbs", () => {
    expect(extractPlaceName("Visit the Eiffel Tower")).toBe("Eiffel Tower");
    expect(extractPlaceName("Explore Fort Aguada (2 hours)")).toBe("Fort Aguada");
  });
  it("extracts after meal prefixes", () => {
    expect(extractPlaceName("Lunch at Fisherman's Wharf, seafood")).toBe("Fisherman's Wharf");
  });
  it("returns empty for generic activities", () => {
    expect(extractPlaceName("Hotel check-in")).toBe("");
    expect(extractPlaceName("Airport transfer")).toBe("");
    expect(extractPlaceName("Free time")).toBe("");
    expect(extractPlaceName("Lunch at a local restaurant")).toBe("");
    expect(extractPlaceName("")).toBe("");
  });
});
