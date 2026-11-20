import { describe, it, expect } from "vitest";
import { applyPolish, checkPolish, type PolishContext } from "../lib/itinerary/polish-check";
import type { DaySpec } from "../lib/itinerary/scheduler";
import { dayLimits } from "../lib/itinerary/pace";
import type { PlaceCandidate } from "../lib/providers/google-places";

function cand(id: string, o: Partial<PlaceCandidate> = {}): PlaceCandidate {
  return {
    placeId: id,
    name: id,
    address: "1 Road, Old Town, France",
    location: { lat: 0.001 * id.charCodeAt(id.length - 1), lng: 0 },
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

function spec(n: number, total = 2): DaySpec {
  return { day: n, date: null, weekday: null, limits: dayLimits("balanced", n, total), earliestMin: 540 };
}

function ctx(o: Partial<PolishContext> = {}): PolishContext {
  return {
    days: [
      { spec: spec(1), stops: [cand("a1"), cand("a2")] },
      { spec: spec(2), stops: [cand("b1"), cand("b2")] },
    ],
    dates: ["2025-01-06", "2025-01-07"],
    ...o,
  };
}

function good() {
  return {
    days: [
      { day: 1, title: "Old Town walk", stops: [{ placeId: "a2", sentence: "Start here." }, { placeId: "a1", sentence: "Then this." }] },
      { day: 2, title: "Quiet morning", stops: [{ placeId: "b1", sentence: "A calm place." }, { placeId: "b2", sentence: "Worth a look." }] },
    ],
  };
}

const reason = (raw: unknown, c = ctx()) => {
  const v = checkPolish(c, raw);
  return v.ok ? "ok" : v.reason;
};

describe("checkPolish", () => {
  it("accepts a valid output", () => {
    expect(reason(good())).toBe("ok");
  });

  it("rejects bad shapes and extra fields", () => {
    expect(reason(null)).toBe("shape");
    expect(reason({ days: "x" })).toBe("shape");
    expect(reason({ ...good(), note: 1 })).toBe("fields");
    const a = good();
    (a.days[0] as Record<string, unknown>).theme = "x";
    expect(reason(a)).toBe("fields");
    const b = good();
    (b.days[0].stops[0] as Record<string, unknown>).startMin = 600;
    expect(reason(b)).toBe("fields");
  });

  it("rejects a different day count", () => {
    const a = good();
    a.days.pop();
    expect(reason(a)).toBe("days");
    const b = good();
    b.days[1].day = 3;
    expect(reason(b)).toBe("days");
  });

  it("rejects added, removed, duplicated and unknown ids", () => {
    const removed = good();
    removed.days[1].stops.pop();
    expect(reason(removed)).toBe("ids");
    const unknown = good();
    unknown.days[1].stops[1].placeId = "zz";
    expect(reason(unknown)).toBe("ids");
    const dup = good();
    dup.days[1].stops[1].placeId = "b1";
    expect(reason(dup)).toBe("ids");
  });

  it("rejects a day that is not feasible", () => {
    const far = cand("b2", { location: { lat: 5, lng: 5 } });
    const c = ctx({ days: [ctx().days[0], { spec: spec(2), stops: [cand("b1"), far] }] });
    expect(reason(good(), c)).toBe("feasibility");
    const closed = cand("a1", {
      hours: {
        periods: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
          open: { day: d, hour: 20, minute: 0 },
          close: { day: d, hour: 22, minute: 0 },
        })),
        weekdayDescriptions: [],
      },
    });
    const c2 = ctx({ days: [{ spec: spec(1), stops: [closed, cand("a2")] }, ctx().days[1]] });
    expect(reason(good(), c2)).toBe("feasibility");
  });

  it("rejects too many stops for the pace", () => {
    const stops = ["c1", "c2", "c3", "c4", "c5", "c6"].map((id) => cand(id));
    const c: PolishContext = { days: [{ spec: spec(1, 3), stops }], dates: [null] };
    const out = { days: [{ day: 1, title: "All", stops: stops.map((s) => ({ placeId: s.placeId, sentence: "ok" })) }] };
    expect(reason(out, c)).toBe("feasibility");
  });

  it.each([
    ["empty title", (a: ReturnType<typeof good>) => (a.days[0].title = "   ")],
    ["long title", (a: ReturnType<typeof good>) => (a.days[0].title = "x".repeat(81))],
    ["long sentence", (a: ReturnType<typeof good>) => (a.days[0].stops[0].sentence = "x".repeat(161))],
    ["rupee", (a: ReturnType<typeof good>) => (a.days[0].stops[0].sentence = "Entry ₹50.")],
    ["dollar", (a: ReturnType<typeof good>) => (a.days[0].stops[0].sentence = "Only $5.")],
    ["code", (a: ReturnType<typeof good>) => (a.days[0].stops[0].sentence = "Costs 5 eur")],
    ["Rs", (a: ReturnType<typeof good>) => (a.days[0].stops[0].sentence = "Rs. 40 entry")],
    ["colon time", (a: ReturnType<typeof good>) => (a.days[0].stops[0].sentence = "Open at 9:30.")],
    ["pm time", (a: ReturnType<typeof good>) => (a.days[0].stops[0].sentence = "Go at 5 PM.")],
    ["confirmed", (a: ReturnType<typeof good>) => (a.days[0].title = "Confirmed visit")],
    ["bookable", (a: ReturnType<typeof good>) => (a.days[1].stops[0].sentence = "BOOKABLE online")],
  ])("rejects text: %s", (_n, mutate) => {
    const a = good();
    mutate(a);
    expect(reason(a)).toBe("text");
  });

  it("replaces a duplicate title only", () => {
    const a = good();
    a.days[1].title = "old town WALK";
    const v = checkPolish(ctx(), a);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.days[0].title).toBe("Old Town walk");
    expect(v.days[1].title).toBe("Old Town day");
    expect(v.days[1].stops).toEqual(a.days[1].stops);
  });

  it("allows arrival wording only on the flight date", () => {
    const a = good();
    a.days[0].title = "Arrival Day in Paris";
    const on = checkPolish(ctx({ flightDate: "2025-01-06" }), a);
    expect(on.ok && on.days[0].title).toBe("Arrival Day in Paris");
    const off = checkPolish(ctx({ flightDate: "2025-01-07" }), a);
    expect(off.ok && off.days[0].title).toBe("Old Town day");
    const none = checkPolish(ctx(), a);
    expect(none.ok && none.days[0].title).toBe("Old Town day");
    const b = good();
    b.days[1].title = "Departure day";
    const dep = checkPolish(ctx({ flightDate: "2025-01-06" }), b);
    expect(dep.ok && dep.days[1].title).not.toMatch(/departure/i);
  });

  it("falls back to Day n when there is no area", () => {
    const c = ctx({
      days: [
        { spec: spec(1), stops: [cand("a1", { address: "" }), cand("a2")] },
        { spec: spec(2), stops: [cand("b1", { address: "" }), cand("b2")] },
      ],
    });
    const a = good();
    a.days[0].title = "Same";
    a.days[1].title = "same";
    a.days[1].stops = [{ placeId: "b1", sentence: "x" }, { placeId: "b2", sentence: "y" }];
    const v = checkPolish(c, a);
    expect(v.ok && v.days[1].title).toBe("Day 2");
  });
});

describe("applyPolish", () => {
  it("uses pre-polish records, new order, sentences and recomputed times", () => {
    const c = ctx();
    const v = checkPolish(c, good());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const applied = applyPolish(c, v);
    const d1 = applied.days[0];
    expect(d1.stops.map((s) => s.candidate.placeId)).toEqual(["a2", "a1"]);
    expect(d1.stops[0].candidate).toBe(c.days[0].stops[1]);
    expect(d1.stops[0].sentence).toBe("Start here.");
    expect(d1.stops[0].scheduled?.startMin).toBe(540);
    expect(d1.stops[1].scheduled!.startMin).toBeGreaterThanOrEqual(d1.stops[0].scheduled!.endMin);
    expect(d1.title).toBe("Old Town walk");
  });
});
