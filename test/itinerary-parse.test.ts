import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  encodeProposedDays,
  parseBatchText,
  parseRepairText,
  type ProposedDay,
  type ProposedStop,
} from "../lib/itinerary/batch-parse";
import { sanitizeDisplayText } from "../lib/itinerary/text";

const KINDS = ["sight", "meal", "experience"] as const;
const ARRAY_START = '{"days":['.length;

const clean = (max: number) =>
  fc.string({ maxLength: 40 }).map((s) => sanitizeDisplayText(s, max));

const stopArb: fc.Arbitrary<ProposedStop> = fc.record({
  time: clean(20),
  place: clean(100).filter((s) => s.length > 0),
  area: clean(60),
  kind: fc.constantFrom(...KINDS),
  description: clean(160),
  cost: fc.integer({ min: 0, max: 100_000 }),
});

const dayArb: fc.Arbitrary<ProposedDay> = fc.record({
  title: clean(80),
  dayTrip: fc.boolean(),
  stops: fc.array(stopArb, { minLength: 1, maxLength: 4 }),
});

const daysArb = fc.array(dayArb, { minLength: 1, maxLength: 4 });

function wellFormed(d: ProposedDay): boolean {
  return (
    typeof d.title === "string" &&
    typeof d.dayTrip === "boolean" &&
    Array.isArray(d.stops) &&
    d.stops.length > 0 &&
    d.stops.every(
      (s) =>
        typeof s.place === "string" &&
        s.place.length > 0 &&
        typeof s.time === "string" &&
        typeof s.area === "string" &&
        typeof s.description === "string" &&
        (KINDS as readonly string[]).includes(s.kind) &&
        Number.isInteger(s.cost) &&
        s.cost >= 0 &&
        !/[<>]/.test(s.place),
    )
  );
}

const act = (place: string) => ({ time: "09:00", place, kind: "sight", cost: 5 });

describe("parseBatchText properties", () => {
  // Feature: trustworthy-itinerary, Property 10: Truncation-tolerant parsing
  it("Property 10: every prefix cut yields exactly the complete days, flags truncation, never throws", () => {
    fc.assert(
      fc.property(daysArb, (days) => {
        const full = encodeProposedDays(days);
        const all = parseBatchText(full, days.length).days;
        expect(all.length).toBe(days.length);
        // end index of day k = length of the k-day encoding minus "]}"
        const ends = days.map(
          (_, k) => encodeProposedDays(days.slice(0, k + 1)).length - 2,
        );
        for (let cut = 0; cut <= full.length; cut++) {
          const r = parseBatchText(full.slice(0, cut), days.length);
          const complete = ends.filter((e) => e <= cut).length;
          expect(r.days).toEqual(all.slice(0, complete));
          if (cut >= ARRAY_START) {
            expect(r.truncated).toBe(cut < full.length - 1);
          } else {
            expect(r.days).toEqual([]);
          }
        }
      }),
      { numRuns: 100 },
    );
  }, 60_000);

  // Feature: trustworthy-itinerary, Property 10: Truncation-tolerant parsing
  it("Property 10: arbitrary strings never throw and give well-formed days", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.fullUnicodeString()), fc.integer({ min: -2, max: 6 }), (s, n) => {
        const r = parseBatchText(s, n);
        expect(r.days.length).toBeLessThanOrEqual(Math.max(0, n));
        expect(r.days.every(wellFormed)).toBe(true);
        expect(typeof r.truncated).toBe("boolean");
      }),
      { numRuns: 200 },
    );
  });

  // Feature: trustworthy-itinerary, Property 10: Truncation-tolerant parsing
  it("Property 10: JSON-looking noise never throws and gives well-formed days", () => {
    const piece = fc.constantFrom('{"days":[', '{"activities":[', '{"place":"A"', ",", "]", "}", '"', "\\", "```json", '"days"', ":", '"place":"X","kind":"meal"');
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 20 }).map((a) => a.join("")), (s) => {
        const r = parseBatchText(s, 3);
        expect(r.days.every(wellFormed)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: trustworthy-itinerary, Property 10: Truncation-tolerant parsing
  it("Property 10: non-string or odd inputs never throw", () => {
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (a, b) => {
        const r = parseBatchText(a as string, b as number);
        expect(Array.isArray(r.days)).toBe(true);
        expect(r.days.every(wellFormed)).toBe(true);
        expect(() => parseRepairText(a as string)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  // Feature: trustworthy-itinerary, Property 11: Day codec round trip
  it("Property 11: parse(encode(days)) equals days with truncated false", () => {
    fc.assert(
      fc.property(daysArb, (days) => {
        const r = parseBatchText(encodeProposedDays(days), days.length);
        expect(r.truncated).toBe(false);
        expect(r.days).toEqual(days);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: trustworthy-itinerary, Property 11: Day codec round trip
  it("Property 11: encoding is stable (encode of a parse is identical)", () => {
    fc.assert(
      fc.property(daysArb, (days) => {
        const s = encodeProposedDays(days);
        expect(encodeProposedDays(parseBatchText(s, days.length).days)).toBe(s);
      }),
      { numRuns: 100 },
    );
  });
});

describe("parseBatchText examples", () => {
  it("a 3-day answer cut inside day 3 yields 2 days and truncated true", () => {
    const mk = (n: number): ProposedDay => ({
      title: `Day ${n}`,
      dayTrip: false,
      stops: [{ time: "09:00", place: `Place ${n}`, area: "", kind: "sight", description: "", cost: 0 }],
    });
    const full = encodeProposedDays([mk(1), mk(2), mk(3)]);
    const cut = full.slice(0, full.indexOf("Place 3") + 3);
    const r = parseBatchText(cut, 3);
    expect(r.days.map((d) => d.stops[0].place)).toEqual(["Place 1", "Place 2"]);
    expect(r.truncated).toBe(true);
  });

  it("parses a code-fenced answer", () => {
    const text = 'Here you go:\n```json\n{"days":[{"title":"A","activities":[{"place":"Tanah Lot","kind":"sight","cost":"12"}]}]}\n```';
    const r = parseBatchText(text, 3);
    expect(r.truncated).toBe(false);
    expect(r.days).toHaveLength(1);
    expect(r.days[0].stops[0]).toMatchObject({ place: "Tanah Lot", kind: "sight", cost: 12 });
  });

  it("ignores day numbers in the text", () => {
    const text = '{"days":[{"day":7,"title":"x","activities":[{"place":"A"}]},{"day":2,"activities":[{"place":"B"}]}]}';
    const r = parseBatchText(text, 5);
    expect(r.days.map((d) => d.stops[0].place)).toEqual(["A", "B"]);
    expect(JSON.stringify(r.days)).not.toContain("day\":7");
  });

  it("returns no days for text with no JSON", () => {
    expect(parseBatchText("Sorry, I cannot help with that.", 3)).toEqual({ days: [], truncated: false });
    expect(parseBatchText("", 3).days).toEqual([]);
  });

  it("keeps only known fields, defaults kind and cost, drops placeless stops and empty days", () => {
    const text = JSON.stringify({
      days: [
        { title: "T", extra: 1, activities: [{ place: "A<b>", kind: "bogus", cost: "abc", foo: 1 }, { time: "1" }] },
        { title: "empty", activities: [{ description: "no place" }] },
      ],
    });
    const r = parseBatchText(text, 3);
    expect(r.days).toHaveLength(1);
    expect(r.days[0].stops).toEqual([
      { time: "", place: "Ab", area: "", kind: "sight", description: "", cost: 0 },
    ]);
  });

  it("returns at most expectedDays days", () => {
    const text = JSON.stringify({ days: [1, 2, 3].map((n) => ({ activities: [act(`P${n}`)] })) });
    expect(parseBatchText(text, 2).days).toHaveLength(2);
    expect(parseBatchText(text, 0).days).toHaveLength(0);
  });
});

describe("parseRepairText examples", () => {
  const rep = (day: unknown, slot: unknown, place = "Pura Besakih") => ({
    day,
    slot,
    activity: { time: "10:00", place, area: "Karangasem", kind: "sight", description: "d", cost: 3 },
  });

  it("parses replacements", () => {
    const out = parseRepairText(JSON.stringify({ replacements: [rep(0, 1), rep(2, 0, "Ubud Market")] }));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ day: 0, slot: 1, stop: { place: "Pura Besakih", cost: 3 } });
    expect(out[1].stop.place).toBe("Ubud Market");
  });

  it("skips invalid day/slot and placeless activities", () => {
    const text = JSON.stringify({
      replacements: [rep("1", 0), rep(1.5, 0), rep(-1, 0), rep(0, -1), rep(0, 0, ""), rep(1, 1)],
    });
    const out = parseRepairText(text);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ day: 1, slot: 1 });
  });

  it("keeps complete items of a truncated answer and handles code fences and no JSON", () => {
    const full = JSON.stringify({ replacements: [rep(0, 0, "A"), rep(1, 1, "B")] });
    const cut = full.slice(0, full.indexOf('"B"'));
    expect(parseRepairText(cut).map((r) => r.stop.place)).toEqual(["A"]);
    expect(parseRepairText("```json\n" + full + "\n```")).toHaveLength(2);
    expect(parseRepairText("nothing here")).toEqual([]);
    expect(parseRepairText("")).toEqual([]);
  });
});
