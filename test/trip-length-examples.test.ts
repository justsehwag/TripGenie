import { describe, expect, it } from "vitest";
import { resolveTripLength } from "../lib/itinerary/trip-length";
import { dateSpanNotice } from "../lib/itinerary/labels";

describe("resolveTripLength examples", () => {
  it("field wins over context and dates", () => {
    expect(
      resolveTripLength({ field: "5 days", contextDays: 2, startDate: "2026-01-01", endDate: "2026-01-02" }),
    ).toEqual({ days: 5, capped: false, dateSpanDays: 2 });
  });
  it("caps a long field and flags it", () => {
    expect(resolveTripLength({ field: "20 days" })).toEqual({ days: 14, capped: true, dateSpanDays: null });
    expect(resolveTripLength({ field: "14 days" }).capped).toBe(false);
  });
  it("falls back to context, then 4, clamped", () => {
    expect(resolveTripLength({ field: "soon", contextDays: 7 }).days).toBe(7);
    expect(resolveTripLength({ field: "" }).days).toBe(4);
    expect(resolveTripLength({ field: "", contextDays: 99 }).days).toBe(14);
    expect(resolveTripLength({ field: "", contextDays: 0 }).days).toBe(1);
  });
  it("nights convert to days", () => {
    expect(resolveTripLength({ field: "3 nights" }).days).toBe(4);
  });
  it("dateSpanDays is null for absent or invalid dates", () => {
    expect(resolveTripLength({ field: "3 days", startDate: "2026-02-30", endDate: "2026-03-02" }).dateSpanDays).toBeNull();
    expect(resolveTripLength({ field: "3 days", startDate: "2026-03-05", endDate: "2026-03-01" }).dateSpanDays).toBeNull();
    expect(resolveTripLength({ field: "3 days", startDate: "2026-03-01" }).dateSpanDays).toBeNull();
  });
});

describe("dateSpanNotice examples", () => {
  it("is null for null span or equal length", () => {
    expect(dateSpanNotice(null, 4)).toBeNull();
    expect(dateSpanNotice(4, 4)).toBeNull();
  });
  it("mentions both numbers and avoids trust-claim words", () => {
    for (const [s, t] of [[2, 4], [6, 4], [1, 3]] as const) {
      const text = dateSpanNotice(s, t) as string;
      expect(text).toContain(String(s));
      expect(text).toContain(String(t));
      expect(text).not.toMatch(/confirmed|bookable|guaranteed/i);
    }
  });
});
