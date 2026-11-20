import { describe, expect, it } from "vitest";
import { groundExtraction, isRouteOnlyAnswer, validateDiet } from "../lib/extraction-grounding";

describe("validateDiet", () => {
  it("rejects routes, bare numbers, filler and letterless text", () => {
    expect(validateDiet("From Delhi to Goa")).toBeNull();
    expect(validateDiet("Mumbai to Singapore")).toBeNull();
    expect(validateDiet("5")).toBeNull();
    expect(validateDiet("hello")).toBeNull();
    expect(validateDiet("???")).toBeNull();
    expect(validateDiet("   ")).toBeNull();
  });

  it("accepts real diets and maps none/any to no preference", () => {
    expect(validateDiet("vegetarian")).toBe("vegetarian");
    expect(validateDiet("Jain, no onion")).toBe("Jain, no onion");
    expect(validateDiet("none")).toBe("no preference");
    expect(validateDiet("any")).toBe("no preference");
    expect(validateDiet("No preference")).toBe("no preference");
  });
});

describe("isRouteOnlyAnswer", () => {
  it("is true for a bare route", () => {
    expect(isRouteOnlyAnswer("From Mumbai to Singapore")).toBe(true);
    expect(isRouteOnlyAnswer("Delhi to Goa")).toBe(true);
  });

  it("is false when other detail is present or there is no route", () => {
    expect(isRouteOnlyAnswer("From Delhi to Goa for 5 days")).toBe(false);
    expect(isRouteOnlyAnswer("From Delhi to Goa, relaxed")).toBe(false);
    expect(isRouteOnlyAnswer("vegetarian")).toBe(false);
    expect(isRouteOnlyAnswer("")).toBe(false);
  });
});

describe("groundExtraction", () => {
  it("keeps only origin and destination on a route-only turn", () => {
    const r = groundExtraction({
      text: "From Mumbai to Singapore",
      asked: "diet",
      extracted: {
        origin: "Mumbai",
        destination: "Singapore",
        durationDays: 4,
        diet: "From Mumbai to Singapore",
        pace: "relaxed",
        interests: ["food"],
      },
    });
    expect(r.routeOnly).toBe(true);
    expect(r.fields).toEqual({ origin: "Mumbai", destination: "Singapore" });
    expect(r.dropped.sort()).toEqual(["diet", "durationDays", "interests", "pace"]);
  });

  it("drops invented fields the text does not support", () => {
    const r = groundExtraction({
      text: "3 days please",
      asked: "durationDays",
      extracted: { durationDays: 3, budgetLevel: "luxury", travellers: { adults: 2, children: 0 } },
    });
    expect(r.fields).toEqual({ durationDays: 3 });
    expect(r.dropped.sort()).toEqual(["budgetLevel", "travellers"]);
  });

  it("accepts a bare number for the asked field only", () => {
    expect(groundExtraction({ text: "5", asked: "durationDays", extracted: { durationDays: 5 } }).fields).toEqual({ durationDays: 5 });
    expect(groundExtraction({ text: "5", asked: "travellers", extracted: { travellers: { adults: 5, children: 0 } } }).fields.travellers).toEqual({ adults: 5, children: 0 });
    expect(groundExtraction({ text: "5", asked: "pace", extracted: { durationDays: 5 } }).fields).toEqual({});
  });

  it("keeps supported budget, pace, diet and interests", () => {
    const r = groundExtraction({
      text: "luxury, relaxed, vegetarian, food and culture",
      asked: undefined,
      extracted: { budgetLevel: "luxury", pace: "relaxed", diet: "vegetarian", interests: ["food", "culture"] },
    });
    expect(r.fields).toEqual({ budgetLevel: "luxury", pace: "relaxed", diet: "vegetarian", interests: ["food", "culture"] });
    expect(r.dropped).toEqual([]);
  });

  it("drops a mismatched enum value and route text as interests", () => {
    const r = groundExtraction({
      text: "I want something cheap",
      asked: undefined,
      extracted: { budgetLevel: "luxury" },
    });
    expect(r.fields).toEqual({});
    const route = groundExtraction({ text: "Delhi to Goa", asked: "interests", extracted: { interests: ["Delhi to Goa"] } });
    expect(route.fields.interests).toBeUndefined();
  });

  it("accepts interests as the asked answer and never throws on odd input", () => {
    expect(groundExtraction({ text: "temples, beaches", asked: "interests", extracted: { interests: ["temples", "beaches"] } }).fields.interests).toEqual(["temples", "beaches"]);
    expect(() => groundExtraction({ text: "", asked: undefined, extracted: {} })).not.toThrow();
  });
});
