import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  selectSlides,
  removeFailed,
  stepIndex,
  shouldRotate,
  chooseDayMedia,
  formatTimeRange,
  parseHHMM,
  type Slide,
} from "@/lib/itinerary/carousel";
import type { Activity } from "@/lib/types";

const RUNS = { numRuns: 100 };

const validRef = fc
  .tuple(
    fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/),
    fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/),
  )
  .map(([p, q]) => `places/${p}/photos/${q}`);
const badRef = fc.oneof(
  fc.constant(""),
  fc.constant("places/x"),
  fc.constant("places/a b/photos/c"),
  fc.constant("https://example.com/x.jpg"),
  fc.string().filter((s) => !/^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/.test(s)),
);
const anyRef = fc.oneof(validRef, badRef);
const hhmm = fc
  .tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
  .map(([h, m]) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);

const activity = fc.record(
  {
    title: fc.string(),
    placeName: fc.string(),
    time: hhmm,
    verified: fc.boolean(),
    photoRef: fc.option(anyRef, { nil: undefined }),
    photos: fc.option(fc.array(anyRef, { maxLength: 3 }), { nil: undefined }),
  },
  { requiredKeys: ["time"] },
) as unknown as fc.Arbitrary<Activity>;

const firstValid = (a: Activity): string | undefined => {
  const re = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/;
  const f = a.photos?.[0];
  if (typeof f === "string" && re.test(f)) return f;
  return typeof a.photoRef === "string" && re.test(a.photoRef) ? a.photoRef : undefined;
};

const toStr = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

describe("day carousel helpers", () => {
  // Feature: day-carousel-layout, Property 1: Slides match the day's photo stops
  it("Property 1: slides match the day's photo stops", () => {
    fc.assert(
      fc.property(fc.array(activity, { maxLength: 12 }), (acts) => {
        const expected = acts.filter((a) => firstValid(a) !== undefined);
        const slides = selectSlides(acts);
        expect(slides.length).toBe(expected.length);
        slides.forEach((s, i) => {
          expect(s.ref).toBe(firstValid(expected[i]));
          const title = (expected[i].title ?? "").trim();
          expect(s.name).toBe(title || (expected[i].placeName ?? "").trim());
        });
      }),
      RUNS,
    );
  });

  // Feature: day-carousel-layout, Property 2: Index stepping wraps and inverts
  it("Property 2: index stepping wraps and inverts", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 40 }),
        fc.nat(),
        (count, seed) => {
          const cur = seed % count;
          const f = stepIndex(cur, count, 1);
          const b = stepIndex(cur, count, -1);
          expect(f).toBeGreaterThanOrEqual(0);
          expect(f).toBeLessThan(count);
          expect(b).toBeGreaterThanOrEqual(0);
          expect(b).toBeLessThan(count);
          let x = cur;
          for (let i = 0; i < count; i++) x = stepIndex(x, count, 1);
          expect(x).toBe(cur);
          expect(stepIndex(f, count, -1)).toBe(cur);
          expect(stepIndex(b, count, 1)).toBe(cur);
        },
      ),
      RUNS,
    );
  });

  // Feature: day-carousel-layout, Property 3: Failed slides leave rotation
  it("Property 3: failed slides leave rotation", () => {
    fc.assert(
      fc.property(
        fc.array(validRef, { maxLength: 10 }),
        fc.array(validRef, { maxLength: 6 }),
        fc.array(fc.boolean(), { maxLength: 10 }),
        (refs, extra, picks) => {
          const slides: Slide[] = refs.map((ref, i) => ({ ref, name: `n${i}`, time: "09:00" }));
          const failed = new Set<string>([
            ...extra,
            ...refs.filter((_, i) => picks[i]),
          ]);
          const snapshot = JSON.stringify(slides);
          const out = removeFailed(slides, failed);
          expect(out).toEqual(slides.filter((s) => !failed.has(s.ref)));
          expect(JSON.stringify(slides)).toBe(snapshot);
        },
      ),
      RUNS,
    );
  });

  // Feature: day-carousel-layout, Property 4: Day media choice
  it("Property 4: day media choice", () => {
    fc.assert(
      fc.property(fc.array(activity, { maxLength: 10 }), (acts) => {
        const verified = acts.some((a) => a.verified === true);
        const media = chooseDayMedia(acts);
        if (!verified) expect(media).toBe("fallback-query");
        else if (selectSlides(acts).length >= 1) expect(media).toBe("carousel");
        else expect(media).toBe("illustration");
      }),
      RUNS,
    );
  });

  // Feature: day-carousel-layout, Property 5: Rotation predicate
  it("Property 5: rotation predicate", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 }),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (count, hovered, focused, hidden, reducedMotion, active) => {
          const expected =
            count >= 2 && !hovered && !focused && !hidden && !reducedMotion && active;
          expect(
            shouldRotate({ count, hovered, focused, hidden, reducedMotion, active }),
          ).toBe(expected);
        },
      ),
      RUNS,
    );
  });

  // Feature: day-carousel-layout, Property 6: Time range uses only permitted sources
  it("Property 6: time range uses only permitted sources", () => {
    const timeStr = fc.oneof(hhmm, fc.string(), fc.constantFrom("24:00", "9:00", "12:60", "", "ab:cd"));
    fc.assert(
      fc.property(
        timeStr,
        fc.option(fc.oneof(fc.integer({ min: -5, max: 1500 }), fc.double({ noNaN: false })), { nil: undefined }),
        fc.option(fc.oneof(fc.integer({ min: -5, max: 600 }), fc.double({ noNaN: false })), { nil: undefined }),
        fc.option(timeStr, { nil: undefined }),
        (time, visitMin, travel, nextTime) => {
          const a = { time, visitMin, travelToNextMin: travel } as unknown as Activity;
          const next = nextTime === undefined ? undefined : ({ time: nextTime } as unknown as Activity);
          const r = formatTimeRange(a, next);
          const start = parseHHMM(time);
          expect(r.start).toBe(time);
          if (r.kind === "start-only") {
            expect(r.end).toBeUndefined();
            expect(r.text).toBe(time);
            return;
          }
          expect(start).not.toBeNull();
          const end = parseHHMM(r.end);
          expect(end).not.toBeNull();
          expect(end!).toBeGreaterThan(start!);
          expect(end!).toBeLessThan(1440);
          const validVisit =
            typeof visitMin === "number" && Number.isInteger(visitMin) && visitMin >= 1 && visitMin <= 1440;
          if (r.kind === "range") {
            expect(validVisit).toBe(true);
            expect(end).toBe(start! + (visitMin as number));
            expect(r.text).toBe(`${time} \u2013 ${r.end}`);
          } else {
            expect(validVisit).toBe(false);
            const ns = parseHHMM(nextTime);
            expect(ns).not.toBeNull();
            expect(typeof travel).toBe("number");
            expect(end).toBe(ns! - (travel as number));
            expect(r.text).toBe(`${time}, until about ${r.end}`);
          }
        },
      ),
      RUNS,
    );
  });

  // Feature: day-carousel-layout, Property 9: New copy avoids certainty words
  it("Property 9: new copy avoids certainty words", () => {
    const banned = /confirmed|bookable|guaranteed|100% accurate/i;
    fc.assert(
      fc.property(
        hhmm,
        fc.option(fc.integer({ min: 1, max: 1440 }), { nil: undefined }),
        fc.option(fc.integer({ min: 0, max: 120 }), { nil: undefined }),
        hhmm,
        fc.array(validRef, { maxLength: 8 }),
        (time, visitMin, travel, nextTime, refs) => {
          const r = formatTimeRange(
            { time, visitMin, travelToNextMin: travel } as unknown as Activity,
            { time: nextTime } as unknown as Activity,
          );
          expect(banned.test(r.text)).toBe(false);
          // Accessible labels the carousel builds from a slide list (design: day-carousel.tsx).
          const m = refs.length;
          const labels = [
            "Photos for this day",
            "Previous photo",
            "Next photo",
            ...refs.flatMap((_, i) => [`${i + 1} of ${m}`, `Show photo ${i + 1} of ${m}`]),
          ];
          for (const l of labels) expect(banned.test(l)).toBe(false);
        },
      ),
      RUNS,
    );
  });

  describe("formatTimeRange examples", () => {
    const act = (o: Record<string, unknown>) => o as unknown as Activity;

    it("range from visitMin", () => {
      const r = formatTimeRange(act({ time: "12:00", visitMin: 90 }));
      expect(r).toEqual({ start: "12:00", end: "13:30", kind: "range", text: "12:00 \u2013 13:30" });
    });
    it("estimate from next stop minus travel", () => {
      const r = formatTimeRange(
        act({ time: "12:00", travelToNextMin: 30 }),
        act({ time: "14:00" }),
      );
      expect(r.kind).toBe("estimate");
      expect(r.text).toBe("12:00, until about 13:30");
    });
    it("end before start gives start only", () => {
      const r = formatTimeRange(act({ time: "12:00", travelToNextMin: 30 }), act({ time: "11:00" }));
      expect(r).toEqual({ start: "12:00", kind: "start-only", text: "12:00" });
    });
    it("end equal to start gives start only", () => {
      expect(formatTimeRange(act({ time: "12:00", travelToNextMin: 30 }), act({ time: "12:30" })).kind).toBe(
        "start-only",
      );
    });
    it("end at 24:00 gives start only", () => {
      const r = formatTimeRange(act({ time: "22:00", visitMin: 120 }));
      expect(r.kind).toBe("start-only");
      expect(r.text).toBe("22:00");
    });
    it("end past midnight gives start only", () => {
      expect(formatTimeRange(act({ time: "23:00", visitMin: 180 })).kind).toBe("start-only");
    });
    it("end just before midnight is allowed", () => {
      expect(formatTimeRange(act({ time: "22:00", visitMin: 119 })).text).toBe("22:00 \u2013 23:59");
    });
    it("invalid strings give start only without throwing", () => {
      for (const t of ["", "9:00", "24:00", "12:60", "noon", "12:00:00", " 12:00"]) {
        const r = formatTimeRange(act({ time: t, visitMin: 30 }));
        expect(r).toEqual({ start: t, kind: "start-only", text: t });
      }
      expect(formatTimeRange(act({ time: "10:00" }), act({ time: "bad" })).kind).toBe("start-only");
      expect(formatTimeRange(act({ time: "10:00", visitMin: 0.5 })).kind).toBe("start-only");
    });
    it("missing next stop and visitMin gives start only", () => {
      const r = formatTimeRange(act({ time: "10:00", travelToNextMin: 15 }));
      expect(r).toEqual({ start: "10:00", kind: "start-only", text: "10:00" });
    });
    it("visitMin wins over the next-stop estimate", () => {
      const r = formatTimeRange(
        act({ time: "10:00", visitMin: 60, travelToNextMin: 5 }),
        act({ time: "15:00" }),
      );
      expect(r.kind).toBe("range");
      expect(r.end).toBe(toStr(11 * 60));
    });
  });
});
