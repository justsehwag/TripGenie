import { describe, it, expect } from "vitest";
import {
  fitSequence,
  mealKind,
  parseArrivalMin,
  scheduleBatch,
  visitMinutes,
  type DaySpec,
} from "../lib/itinerary/scheduler";
import { dayLimits } from "../lib/itinerary/pace";
import type { PlaceCandidate, PlaceHours } from "../lib/providers/google-places";

const pt = (day: number, hour: number, minute = 0) => ({ day, hour, minute });
const MON = 1;
const DATE_MON = "2025-01-06";

function hoursAll(open: [number, number], close: [number, number], text = "Monday: x"): PlaceHours {
  const periods = [0, 1, 2, 3, 4, 5, 6].map((d) => ({
    open: pt(d, open[0], open[1]),
    close: pt(d, close[0], close[1]),
  }));
  return { periods, weekdayDescriptions: [text, "", "", "", "", "", ""] };
}

function cand(id: string, o: Partial<PlaceCandidate> = {}): PlaceCandidate {
  return {
    placeId: id,
    name: id,
    address: "Somewhere",
    location: { lat: 0.001 * (id.length + id.charCodeAt(id.length - 1) % 7), lng: 0 },
    rating: 4,
    userRatingCount: 100,
    hours: null,
    utcOffsetMinutes: null,
    types: [],
    primaryType: "tourist_attraction",
    businessStatus: "OPERATIONAL",
    googleMapsUri: null,
    photos: [],
    ...o,
  };
}

function day(n: number, o: Partial<DaySpec> = {}, total = 3, pace = "balanced"): DaySpec {
  return {
    day: n,
    date: null,
    weekday: null,
    limits: dayLimits(pace, n, total),
    earliestMin: 540,
    ...o,
  };
}

describe("visitMinutes, mealKind, parseArrivalMin", () => {
  it("uses the table by primary type, then by type, else 60", () => {
    expect(visitMinutes(cand("a", { primaryType: "museum" }))).toBe(90);
    expect(visitMinutes(cand("a", { primaryType: null, types: ["x", "beach"] }))).toBe(120);
    expect(visitMinutes(cand("a", { primaryType: "weird", types: [] }))).toBe(60);
    expect(visitMinutes(cand("a", { primaryType: "constructor" }))).toBe(60);
  });
  it("detects restaurants by primary type only", () => {
    expect(mealKind(cand("a", { primaryType: "restaurant" }))).toBe(true);
    expect(mealKind(cand("a", { primaryType: "museum", types: ["restaurant"] }))).toBe(false);
  });
  it("parses arrival times", () => {
    expect(parseArrivalMin("14:30")).toBe(870);
    expect(parseArrivalMin("2025-01-06 09:05")).toBe(545);
    expect(parseArrivalMin("2025-01-06T23:59:00")).toBe(1439);
    expect(parseArrivalMin("25:00")).toBeNull();
    expect(parseArrivalMin("soon")).toBeNull();
    expect(parseArrivalMin(undefined)).toBeNull();
  });
});

describe("fitSequence", () => {
  it("starts at the opening time inside the weekday period", () => {
    const c = cand("a", { hours: hoursAll([11, 0], [18, 0], "Monday: 11:00 AM - 6:00 PM") });
    const r = fitSequence(day(2, { date: DATE_MON, weekday: MON }), [c])!;
    expect(r[0].startMin).toBe(660);
    expect(r[0].endMin).toBe(660 + 90);
    expect(r[0].hoursLabel).toBeNull();
    expect(r[0].hoursText).toBe("Monday: 11:00 AM - 6:00 PM");
  });

  it("rejects a place closed on that weekday", () => {
    const h: PlaceHours = { periods: [{ open: pt(2, 9), close: pt(2, 17) }], weekdayDescriptions: [] };
    expect(fitSequence(day(2, { date: DATE_MON, weekday: MON }), [cand("a", { hours: h })])).toBeNull();
    expect(fitSequence(day(2, { date: "2025-01-07", weekday: 2 }), [cand("a", { hours: h })])).not.toBeNull();
  });

  it("rejects a visit longer than the opening period", () => {
    const h = hoursAll([10, 0], [11, 0]);
    expect(fitSequence(day(2, { weekday: MON }), [cand("a", { hours: h })])).toBeNull();
  });

  it("treats a midnight-crossing period as belonging to the opening weekday", () => {
    const h: PlaceHours = { periods: [{ open: pt(1, 18), close: pt(2, 2) }], weekdayDescriptions: [] };
    const c = cand("a", { hours: h, primaryType: "bar" });
    const r = fitSequence(day(2, { weekday: MON }), [c])!;
    expect(r[0].startMin).toBe(18 * 60);
    expect(r[0].endMin).toBeLessThanOrEqual(1200); // day window
    expect(fitSequence(day(2, { weekday: 2 }), [c])).toBeNull();
  });

  it("treats a period with no close as open all day", () => {
    const h: PlaceHours = { periods: [{ open: pt(0, 0) }], weekdayDescriptions: [] };
    expect(fitSequence(day(2, { weekday: 0 }), [cand("a", { hours: h })])![0].startMin).toBe(540);
  });

  it("labels no-hours places and keeps them inside 09:00 to 18:00", () => {
    const r = fitSequence(day(2), [cand("a"), cand("b"), cand("c"), cand("d")])!;
    for (const s of r) {
      expect(s.hoursLabel).toBe("Hours not listed");
      expect(s.hoursText).toBeNull();
      expect(s.startMin).toBeGreaterThanOrEqual(540);
      expect(s.endMin).toBeLessThanOrEqual(1080);
    }
    // 6 x 90 minutes cannot fit in 09:00 to 18:00 (540 minutes) with travel.
    const many = ["a", "b", "c", "d", "e", "f", "g"].map((id) => cand(id + id));
    expect(fitSequence(day(2), many)).toBeNull();
  });

  it("labels typical hours without a date and uses the typical weekday", () => {
    const h = hoursAll([10, 0], [16, 0], "Monday: 10:00 AM - 4:00 PM");
    const r = fitSequence(day(2), [cand("a", { hours: h })])!;
    expect(r[0].hoursLabel).toBe("Typical hours");
    expect(r[0].startMin).toBe(600);
    // All weekdays tie, so Monday is typical; its description is index 0.
    expect(r[0].hoursText).toBe("Monday: 10:00 AM - 4:00 PM");
  });

  it("chains stops after the previous end plus rounded-up travel", () => {
    const a = cand("a");
    const b = cand("b", { location: { lat: 0.05, lng: 0 } });
    const r = fitSequence(day(2), [a, b])!;
    expect(r[0].travelToNextMin).toBeGreaterThan(0);
    expect(r[1].startMin).toBeGreaterThanOrEqual(r[0].endMin + (r[0].travelToNextMin ?? 0));
    expect(r[1].travelToNextMin).toBeUndefined();
  });

  it("rejects a leg over the leg limit", () => {
    const a = cand("a");
    const b = cand("b", { location: { lat: 1.2, lng: 0 } }); // ~133 km, ~320 min
    expect(fitSequence(day(2), [a, b])).toBeNull();
  });

  it("rejects when the daily travel sum exceeds the limit", () => {
    // Each leg about 80 min: three legs = 240 > 180.
    const pts = [0, 0.3, 0.6, 0.9].map((lat, i) => cand("p" + i, { location: { lat, lng: 0 }, primaryType: "park" }));
    expect(fitSequence(day(2, { earliestMin: 540 }), pts)).toBeNull();
  });

  it("respects the day-1 arrival time", () => {
    const r = fitSequence(day(1, { earliestMin: 14 * 60 + 30 }, 3), [cand("a")])!;
    expect(r[0].startMin).toBe(14 * 60 + 30);
    expect(fitSequence(day(1, { earliestMin: 19 * 60 }, 3), [cand("a")])).toBeNull();
  });

  it("puts restaurants only in meal windows", () => {
    const r = fitSequence(day(2), [cand("r1", { primaryType: "restaurant" })])!;
    expect(r[0].startMin).toBe(12 * 60);
    const onlyMorning = cand("r2", { primaryType: "restaurant", hours: hoursAll([9, 0], [11, 30]) });
    expect(fitSequence(day(2, { weekday: MON }), [onlyMorning])).toBeNull();
  });

  it("uses lunch then dinner and refuses a third meal", () => {
    const rs = ["r1", "r2", "r3"].map((id) =>
      cand(id, { primaryType: "restaurant", hours: hoursAll([10, 0], [23, 0]) }),
    );
    const two = fitSequence(day(2), rs.slice(0, 2))!;
    expect(two[0].startMin).toBe(720);
    expect(two[1].startMin).toBeGreaterThanOrEqual(1080);
    expect(two[1].endMin).toBeLessThanOrEqual(1200);
    expect(fitSequence(day(2), rs)).toBeNull();
  });

  it("rejects stops with different UTC offsets", () => {
    const a = cand("a", { utcOffsetMinutes: 60 });
    const b = cand("b", { utcOffsetMinutes: 120 });
    expect(fitSequence(day(2), [a, b])).toBeNull();
    expect(fitSequence(day(2), [a, cand("c", { utcOffsetMinutes: null })])).not.toBeNull();
  });

  it("is total on an empty list", () => {
    expect(fitSequence(day(2), [])).toEqual([]);
  });
});

describe("scheduleBatch", () => {
  const sights = (n: number, o: Partial<PlaceCandidate> = {}) =>
    Array.from({ length: n }, (_, i) =>
      cand("s" + String(i).padStart(2, "0"), {
        rating: 5 - i * 0.1,
        location: { lat: 0.002 * i, lng: 0 },
        ...o,
      }),
    );

  const days3 = (pace = "balanced") => [1, 2, 3].map((n) => day(n, {}, 3, pace));

  it("respects the pace limits for every day", () => {
    for (const pace of ["relaxed", "balanced", "packed"] as const) {
      const r = scheduleBatch({ days: days3(pace), pool: sights(30), interests: ["culture"], pace });
      for (const d of r.days) {
        const lim = dayLimits(pace, d.day, 3);
        expect(d.stops.length).toBeLessThanOrEqual(lim.max);
        expect(d.stops.length).toBeGreaterThanOrEqual(lim.min);
      }
    }
  });

  it("uses balanced for an unknown pace", () => {
    const r = scheduleBatch({
      days: days3(),
      pool: sights(30),
      interests: ["culture"],
      pace: "weird" as never,
    });
    expect(r.days[1].stops.length).toBe(4);
  });

  it("never schedules a place twice in the trip", () => {
    const r = scheduleBatch({ days: days3(), pool: sights(30), interests: undefined, pace: "balanced" });
    const ids = r.days.flatMap((d) => d.stops.map((s) => s.placeId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reports a day with 0 open candidates as empty and keeps a 1-stop day", () => {
    const none = scheduleBatch({ days: days3(), pool: [], interests: undefined, pace: "balanced" });
    expect(none.emptyDays).toEqual([1, 2, 3]);
    expect(none.shortDays).toEqual([]);

    const one = scheduleBatch({ days: [day(2)], pool: sights(1), interests: ["culture"], pace: "balanced" });
    expect(one.days[0].stops).toHaveLength(1);
    expect(one.shortDays).toEqual([2]);
    expect(one.emptyDays).toEqual([]);
  });

  it("leaves a day empty when every place is closed that weekday", () => {
    const closed: PlaceHours = { periods: [{ open: pt(2, 9), close: pt(2, 17) }], weekdayDescriptions: [] };
    const r = scheduleBatch({
      days: [day(2, { date: DATE_MON, weekday: MON })],
      pool: sights(5, { hours: closed }),
      interests: ["culture"],
      pace: "balanced",
    });
    expect(r.emptyDays).toEqual([2]);
  });

  it("every visit lies inside an opening period on its weekday", () => {
    const h = hoursAll([10, 0], [17, 0]);
    const r = scheduleBatch({
      days: [day(2, { date: DATE_MON, weekday: MON })],
      pool: sights(10, { hours: h }),
      interests: ["culture"],
      pace: "balanced",
    });
    expect(r.days[0].stops.length).toBeGreaterThan(0);
    for (const s of r.days[0].stops) {
      expect(s.startMin).toBeGreaterThanOrEqual(600);
      expect(s.endMin).toBeLessThanOrEqual(1020);
    }
  });

  it("starts nothing before the day-1 arrival time", () => {
    const r = scheduleBatch({
      days: [day(1, { earliestMin: 15 * 60 }, 3)],
      pool: sights(10),
      interests: ["culture"],
      pace: "balanced",
    });
    expect(r.days[0].stops.length).toBeGreaterThan(0);
    for (const s of r.days[0].stops) expect(s.startMin).toBeGreaterThanOrEqual(900);
  });

  it("places restaurants only inside meal windows and as many as the pace asks", () => {
    const rs = ["r1", "r2", "r3"].map((id, i) =>
      cand(id, {
        primaryType: "restaurant",
        hours: hoursAll([10, 0], [23, 0]),
        rating: 4.5 - i * 0.1,
        location: { lat: 0.001 * i, lng: 0 },
      }),
    );
    const r = scheduleBatch({
      days: [day(2, {}, 3)],
      pool: [...sights(8), ...rs],
      interests: ["food"],
      pace: "balanced",
    });
    const stops = r.days[0].stops;
    const meals = stops.filter((s) => s.placeId.startsWith("r"));
    expect(meals).toHaveLength(2);
    for (const m of meals) {
      const inLunch = m.startMin >= 720 && m.endMin <= 870;
      const inDinner = m.startMin >= 1080 && m.endMin <= 1200;
      expect(inLunch || inDinner).toBe(true);
    }
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i].startMin).toBeGreaterThanOrEqual(stops[i - 1].endMin);
    }
  });

  it("ranks by rating, then rating count, then placeId", () => {
    const pool = [
      cand("b", { rating: 4, userRatingCount: 10 }),
      cand("a", { rating: 4, userRatingCount: 10 }),
      cand("c", { rating: 4.8, userRatingCount: 1 }),
    ];
    const r = scheduleBatch({ days: [day(2, {}, 3, "relaxed")], pool, interests: undefined, pace: "relaxed" });
    expect(r.days[0].stops[0].placeId).toBe("c");
  });

  it("is deterministic", () => {
    const input = { days: days3(), pool: sights(30), interests: ["culture", "food"], pace: "balanced" as const };
    expect(scheduleBatch(input)).toEqual(scheduleBatch(input));
  });

  it("is total on garbage input", () => {
    expect(() => scheduleBatch(undefined as never)).not.toThrow();
    expect(scheduleBatch({ days: [], pool: [], interests: undefined, pace: "balanced" }).days).toEqual([]);
  });
});
