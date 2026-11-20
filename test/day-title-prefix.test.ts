import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { stripDayPrefix, uniqueTitle } from "../lib/itinerary/batch-service";

// Day titles must not carry a "Day N:" label (the UI already shows the day number).

const title = (raw: string, areas: string[] = ["Panaji"], day = 1, taken = new Set<string>()) =>
  uniqueTitle(raw, areas, day, taken);

describe("uniqueTitle strips the Day N prefix", () => {
  it.each([
    ["Day 1: Arrival in Panaji", "Arrival in Panaji"],
    ["Day 2 - Beaches", "Beaches"],
    ["Day 3 \u2013 Old Goa", "Old Goa"],
    ["Day 3 \u2014 Old Goa", "Old Goa"],
    ["DAY 4: Spice Farm", "Spice Farm"],
    ["day 5:Fort Walk", "Fort Walk"],
  ])("%s -> %s", (raw, expected) => {
    expect(title(raw)).toBe(expected);
  });

  it("falls back to an area title when nothing is left", () => {
    expect(title("Day 2:", ["Candolim"], 2)).toBe("Candolim day");
    expect(title("Day 2 - ", [], 2)).toBe("Day 2");
  });

  it("keeps titles unique within a batch after stripping", () => {
    const taken = new Set<string>();
    const a = uniqueTitle("Day 1: Beaches", ["Baga"], 1, taken);
    const b = uniqueTitle("Day 2: Beaches", ["Baga"], 2, taken);
    const c = uniqueTitle("Beaches", ["Baga"], 3, taken);
    expect(new Set([a, b, c].map((t) => t.toLowerCase())).size).toBe(3);
    expect(a).toBe("Beaches");
    expect(b).not.toMatch(/^day\s*\d/i);
  });

  it.each(["Day trip to Dudhsagar", "South Goa Beaches", "Old Goa Heritage Walk", "Daydream Market Lanes"])(
    "leaves %s unchanged",
    (t) => {
      expect(title(t)).toBe(t);
      expect(stripDayPrefix(t)).toBe(t);
    },
  );

  it("property: stripping is idempotent", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (s) => {
        const once = stripDayPrefix(s);
        expect(stripDayPrefix(once)).toBe(once);
      }),
    );
  });

  it("property: the title is never empty and never starts with a Day N label", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 60 }),
        fc.array(fc.string({ maxLength: 20 }), { maxLength: 3 }),
        fc.integer({ min: 1, max: 14 }),
        (raw, areas, day) => {
          const t = uniqueTitle(raw, areas, day, new Set());
          expect(t.trim().length).toBeGreaterThan(0);
        },
      ),
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.constantFrom(":", " -", " \u2013", " \u2014"),
        fc.constantFrom("", "Beach Day", "Old Town"),
        (n, sep, body) => {
          const t = uniqueTitle(`Day ${n}${sep} ${body}`, ["Panaji"], n, new Set());
          expect(t.length).toBeGreaterThan(0);
          expect(t).not.toMatch(/^\s*day\s*\d+\s*[:\-\u2013\u2014]/i);
        },
      ),
    );
  });
});
