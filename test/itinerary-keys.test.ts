import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  nameKey,
  isGenericTitle,
  isVenueSpecificMeal,
  distinctDayTitles,
} from "@/lib/itinerary/place-key";
import { dedupeStops, type KeyedStop } from "@/lib/itinerary/dedupe";

const RUNS = { numRuns: 150 };

const GENERIC_PHRASES = [
  "local lunch", "Signature Experience", "afternoon activity", "free time", "explore the city",
  "local dinner", "morning activity", "evening experience", "free day", "leisure time",
  "city sightseeing", "street food", "local experience", "cultural experience", "tbd",
  "morning walk", "relaxed afternoon stroll", "authentic local restaurant",
];

const PROPER = ["Tanah", "Lot", "Ubud", "Kyoto", "Fushimi", "Inari", "Louvre", "Eiffel", "Borobudur", "Sagrada"];
const LANDMARK = ["Temple", "Museum", "Palace", "Fort", "Beach", "Tower", "Cathedral", "Garden", "Market"];
const VENUE = ["Restaurant", "Cafe", "Warung", "Bakery", "Bistro", "Grill"];
const CUISINE = [
  "indian", "balinese", "italian", "thai", "japanese", "seafood", "vegan", "local", "traditional",
  "street", "food", "cuisine", "dinner", "lunch", "breakfast", "authentic",
];

const properName = fc
  .array(fc.constantFrom(...PROPER), { minLength: 1, maxLength: 3 })
  .map((w) => w.join(" "));

const ws = fc.constantFrom(" ", "  ", "\t", " \u00a0 ");
const punct = fc.constantFrom("", ".", "!", ",", " - ", "?", "'", "\"", "()");

function mangle(s: string, c: "u" | "l" | "k", pad: string, p: string): string {
  const cased = c === "u" ? s.toUpperCase() : c === "l" ? s.toLowerCase() : s;
  return `${p}${pad}${cased.split(" ").join(pad)}${pad}${p}`;
}

// Feature: trustworthy-itinerary, Property 4: Place keys and deduplication
describe("Property 4: Place keys and deduplication", () => {
  const baseName = fc
    .array(fc.stringMatching(/^[a-z]{1,8}$/), { minLength: 1, maxLength: 4 })
    .map((w) => w.join(" "));

  it("nameKey ignores case, whitespace, punctuation and diacritics", () => {
    fc.assert(
      fc.property(
        baseName,
        fc.constantFrom<"u" | "l" | "k">("u", "l", "k"),
        ws,
        punct,
        fc.boolean(),
        (name, c, pad, p, accent) => {
          let variant = mangle(name, c, pad, p);
          if (accent) variant = variant.replace(/[aeiou]/gi, (m) => m + "\u0301");
          expect(nameKey(variant)).toBe(nameKey(name));
        },
      ),
      RUNS,
    );
  });

  it("nameKey is idempotent on any string", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const k = nameKey(s);
        expect(nameKey(k)).toBe(k);
      }),
      RUNS,
    );
  });

  it("precomposed diacritics fold to the same key", () => {
    expect(nameKey("Café Münster")).toBe(nameKey("cafe  MUNSTER!"));
    expect(nameKey("Tanah Lot, Temple")).toBe(nameKey("tanah lot temple"));
  });

  const stopArb = fc.record({
    key: fc.constantFrom("a", "b", "c", "d", "e", "f"),
    isStop: fc.boolean(),
    id: fc.nat(),
  });

  it("dedupeStops keeps unique, unused stops in first-occurrence order and never drops non-stop rows", () => {
    fc.assert(
      fc.property(
        fc.array(stopArb, { maxLength: 25 }),
        fc.array(fc.constantFrom("a", "b", "c", "d", "e", "f", "z")),
        (rawStops, usedArr) => {
          const stops = rawStops.map((s, i) => ({ ...s, id: i }));
          const used = new Set(usedArr);
          const { kept, dropped } = dedupeStops<KeyedStop & { id: number }>(stops, used);

          const keptStops = kept.filter((s) => s.isStop);
          const keys = keptStops.map((s) => s.key);
          expect(new Set(keys).size).toBe(keys.length);
          for (const k of keys) expect(used.has(k)).toBe(false);

          // never drops non-stop rows
          expect(dropped.every((s) => s.isStop)).toBe(true);
          expect(kept.filter((s) => !s.isStop).length).toBe(stops.filter((s) => !s.isStop).length);

          // partition and order preserved
          expect(kept.length + dropped.length).toBe(stops.length);
          const ids = kept.map((s) => s.id);
          expect([...ids].sort((x, y) => x - y)).toEqual(ids);

          // first occurrence wins
          const seen = new Set<string>();
          const expected: number[] = [];
          for (const s of stops) {
            if (!s.isStop) { expected.push(s.id); continue; }
            if (used.has(s.key) || seen.has(s.key)) continue;
            seen.add(s.key);
            expected.push(s.id);
          }
          expect(ids).toEqual(expected);
        },
      ),
      RUNS,
    );
  });

  it("dedupeStops is idempotent", () => {
    fc.assert(
      fc.property(
        fc.array(stopArb, { maxLength: 25 }),
        fc.array(fc.constantFrom("a", "b", "c", "z")),
        (stops, usedArr) => {
          const used = new Set(usedArr);
          const once = dedupeStops(stops, used).kept;
          const twice = dedupeStops(once, used).kept;
          expect(twice).toEqual(once);
        },
      ),
      RUNS,
    );
  });
});

// Feature: trustworthy-itinerary, Property 5: Generic titles and non-venue meals are rejected
describe("Property 5: Generic titles and non-venue meals are rejected", () => {
  it("rejects the named generic examples", () => {
    for (const t of ["local lunch", "Signature Experience", "afternoon activity", "free time", "explore the city"]) {
      expect(isGenericTitle(t)).toBe(true);
    }
  });

  it("accepts real names, including ones containing time words", () => {
    for (const t of ["Tanah Lot Temple", "Warung Babi Guling Ibu Oka", "Sunset Point", "Morning Star Café"]) {
      expect(isGenericTitle(t)).toBe(false);
    }
  });

  it("any generic phrase is generic in any case with added punctuation or whitespace", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...GENERIC_PHRASES),
        fc.constantFrom<"u" | "l" | "k">("u", "l", "k"),
        ws,
        punct,
        (phrase, c, pad, p) => {
          expect(isGenericTitle(mangle(phrase, c, pad, p))).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it("a capitalised proper name plus a landmark or venue noun is not generic", () => {
    fc.assert(
      fc.property(properName, fc.constantFrom(...LANDMARK, ...VENUE), (n, noun) => {
        expect(isGenericTitle(`${n} ${noun}`)).toBe(false);
      }),
      RUNS,
    );
  });

  it("meal names made only of cuisine or generic words are not venue-specific", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...CUISINE), { minLength: 1, maxLength: 3 }),
        fc.constantFrom<"l" | "k">("l", "k"),
        (words, c) => {
          const name = words.join(" ");
          const shown = c === "k" ? name.replace(/\b[a-z]/g, (m) => m.toUpperCase()) : name;
          expect(isVenueSpecificMeal(shown)).toBe(false);
        },
      ),
      RUNS,
    );
  });

  it("meal names with a proper-name restaurant or a venue noun are venue-specific", () => {
    fc.assert(
      fc.property(properName, fc.constantFrom(...VENUE), (n, v) => {
        expect(isVenueSpecificMeal(`${n} ${v}`)).toBe(true);
        expect(isVenueSpecificMeal(n)).toBe(true);
      }),
      RUNS,
    );
    expect(isVenueSpecificMeal("Warung Babi Guling Ibu Oka")).toBe(true);
    expect(isVenueSpecificMeal("local lunch")).toBe(false);
    expect(isVenueSpecificMeal("")).toBe(false);
  });

  it("distinctDayTitles is true exactly when titles are pairwise different after nameKey", () => {
    const title = fc.oneof(
      fc.constantFrom("Tanah Lot", "tanah  lot!", "TANAH LOT", "Ubud Market", "ubud market", "Café", "cafe", ""),
      fc.string({ maxLength: 8 }),
    );
    fc.assert(
      fc.property(fc.array(title, { maxLength: 8 }), (titles) => {
        const keys = titles.map(nameKey);
        expect(distinctDayTitles(titles)).toBe(new Set(keys).size === keys.length);
      }),
      RUNS,
    );
  });
});
