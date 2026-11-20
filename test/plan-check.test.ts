import { describe, it, expect } from "vitest";
import { applyPlan, checkPlan, textViolation, type PlanContext } from "../lib/itinerary/plan-check";
import { dayLimits } from "../lib/itinerary/pace";
import { fitSequence, type DaySpec } from "../lib/itinerary/scheduler";
import type { PlaceCandidate } from "../lib/providers/google-places";

function cand(id: string, name: string, o: Partial<PlaceCandidate> = {}): PlaceCandidate {
  return {
    placeId: id,
    name,
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

function spec(n: number): DaySpec {
  return { day: n, date: null, weekday: null, limits: dayLimits("balanced", n, 2), earliestMin: 540 };
}

const A1 = cand("a1", "Alpha Fort");
const A2 = cand("a2", "Beta Garden");
const B1 = cand("b1", "Gamma Museum");
const B2 = cand("b2", "Delta Bridge");

function ctx(o: Partial<PlanContext> = {}): PlanContext {
  return {
    days: [
      { spec: spec(1), deterministicCount: 2 },
      { spec: spec(2), deterministicCount: 2 },
    ],
    sent: [A1, A2, B1, B2],
    dates: ["2025-01-06", "2025-01-07"],
    ...o,
  };
}

function good() {
  return {
    days: [
      {
        day: 1,
        startTime: "09:30",
        title: "Old Town walk",
        stops: [
          { placeId: "a1", sentence: "Start with the old walls." },
          { placeId: "a2", sentence: "Then a quiet green space." },
        ],
      },
      {
        day: 2,
        startTime: "10:00",
        title: "Quiet morning",
        stops: [
          { placeId: "b1", sentence: "A calm gallery." },
          { placeId: "b2", sentence: "Worth a look." },
        ],
      },
    ],
  };
}

const reason = (raw: unknown, c = ctx()) => {
  const v = checkPlan(c, raw);
  return v.ok ? "ok" : v.reason;
};

describe("checkPlan", () => {
  it("accepts a valid plan", () => {
    const v = checkPlan(ctx(), good());
    expect(v.ok).toBe(true);
  });

  it("rejects bad shapes and extra fields", () => {
    expect(reason(null)).toBe("shape");
    expect(reason({ days: "x" })).toBe("shape");
    expect(reason({ ...good(), note: 1 })).toBe("fields");
    const a = good();
    (a.days[0].stops[0] as Record<string, unknown>).name = "Alpha Fort";
    expect(reason(a)).toBe("fields");
    const b = good();
    (b.days[0] as Record<string, unknown>).rating = 5;
    expect(reason(b)).toBe("fields");
    const c = good();
    (c.days[0] as Record<string, unknown>).day = 1.5;
    expect(reason(c)).toBe("shape");
    const d = good();
    delete (d.days[0] as Record<string, unknown>).startTime;
    expect(reason(d)).toBe("shape");
  });

  it("rejects a wrong day count or day set", () => {
    const a = good();
    a.days.pop();
    expect(reason(a)).toBe("days");
    const b = good();
    b.days[1].day = 3;
    expect(reason(b)).toBe("days");
    const c = good();
    c.days[1].day = 1;
    expect(reason(c)).toBe("days");
  });

  it("rejects unknown and duplicate ids and reports only sent ids", () => {
    const unknown = good();
    unknown.days[1].stops[1].placeId = "zz";
    const u = checkPlan(ctx(), unknown);
    expect(u).toMatchObject({ ok: false, reason: "ids", days: [2], placeIds: [] });

    const dup = good();
    dup.days[1].stops[1].placeId = "a1";
    const d = checkPlan(ctx(), dup);
    expect(d).toMatchObject({ ok: false, reason: "ids", days: [2], placeIds: ["a1"] });
  });

  it("rejects stop counts outside the pace limits", () => {
    const tooMany = good();
    tooMany.days[0].stops.push({ placeId: "b1", sentence: "Extra stop." });
    tooMany.days[1].stops.shift();
    expect(reason(tooMany)).toBe("pace");
    const none = good();
    none.days[0].stops = [];
    expect(checkPlan(ctx(), none)).toMatchObject({ ok: false, reason: "pace", days: [1] });
  });

  it("allows an empty day when the deterministic day is empty", () => {
    const c = ctx({
      days: [
        { spec: spec(1), deterministicCount: 0 },
        { spec: spec(2), deterministicCount: 2 },
      ],
    });
    const p = good();
    p.days[0].stops = [];
    p.days[0].title = "Free day";
    expect(reason(p, c)).toBe("ok");
  });

  it("rejects bad start times", () => {
    for (const t of ["9:30", "25:00", "08:00", "20:00", "soon", "09:60"]) {
      const p = good();
      p.days[0].startTime = t;
      expect(reason(p), t).toBe("start");
    }
  });

  it("rejects an infeasible schedule", () => {
    const far = cand("b2", "Delta Bridge", { location: { lat: 5, lng: 0 } });
    const c = ctx({ sent: [A1, A2, B1, far] });
    const v = checkPlan(c, good());
    expect(v).toMatchObject({ ok: false, reason: "feasibility", days: [2] });
    if (!v.ok) expect(v.placeIds.sort()).toEqual(["b1", "b2"]);
  });

  it("rejects a stop that is closed on the scheduled weekday", () => {
    const closed = cand("a1", "Alpha Fort", {
      hours: { periods: [], weekdayDescriptions: [] },
    });
    const dated = (n: number): DaySpec => ({ ...spec(n), date: "2025-01-06", weekday: 1 });
    const c = ctx({
      days: [
        { spec: dated(1), deterministicCount: 2 },
        { spec: spec(2), deterministicCount: 2 },
      ],
      sent: [closed, A2, B1, B2],
    });
    expect(reason(good(), c)).toBe("feasibility");
  });

  it("rejects forbidden text in titles and sentences", () => {
    const bad = [
      "Tickets cost 5 dollars.",
      "About $5 entry.",
      "Entry is €5.",
      "Rs 100 only.",
      "Costs little.",
      "A cheap stop.",
      "Open at 10:30 today.",
      "Opens at 9 am.",
      "Booking is confirmed.",
      "This is bookable online.",
      "See https://example.com now.",
      "See www.example.org now.",
      "Free entry for all.",
      "One fee applies.",
      "Two sentences. Right here.",
      "",
      "x".repeat(161),
    ];
    for (const s of bad) {
      const p = good();
      p.days[0].stops[0].sentence = s;
      expect(reason(p), s).toBe("text");
    }
    for (const t of ["Price walk", "Visit at 3pm", "", "y".repeat(81), "Bookable day"]) {
      const p = good();
      p.days[0].title = t;
      expect(reason(p), t).toBe("text");
    }
  });

  it("rejects a sentence that names a different place", () => {
    const p = good();
    p.days[0].stops[0].sentence = "Better than Beta Garden nearby.";
    const v = checkPlan(ctx(), p);
    expect(v).toMatchObject({ ok: false, reason: "text", days: [1], placeIds: ["a1"] });
  });

  it("allows a sentence that names its own place", () => {
    const p = good();
    p.days[0].stops[0].sentence = "Alpha Fort has old walls.";
    expect(reason(p)).toBe("ok");
  });

  it("rejects a title that names an unscheduled place but not a scheduled one", () => {
    const a = good();
    a.days[0].title = "Gamma Museum day";
    expect(reason(a)).toBe("text");
    const b = good();
    b.days[0].title = "Alpha Fort day";
    expect(reason(b)).toBe("ok");
  });

  it("replaces duplicate titles with a fallback title", () => {
    const p = good();
    p.days[1].title = "Old Town walk";
    const v = checkPlan(ctx(), p);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.days[0].title).toBe("Old Town walk");
      expect(v.days[1].title).not.toBe("Old Town walk");
      expect(v.days[1].title.length).toBeGreaterThan(0);
    }
  });

  it("never throws on odd input", () => {
    for (const raw of [undefined, 5, "x", [], { days: [null] }, { days: [{ day: 1, stops: null }] }]) {
      expect(() => checkPlan(ctx(), raw)).not.toThrow();
      expect(checkPlan(ctx(), raw).ok).toBe(false);
    }
    expect(() => checkPlan(null as unknown as PlanContext, good())).not.toThrow();
    expect(checkPlan(null as unknown as PlanContext, good()).ok).toBe(false);
  });
});

describe("applyPlan", () => {
  it("recomputes times with fitSequence and takes data from the sent candidates", () => {
    const p = good();
    p.days[0].startTime = "11:00";
    const c = ctx();
    const v = checkPlan(c, p);
    if (!v.ok) throw new Error(`expected acceptance, got ${v.reason}`);
    const applied = applyPlan(c, v);
    const day1 = applied.days[0];
    const expected = fitSequence({ ...spec(1), earliestMin: 660 }, [A1, A2]);
    expect(expected).not.toBeNull();
    expect(day1.stops.map((s) => s.scheduled)).toEqual(expected);
    expect(day1.stops[0].scheduled!.startMin).toBeGreaterThanOrEqual(660);
    expect(day1.stops[0].candidate).toBe(A1);
    expect(day1.stops[1].candidate).toBe(A2);
    expect(day1.stops[0].sentence).toBe("Start with the old walls.");
  });
});

describe("textViolation", () => {
  it("flags forbidden content and length", () => {
    expect(textViolation("A calm gallery.", 160)).toBe(false);
    expect(textViolation("  ", 160)).toBe(true);
    expect(textViolation("abc", 2)).toBe(true);
    expect(textViolation("Inexpensive treat", 160)).toBe(true);
    expect(textViolation("Free admission", 160)).toBe(true);
    expect(textViolation("Costs 20 INR", 160)).toBe(true);
  });
});
