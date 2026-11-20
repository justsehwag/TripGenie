import { describe, expect, it, test } from "vitest";
import type { Activity, Itinerary } from "../types";
import { recomputeTotals } from "../itinerary-inr";
import {
  appendActivity,
  insertActivityAt,
  moveActivity,
  removeActivityAt,
  setActivityTime,
} from "./day-edit";

function act(title: string, cost: number, time = "09:00"): Activity {
  return { time, title, description: `${title} desc`, cost };
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

function make(): Itinerary {
  return {
    title: "Trip",
    totalCost: 600,
    days: [
      {
        day: 1,
        date: "",
        title: "D1",
        theme: "",
        activities: [act("A", 100), act("B", 200), act("C", 300)],
        total: 600,
      },
      { day: 2, date: "", title: "D2", theme: "", activities: [], total: 0 },
      { day: 3, date: "", title: "D3", theme: "", activities: [act("X", 50)], total: 50 },
    ],
  };
}

const titles = (it: Itinerary, day: number) =>
  it.days.find((d) => d.day === day)!.activities.map((a) => a.title);

function expectConsistent(out: Itinerary) {
  expect(out.revised).toBe(true);
  expect(out.totalCost).toBe(recomputeTotals(out).totalCost);
  for (const d of out.days) expect(d.total).toBe(d.activities.reduce((s, a) => s + a.cost, 0));
}

describe("removeActivityAt", () => {
  it("removes the last stop of a day and recomputes totals", () => {
    const it = make();
    const out = removeActivityAt(it, 1, 2);
    expect(titles(out, 1)).toEqual(["A", "B"]);
    expect(out.days[0].total).toBe(300);
    expect(out.totalCost).toBe(350);
    expectConsistent(out);
  });

  it("removes the only stop leaving an empty day", () => {
    const out = removeActivityAt(make(), 3, 0);
    expect(titles(out, 3)).toEqual([]);
    expect(out.days[2].total).toBe(0);
    expectConsistent(out);
  });
});

describe("appendActivity", () => {
  it("appends to an empty day", () => {
    const out = appendActivity(make(), 2, act("N", 70));
    expect(titles(out, 2)).toEqual(["N"]);
    expect(out.days[1].total).toBe(70);
    expect(out.totalCost).toBe(720);
    expectConsistent(out);
  });

  it("appends at the end of a non-empty day", () => {
    expect(titles(appendActivity(make(), 1, act("N", 1)), 1)).toEqual(["A", "B", "C", "N"]);
  });
});

describe("insertActivityAt", () => {
  it("inserts at 0", () => {
    const out = insertActivityAt(make(), 1, 0, act("N", 10));
    expect(titles(out, 1)).toEqual(["N", "A", "B", "C"]);
    expectConsistent(out);
  });

  it("inserts at length", () => {
    const out = insertActivityAt(make(), 1, 3, act("N", 10));
    expect(titles(out, 1)).toEqual(["A", "B", "C", "N"]);
    expectConsistent(out);
  });

  it("inserts in the middle", () => {
    expect(titles(insertActivityAt(make(), 1, 1, act("N", 10)), 1)).toEqual(["A", "N", "B", "C"]);
  });
});

describe("moveActivity", () => {
  it("moves between days and recomputes both totals", () => {
    const out = moveActivity(make(), { day: 1, index: 1 }, { day: 3, index: 0 });
    expect(titles(out, 1)).toEqual(["A", "C"]);
    expect(titles(out, 3)).toEqual(["B", "X"]);
    expect(out.days[0].total).toBe(400);
    expect(out.days[2].total).toBe(250);
    expect(out.totalCost).toBe(650);
    expectConsistent(out);
  });

  it("appends to the destination when to.index is omitted", () => {
    const out = moveActivity(make(), { day: 1, index: 0 }, { day: 2 });
    expect(titles(out, 1)).toEqual(["B", "C"]);
    expect(titles(out, 2)).toEqual(["A"]);
  });

  it("same-day move: to.index is the final position after removal", () => {
    expect(titles(moveActivity(make(), { day: 1, index: 0 }, { day: 1, index: 2 }), 1)).toEqual(["B", "C", "A"]);
    expect(titles(moveActivity(make(), { day: 1, index: 2 }, { day: 1, index: 0 }), 1)).toEqual(["C", "A", "B"]);
    expect(titles(moveActivity(make(), { day: 1, index: 0 }, { day: 1, index: 1 }), 1)).toEqual(["B", "A", "C"]);
  });

  it("same-day move with omitted index goes to the end", () => {
    expect(titles(moveActivity(make(), { day: 1, index: 0 }, { day: 1 }), 1)).toEqual(["B", "C", "A"]);
  });

  it("same-day to.index equal to the original length is out of range", () => {
    const it = make();
    expect(moveActivity(it, { day: 1, index: 0 }, { day: 1, index: 3 })).toBe(it);
  });

  it("keeps totals unchanged for a same-day move", () => {
    const out = moveActivity(make(), { day: 1, index: 0 }, { day: 1, index: 2 });
    expect(out.totalCost).toBe(650);
    expectConsistent(out);
  });
});

describe("setActivityTime", () => {
  it("sets only the time of the targeted stop", () => {
    const out = setActivityTime(make(), 1, 1, "14:30");
    expect(out.days[0].activities.map((a) => a.time)).toEqual(["09:00", "14:30", "09:00"]);
    expect(out.days[0].activities[1].title).toBe("B");
    expectConsistent(out);
  });
});

describe("out-of-range input returns the same object", () => {
  const base = make();
  const inp = base; // shorthand used by the case table below
  const a = act("N", 1);
  const cases: Array<[string, () => Itinerary]> = [
    ["remove unknown day", () => removeActivityAt(inp, 9, 0)],
    ["remove index past end", () => removeActivityAt(inp, 1, 3)],
    ["remove negative index", () => removeActivityAt(inp, 1, -1)],
    ["remove non-integer index", () => removeActivityAt(inp, 1, 0.5)],
    ["remove NaN index", () => removeActivityAt(inp, 1, Number.NaN)],
    ["remove on empty day", () => removeActivityAt(inp, 2, 0)],
    ["append unknown day", () => appendActivity(inp, 9, a)],
    ["insert unknown day", () => insertActivityAt(inp, 9, 0, a)],
    ["insert index past length", () => insertActivityAt(inp, 1, 4, a)],
    ["insert negative index", () => insertActivityAt(inp, 1, -1, a)],
    ["insert non-integer index", () => insertActivityAt(inp, 1, 1.5, a)],
    ["move unknown source day", () => moveActivity(inp, { day: 9, index: 0 }, { day: 1 })],
    ["move unknown destination day", () => moveActivity(inp, { day: 1, index: 0 }, { day: 9 })],
    ["move bad source index", () => moveActivity(inp, { day: 1, index: 3 }, { day: 2 })],
    ["move non-integer source index", () => moveActivity(inp, { day: 1, index: 1.2 }, { day: 2 })],
    ["move destination index past length", () => moveActivity(inp, { day: 1, index: 0 }, { day: 3, index: 2 })],
    ["move negative destination index", () => moveActivity(inp, { day: 1, index: 0 }, { day: 3, index: -1 })],
    ["move non-integer destination index", () => moveActivity(inp, { day: 1, index: 0 }, { day: 3, index: 0.5 })],
    ["setTime unknown day", () => setActivityTime(inp, 9, 0, "10:00")],
    ["setTime bad index", () => setActivityTime(inp, 1, 3, "10:00")],
    ["setTime non-integer index", () => setActivityTime(inp, 1, 0.5, "10:00")],
  ];
  for (const [name, run] of cases) {
    test(name, () => {
      expect(run()).toBe(base);
    });
  }
});

describe("inputs are not mutated", () => {
  it("leaves a deep-frozen input intact for every helper", () => {
    const frozen = deepFreeze(make());
    const snapshot = structuredClone(frozen);
    const a = act("N", 5);
    expect(() => {
      removeActivityAt(frozen, 1, 0);
      appendActivity(frozen, 2, a);
      insertActivityAt(frozen, 1, 1, a);
      moveActivity(frozen, { day: 1, index: 0 }, { day: 3, index: 1 });
      moveActivity(frozen, { day: 1, index: 0 }, { day: 1, index: 2 });
      setActivityTime(frozen, 1, 0, "20:00");
    }).not.toThrow();
    expect(frozen).toEqual(snapshot);
    expect(frozen.revised).toBeUndefined();
  });

  it("does not share the edited day's activities array with the input", () => {
    const src = make();
    const out = appendActivity(src, 1, act("N", 1));
    expect(out.days[0].activities).not.toBe(src.days[0].activities);
    expect(src.days[0].activities).toHaveLength(3);
  });
});
