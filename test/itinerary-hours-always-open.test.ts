import { describe, expect, it } from "vitest";
import { periodsFor, typicalWeekday } from "@/lib/itinerary/hours";
import type { PlaceHours } from "@/lib/providers/google-places";

// Google documents "always open" as ONE period: open day 0 at 00:00 and no close.
const ALWAYS: PlaceHours = { periods: [{ open: { day: 0, hour: 0, minute: 0 } }], weekdayDescriptions: [] };

describe("periodsFor, Google's 24/7 format", () => {
  it("is open all day on every weekday, not only Sunday", () => {
    for (let wd = 0; wd <= 6; wd++) expect(periodsFor(ALWAYS, wd)).toEqual([[0, 1440]]);
  });
  it("picks Monday as the typical weekday", () => {
    expect(typicalWeekday(ALWAYS)).toBe(1);
  });
  it("does not widen a single non-midnight or non-Sunday no-close period", () => {
    const sat: PlaceHours = { periods: [{ open: { day: 6, hour: 0, minute: 0 } }], weekdayDescriptions: [] };
    expect(periodsFor(sat, 2)).toEqual([]);
    const lateSun: PlaceHours = { periods: [{ open: { day: 0, hour: 9, minute: 0 } }], weekdayDescriptions: [] };
    expect(periodsFor(lateSun, 3)).toEqual([]);
  });
  it("does not widen when there is more than one period", () => {
    const two: PlaceHours = {
      periods: [{ open: { day: 0, hour: 0, minute: 0 } }, { open: { day: 1, hour: 9, minute: 0 }, close: { day: 1, hour: 17, minute: 0 } }],
      weekdayDescriptions: [],
    };
    expect(periodsFor(two, 3)).toEqual([]);
  });
});
