// @vitest-environment node
import { describe, it, expect } from "vitest";

import { planCandidateQueries, widenPlan } from "@/lib/itinerary/interests";
import { DEFAULT_ROW, NON_VISIT_TYPES, VISIT_MINUTES, MEAL_TYPES } from "@/lib/itinerary/place-categories";

const plan = (interests: unknown[] | undefined, batchIndex = 0) =>
  planCandidateQueries({ destination: "Goa", interests, batchIndex });

describe("planCandidateQueries", () => {
  it("uses the default row when no usable interest remains", () => {
    for (const x of [undefined, [], ["", "  "], [1, null]]) {
      const p = plan(x as unknown[] | undefined);
      expect(p.textQueries).toEqual([
        "tourist attractions in Goa",
        "museums in Goa",
        "parks in Goa",
        "restaurants in Goa",
      ]);
      expect(p.nearbyTypes).toEqual([...DEFAULT_ROW.types]);
    }
  });

  it("maps keys case-insensitively and round-robins phrases", () => {
    const p = plan(["  FOOD ", "Beaches", "history"]);
    expect(p.textQueries).toEqual([
      "restaurants in Goa",
      "beaches in Goa",
      "tourist attractions in Goa",
      "local food in Goa",
    ]);
    expect(p.nearbyTypes).toEqual(["restaurant", "beach", "tourist_attraction", "museum", "historical_landmark", "place_of_worship"]);
  });

  it("dedupes case-insensitively and keeps the first 4", () => {
    const p = plan(["food", "FOOD", "nature", "shopping", "nightlife", "adventure"]);
    expect(p.textQueries).toEqual(["restaurants in Goa", "parks in Goa", "shopping malls in Goa", "bars in Goa"]);
    expect(p.nearbyTypes).not.toContain("amusement_park");
  });

  it("turns an unknown interest into a query with no type", () => {
    const p = plan(["Street Art"]);
    expect(p.textQueries).toEqual(["Street Art in Goa"]);
    expect(p.nearbyTypes).toEqual([...DEFAULT_ROW.types]);
    const q = plan(["street art", "food"]);
    expect(q.nearbyTypes).toEqual(["restaurant"]);
  });

  it("does not treat prototype keys as interests", () => {
    expect(plan(["constructor"]).textQueries).toEqual(["constructor in Goa"]);
  });

  it("rotates phrases by batchIndex x 4 and doubles the radius up to 50 km", () => {
    const p1 = plan(["culture", "food", "nature"], 1);
    const all = ["tourist attractions", "restaurants", "parks", "museums", "local food", "beaches", "historical landmarks", "nature spots"];
    expect(p1.textQueries).toEqual([4, 5, 6, 7].map((k) => `${all[k]} in Goa`));
    expect(plan(undefined, 0).nearbyRadiusM).toBe(6000);
    expect(plan(undefined, 2).nearbyRadiusM).toBe(24000);
    expect(plan(undefined, 4).nearbyRadiusM).toBe(50000);
  });

  it("caps nearby types at 8", () => {
    expect(plan(["culture", "nature", "shopping", "nightlife"]).nearbyTypes.length).toBe(8);
  });
});

describe("widenPlan", () => {
  it("doubles the radius (capped) and joins default and selected phrases", () => {
    const p = plan(["food"], 2);
    const w = widenPlan(p, ["food"], "Goa");
    expect(w.nearby).toEqual({ radiusM: 48000, types: ["restaurant"] });
    expect(w.text).toBe("tourist attractions or museums or parks or restaurants or local food in Goa");
    expect(widenPlan(plan(undefined, 3), undefined, "Goa").nearby.radiusM).toBe(50000);
  });
});

describe("tables", () => {
  it("holds the Assumption (d) lengths and excluded types", () => {
    expect(VISIT_MINUTES.museum).toBe(90);
    expect(VISIT_MINUTES.amusement_park).toBe(180);
    expect(MEAL_TYPES).toContain("restaurant");
    expect(NON_VISIT_TYPES).toContain("lodging");
    expect(NON_VISIT_TYPES.length).toBe(15);
  });
});
