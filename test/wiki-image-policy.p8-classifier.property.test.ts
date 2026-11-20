import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { classifyImage } from "@/lib/wiki-image-policy";

// Feature: chat-images-bedrock-planner, Property 8: Never a flag, emblem, map, logo or SVG
// **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.8**

const RUNS = { numRuns: 200 };

const SEPARATORS = ["_", " ", "-", "%20", "__", "_-_"];
const sepArb = fc.constantFrom(...SEPARATORS);

/** Random letter case per character. */
const mixCase = (s: string, bits: boolean[]): string =>
  [...s].map((c, i) => (bits[i % bits.length] ? c.toUpperCase() : c.toLowerCase())).join("");
const bitsArb = fc.array(fc.boolean(), { minLength: 1, maxLength: 16 });

const placeWordArb = fc.constantFrom(
  "India", "Kerala", "Mumbai", "Goa", "Paris", "Taj", "Mahal", "Fuji", "Kyoto", "Singapore", "Delhi", "Jaipur", "Bali",
);

/** Banned phrases as word lists, each ending in a place where the pattern expects one. */
const BANNED_STEMS: string[][] = [
  ["Flag", "of"],
  ["Coat", "of", "arms", "of"],
  ["Emblem", "of"],
  ["Seal", "of"],
  ["Locator", "map", "of"],
  ["Location", "map", "of"],
  ["Location", "map"],
  ["Locator", "map"],
];

const joinWords = (words: string[], seps: string[]): string =>
  words.reduce((acc, w, i) => (i === 0 ? w : acc + seps[i % seps.length] + w), "");

const sizePrefixArb = fc.option(fc.constantFrom(20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920, 3840).map((n) => `${n}px-`), {
  nil: "",
});

const rasterExtArb = fc.constantFrom(".jpg", ".jpeg", ".png", ".webp", ".svg.png", ".svg");

const encodeArb = fc.constantFrom<"none" | "component" | "all">("none", "component", "all");
const encodeAll = (s: string) => [...s].map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
const applyEncoding = (s: string, mode: "none" | "component" | "all") =>
  mode === "none" ? s : mode === "component" ? encodeURIComponent(s) : encodeAll(s);

const bannedStemNameArb = fc
  .record({
    stem: fc.constantFrom(...BANNED_STEMS),
    place: placeWordArb,
    seps: fc.array(sepArb, { minLength: 1, maxLength: 6 }),
    bits: bitsArb,
    size: sizePrefixArb,
    ext: rasterExtArb,
    enc: encodeArb,
  })
  .map(({ stem, place, seps, bits, size, ext, enc }) => {
    const words = stem[stem.length - 1] === "of" || stem[stem.length - 1] === "arms" || stem[stem.length - 1] === "map"
      ? [...stem, place]
      : stem;
    const phrase = mixCase(joinWords(words, seps), bits);
    return applyEncoding(`${size}${phrase}${ext}`, enc);
  });

const logoNameArb = fc
  .record({
    place: placeWordArb,
    sep: sepArb,
    bits: bitsArb,
    size: sizePrefixArb,
    ext: rasterExtArb,
    before: fc.boolean(),
    enc: encodeArb,
  })
  .map(({ place, sep, bits, size, ext, before, enc }) => {
    const phrase = mixCase(before ? `logo${sep}${place}` : `${place}${sep}logo`, bits);
    return applyEncoding(`${size}${phrase}${ext}`, enc);
  });

/** Any file name that ends in or contains .svg is rejected, whatever the base name is. */
const svgNameArb = fc
  .record({
    base: fc.stringMatching(/^[A-Za-z0-9_\-]{1,20}$/),
    size: sizePrefixArb,
    bits: bitsArb,
    tail: fc.constantFrom("", ".png", ".jpg"),
    enc: encodeArb,
  })
  .map(({ base, size, bits, tail, enc }) => applyEncoding(`${size}${base}${mixCase(".svg", bits)}${tail}`, enc));

const bannedFileNameArb = fc.oneof(bannedStemNameArb, logoNameArb, svgNameArb);

const BANNED_WORD_FRAGMENTS =
  /flag|emblem|seal|logo|locat|map|globe|crest|symbol|icon|banner|standard|wordmark|picto|orthographic|arms|svg/i;

const alphaWordArb = fc
  .stringMatching(/^[A-Za-z]{3,10}$/)
  .filter((w) => !BANNED_WORD_FRAGMENTS.test(w));

const SAFE_TRICKY = ["Flagstaff", "Flagler", "Sealdah", "Flagstone", "Sealy", "Mapleton", "Sealand"];

const photoWordArb = fc.oneof(
  { arbitrary: alphaWordArb, weight: 3 },
  { arbitrary: placeWordArb, weight: 2 },
  { arbitrary: fc.constantFrom(...SAFE_TRICKY), weight: 3 },
);

const acceptedFileNameArb = fc
  .record({
    words: fc.array(photoWordArb, { minLength: 1, maxLength: 4 }),
    seps: fc.array(sepArb, { minLength: 1, maxLength: 4 }),
    bits: bitsArb,
    size: sizePrefixArb,
    ext: fc.constantFrom(".jpg", ".jpeg", ".png", ".webp", ".JPG"),
    enc: fc.constantFrom<"none" | "component">("none", "component"),
  })
  .map(({ words, seps, bits, size, ext, enc }) =>
    applyEncoding(`${size}${mixCase(joinWords(words, seps), bits)}${ext}`, enc),
  );

describe("classifyImage property (Property 8)", () => {
  it("rejects every file name that embeds a banned pattern, in any case, encoding and size prefix", () => {
    fc.assert(
      fc.property(bannedFileNameArb, (fileName) => {
        expect(classifyImage({ fileName })).toBe("reject");
      }),
      RUNS,
    );
  });

  it("rejects banned page titles", () => {
    const titleArb = fc
      .record({ stem: fc.constantFrom(...BANNED_STEMS), place: placeWordArb, seps: fc.array(sepArb, { minLength: 1, maxLength: 5 }), bits: bitsArb })
      .map(({ stem, place, seps, bits }) => mixCase(joinWords([...stem, place], seps).replace(/%20/g, " "), bits));
    fc.assert(
      fc.property(titleArb, (title) => {
        expect(classifyImage({ title })).toBe("reject");
      }),
      RUNS,
    );
  });

  it("rejects every URL whose path contains .svg", () => {
    const urlArb = fc
      .record({
        base: fc.stringMatching(/^[A-Za-z0-9_]{1,20}$/),
        bits: bitsArb,
        size: fc.constantFrom(120, 250, 500, 960, 1280),
        thumb: fc.boolean(),
      })
      .map(({ base, bits, size, thumb }) => {
        const svg = `${base}${mixCase(".svg", bits)}`;
        return thumb
          ? `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${svg}/${size}px-${svg}.png`
          : `https://upload.wikimedia.org/wikipedia/commons/a/ab/${svg}`;
      });
    fc.assert(
      fc.property(urlArb, (url) => {
        expect(classifyImage({ url })).toBe("reject");
      }),
      RUNS,
    );
  });

  it("rejects a banned file name taken from a URL path", () => {
    fc.assert(
      fc.property(bannedFileNameArb.filter((n) => !n.includes("%")), (name) => {
        const safe = encodeURIComponent(name);
        const url = `https://upload.wikimedia.org/wikipedia/commons/a/ab/${safe}`;
        expect(classifyImage({ url })).toBe("reject");
      }),
      RUNS,
    );
  });

  it("accepts ordinary place photo names, including Flagstaff, Flagler and Sealdah", () => {
    fc.assert(
      fc.property(acceptedFileNameArb, (fileName) => {
        expect(classifyImage({ fileName })).toBe("accept");
      }),
      RUNS,
    );
  });

  it("accepts ordinary place photo page titles", () => {
    fc.assert(
      fc.property(fc.array(photoWordArb, { minLength: 1, maxLength: 4 }), (words) => {
        expect(classifyImage({ title: words.join(" ") })).toBe("accept");
      }),
      RUNS,
    );
  });

  it("matches the fixed examples", () => {
    expect(classifyImage({ fileName: "Taj_Mahal_(Edited).jpeg" })).toBe("accept");
    expect(classifyImage({ fileName: "Flagstaff.jpg" })).toBe("accept");
    expect(classifyImage({ fileName: "Flagler_Beach.jpg" })).toBe("accept");
    expect(classifyImage({ fileName: "Sealdah_railway_station.jpg" })).toBe("accept");
    expect(classifyImage({ fileName: "250px-Flag_of_India.svg.png" })).toBe("reject");
    expect(classifyImage({ fileName: "250px-Flag%20of%20India.svg.png" })).toBe("reject");
  });
});
