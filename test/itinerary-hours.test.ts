import { describe, it, expect } from "vitest";
import {
  weekdayOf,
  addDays,
  periodsFor,
  typicalWeekday,
  weekdayDescription,
  earliestStart,
} from "../lib/itinerary/hours";
import { legMinutes, legMinutesUp } from "../lib/itinerary/geo";
import type { PlaceHours } from "../lib/providers/google-places";

const pt = (day: number, hour: number, minute = 0) => ({ day, hour, minute });
const hours = (periods: PlaceHours["periods"], weekdayDescriptions: string[] = []): PlaceHours => ({
  periods,
  weekdayDescriptions,
});

describe("legMinutesUp", () => {
  const a = { lat: 0, lng: 0 };
  const b = { lat: 0.2, lng: 0.1 };
  it("rounds up and never goes below legMinutes", () => {
    expect(legMinutesUp(a, b)).toBeGreaterThanOrEqual(legMinutes(a, b));
    expect(Number.isInteger(legMinutesUp(a, b))).toBe(true);
  });
  it("is 0 for identical or non-finite points", () => {
    expect(legMinutesUp(a, a)).toBe(0);
    expect(legMinutesUp(a, { lat: NaN, lng: 0 })).toBe(0);
  });
  it("rounds a tiny leg up to 1", () => {
    expect(legMinutesUp(a, { lat: 0.0001, lng: 0 })).toBe(1);
  });
});

describe("weekdayOf / addDays", () => {
  it("uses 0 = Sunday", () => {
    expect(weekdayOf("2025-01-05")).toBe(0); // Sunday
    expect(weekdayOf("2025-01-06")).toBe(1); // Monday
    expect(weekdayOf("2025-01-11")).toBe(6); // Saturday
  });
  it("rejects bad dates", () => {
    expect(weekdayOf("2025-02-30")).toBeNull();
    expect(weekdayOf("2025-1-5")).toBeNull();
    expect(weekdayOf("")).toBeNull();
    expect(addDays("nope", 1)).toBeNull();
    expect(addDays("2025-01-05", 1.5)).toBeNull();
  });
  it("adds days across month and year ends and leap days", () => {
    expect(addDays("2025-12-31", 1)).toBe("2026-01-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2025-03-01", -1)).toBe("2025-02-28");
    expect(addDays("2025-01-05", 0)).toBe("2025-01-05");
  });
  it("day N weekday is start weekday plus N-1", () => {
    const d = addDays("2025-01-05", 2) as string;
    expect(weekdayOf(d)).toBe(2);
  });
});

describe("periodsFor", () => {
  it("returns same-day periods, sorted and merged", () => {
    const h = hours([
      { open: pt(1, 14), close: pt(1, 18) },
      { open: pt(1, 9), close: pt(1, 12) },
      { open: pt(1, 11), close: pt(1, 13) },
      { open: pt(2, 9), close: pt(2, 10) },
    ]);
    expect(periodsFor(h, 1)).toEqual([[540, 780], [840, 1080]]);
    expect(periodsFor(h, 2)).toEqual([[540, 600]]);
    expect(periodsFor(h, 3)).toEqual([]);
  });
  it("keeps a midnight-crossing period on the opening weekday only", () => {
    const h = hours([{ open: pt(5, 18), close: pt(6, 2) }]); // Fri 18:00 to Sat 02:00
    expect(periodsFor(h, 5)).toEqual([[1080, 1440]]);
    expect(periodsFor(h, 6)).toEqual([]);
  });
  it("handles Saturday to Sunday wrap and close before open", () => {
    const h = hours([{ open: pt(6, 22), close: pt(0, 1) }]);
    expect(periodsFor(h, 6)).toEqual([[1320, 1440]]);
    expect(periodsFor(h, 0)).toEqual([]);
    const same = hours([{ open: pt(2, 20), close: pt(2, 3) }]);
    expect(periodsFor(same, 2)).toEqual([[1200, 1440]]);
  });
  it("treats no close as all day (24 hours)", () => {
    const h = hours([{ open: pt(0, 0) }]);
    expect(periodsFor(h, 0)).toEqual([[0, 1440]]);
  });
  it("treats 00:00 to 00:00 as all day", () => {
    expect(periodsFor(hours([{ open: pt(3, 0), close: pt(4, 0) }]), 3)).toEqual([[0, 1440]]);
    expect(periodsFor(hours([{ open: pt(3, 0), close: pt(3, 0) }]), 3)).toEqual([[0, 1440]]);
  });
  it("merges touching periods and ignores invalid ones", () => {
    const h = hours([
      { open: pt(1, 9), close: pt(1, 12) },
      { open: pt(1, 12), close: pt(1, 15) },
      { open: { day: 1, hour: 25, minute: 0 }, close: pt(1, 10) },
      { open: pt(1, 8), close: { day: 1, hour: 9, minute: 61 } },
    ]);
    expect(periodsFor(h, 1)).toEqual([[540, 900]]);
  });
  it("is total on bad input", () => {
    expect(periodsFor(hours([]), 9)).toEqual([]);
    expect(periodsFor(null as unknown as PlaceHours, 1)).toEqual([]);
  });
});

describe("typicalWeekday", () => {
  const day = (d: number, s: number, e: number) => ({ open: pt(d, s), close: pt(d, e) });
  it("picks the most shared interval list, ties to the earliest Monday-first weekday", () => {
    // Mon..Fri 9-17 (5 days), Sat 10-14, Sun 10-14 -> Monday
    const h = hours([1, 2, 3, 4, 5].map((d) => day(d, 9, 17)).concat([day(6, 10, 14), day(0, 10, 14)]));
    expect(typicalWeekday(h)).toBe(1);
  });
  it("breaks a tie toward the earliest weekday, with Sunday last", () => {
    // Sun and Sat share 10-14 (2), Tue and Wed share 9-17 (2): Tuesday wins (earlier in Monday-first order)
    const h = hours([day(0, 10, 14), day(6, 10, 14), day(2, 9, 17), day(3, 9, 17)]);
    expect(typicalWeekday(h)).toBe(2);
    // Sunday vs Saturday only, each with a different list: Saturday is earlier
    expect(typicalWeekday(hours([day(0, 9, 12), day(6, 9, 13)]))).toBe(6);
  });
  it("picks the majority even when it falls late in the week", () => {
    const h = hours([day(1, 8, 9), day(5, 9, 17), day(6, 9, 17), day(0, 9, 17)]);
    expect(typicalWeekday(h)).toBe(5);
  });
  it("does not choose a closed weekday", () => {
    expect(typicalWeekday(hours([day(6, 9, 12)]))).toBe(6);
  });
  it("is null with no periods", () => {
    expect(typicalWeekday(hours([]))).toBeNull();
    expect(typicalWeekday(null as unknown as PlaceHours)).toBeNull();
  });
  it("handles a 24-hour place", () => {
    const h = hours([0, 1, 2, 3, 4, 5, 6].map((d) => ({ open: pt(d, 0) })));
    expect(typicalWeekday(h)).toBe(1);
  });
});

describe("weekdayDescription", () => {
  const descs = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((n) => `${n}: 9:00 AM - 5:00 PM`);
  const h = hours([], descs);
  it("maps weekday 0 (Sunday) to the last Google string and Monday to the first", () => {
    expect(weekdayDescription(h, 0)).toBe(descs[6]);
    expect(weekdayDescription(h, 1)).toBe(descs[0]);
    expect(weekdayDescription(h, 6)).toBe(descs[5]);
  });
  it("is null when absent or the weekday is invalid", () => {
    expect(weekdayDescription(hours([]), 1)).toBeNull();
    expect(weekdayDescription(hours([], ["x"]), 3)).toBeNull();
    expect(weekdayDescription(h, 7)).toBeNull();
  });
});

describe("earliestStart", () => {
  it("returns the window open when notBefore is earlier", () => {
    expect(earliestStart([[540, 1080]], 0, 60)).toBe(540);
  });
  it("returns notBefore when inside the window", () => {
    expect(earliestStart([[540, 1080]], 600, 60)).toBe(600);
  });
  it("accepts a visit that ends exactly at the window end", () => {
    expect(earliestStart([[540, 600]], 0, 60)).toBe(540);
    expect(earliestStart([[540, 600]], 541, 60)).toBeNull();
  });
  it("skips a window that is too short and uses the next", () => {
    expect(earliestStart([[540, 580], [840, 1080]], 0, 60)).toBe(840);
  });
  it("sorts unsorted windows and rounds notBefore up", () => {
    expect(earliestStart([[840, 1080], [540, 700]], 599.2, 60)).toBe(600);
  });
  it("is null for no windows or bad input", () => {
    expect(earliestStart([], 0, 30)).toBeNull();
    expect(earliestStart([[0, 1440]], NaN, 30)).toBeNull();
    expect(earliestStart([[0, 1440]], 0, -1)).toBeNull();
  });
});
