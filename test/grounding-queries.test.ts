import { describe, expect, it } from "vitest";
import { MAX_QUERY_CHARS, buildGroundingQueries, clampDays } from "@/lib/grounding/queries";

describe("buildGroundingQueries", () => {
  it("uses the fixed wording and order", () => {
    expect(
      buildGroundingQueries({ destination: "Goa", durationDays: 3, vibe: "beach", budgetLevel: "luxury" }),
    ).toEqual(["best things to do in Goa beach luxury", "3 day itinerary Goa", "local food Goa"]);
  });

  it("omits budget word for mid and vibe when blank", () => {
    expect(buildGroundingQueries({ destination: "Goa", durationDays: 2, vibe: "  ", budgetLevel: "mid" })[0]).toBe(
      "best things to do in Goa",
    );
  });

  it("clamps the day count", () => {
    expect(clampDays(0)).toBe(1);
    expect(clampDays(31)).toBe(30);
    expect(clampDays(2.4)).toBe(2);
    expect(clampDays(Number.NaN)).toBe(1);
    expect(clampDays(undefined)).toBe(1);
    expect(buildGroundingQueries({ destination: "Goa" })[1]).toBe("1 day itinerary Goa");
  });

  it("caps at 120 chars, truncating vibe before destination", () => {
    const q = buildGroundingQueries({ destination: "Goa", vibe: "x".repeat(300), budgetLevel: "budget" });
    expect(q[0].length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
    expect(q[0].startsWith("best things to do in Goa ")).toBe(true);
    expect(q[0].endsWith(" budget")).toBe(true);

    const long = buildGroundingQueries({ destination: "D".repeat(300), vibe: "beach" });
    for (const s of long) expect(s.length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
    expect(long[0]).toContain("best things to do in D");
  });

  it("returns [] for an empty destination and strips control chars", () => {
    expect(buildGroundingQueries({ destination: " \u0000\t " })).toEqual([]);
    expect(buildGroundingQueries({})).toEqual([]);
    expect(buildGroundingQueries({ destination: "Go\u0000a   City" })[2]).toBe("local food Go a City");
  });
});
