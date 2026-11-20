import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  MAX_IMAGE_WIDTH,
  MIN_USABLE_WIDTH,
  SIZE_WIDTHS,
  STANDARD_WIDTHS,
  buildSrcSet,
  chooseWidths,
  largestStandardAtMost,
  rewriteThumbWidth,
  smallestStandardAtLeast,
  thumbFromOriginal,
  type SizeClass,
} from "../lib/wiki-image-policy";

// Feature: chat-images-bedrock-planner, Property 7: Image URL width is standard, capped and on an allowed host
// **Validates: Requirements 4.1, 4.2, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9**

const RUNS = { numRuns: 200 };
const STD = STANDARD_WIDTHS as readonly number[];
const HOST = "upload.wikimedia.org";

const sizeArb = fc.constantFrom<SizeClass>("thumb", "card", "hero", "cover");
const originalWidthArb = fc.oneof(
  fc.integer({ min: 1, max: 6000 }),
  fc.constantFrom(...STD, 639, 640, 641, 329, 330, 331, 1919, 1920, 1921),
);
const thumbWidthArb = fc.oneof(fc.integer({ min: 1, max: 5000 }), fc.constantFrom(...STD));

const hex = fc.constantFrom(..."0123456789abcdef".split(""));
const fileStem = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,15}$/);
const ext = fc.constantFrom("jpg", "jpeg", "png", "webp", "JPG");
const fileArb = fc.tuple(fileStem, ext).map(([s, e]) => `${s}.${e}`);
const dirArb = fc.tuple(hex, hex, hex).map(([a, b, c]) => ({ a, ab: `${a}${b}`, c }));

const thumbUrlArb = fc
  .tuple(dirArb, fileArb, fc.integer({ min: 20, max: 5000 }))
  .map(([d, f, w]) => `https://${HOST}/wikipedia/commons/thumb/${d.a}/${d.ab}/${f}/${w}px-${f}`);
const originalUrlArb = fc
  .tuple(dirArb, fileArb)
  .map(([d, f]) => `https://${HOST}/wikipedia/commons/${d.a}/${d.ab}/${f}`);

function widthOf(url: string): number {
  const m = /\/(\d+)px-[^/]+$/.exec(new URL(url).pathname);
  expect(m).not.toBeNull();
  return Number(m![1]);
}

function expectAllowed(url: string, width: number): void {
  const u = new URL(url);
  expect(u.protocol).toBe("https:");
  expect(u.hostname).toBe(HOST);
  expect(STD).toContain(width);
  expect(width).toBeLessThanOrEqual(MAX_IMAGE_WIDTH);
  expect(width).not.toBe(640);
}

describe("Property 7: width policy", () => {
  it("chooseWidths only returns standard widths up to 1920, never 640, 2x above 1x", () => {
    fc.assert(
      fc.property(sizeArb, fc.option(originalWidthArb, { nil: undefined }), thumbWidthArb, (size, orig, thumb) => {
        const r = chooseWidths(size, orig, thumb);
        if (r === null) return;
        for (const w of [r.x1, r.x2]) {
          if (w === undefined) continue;
          expect(STD).toContain(w);
          expect(w).toBeLessThanOrEqual(MAX_IMAGE_WIDTH);
          expect(w).not.toBe(640);
        }
        if (r.x2 !== undefined) expect(r.x2).toBeGreaterThan(r.x1);
      }),
      RUNS,
    );
  });

  it("narrow original: 1x is the largest standard width not above it, no 2x, null below 330", () => {
    fc.assert(
      fc.property(sizeArb, fc.integer({ min: 1, max: 6000 }), thumbWidthArb, (size, orig, thumb) => {
        const want = SIZE_WIDTHS[size];
        const r = chooseWidths(size, orig, thumb);
        if (orig >= want.x1) {
          // thumb class widths (120/250) are below the usable minimum by design; the 330 floor applies to the narrow-original path only.
          expect(r).not.toBeNull();
          expect(r!.x1).toBe(want.x1);
          if (orig >= want.x2) expect(r!.x2).toBe(want.x2);
          else expect(r!.x2).toBeUndefined();
          return;
        }
        const expected = largestStandardAtMost(orig);
        if (expected === null || expected < MIN_USABLE_WIDTH) {
          expect(r).toBeNull();
        } else {
          expect(r).toEqual({ x1: expected });
          expect(expected).toBeLessThanOrEqual(orig);
        }
      }),
      RUNS,
    );
  });

  it("unknown original width keeps only a usable standard thumb width", () => {
    fc.assert(
      fc.property(sizeArb, thumbWidthArb, (size, thumb) => {
        const r = chooseWidths(size, undefined, thumb);
        if (r === null) {
          expect(STD.includes(thumb) && thumb >= MIN_USABLE_WIDTH && thumb <= MAX_IMAGE_WIDTH).toBe(false);
        } else {
          expect(r).toEqual({ x1: thumb });
          expect(STD).toContain(thumb);
          expect(thumb).toBeLessThanOrEqual(MAX_IMAGE_WIDTH);
        }
      }),
      RUNS,
    );
  });

  it("rewriteThumbWidth yields https, allowed host, standard width <= 1920; null above the cap", () => {
    fc.assert(
      fc.property(thumbUrlArb, fc.integer({ min: -50, max: 6000 }), (url, width) => {
        const out = rewriteThumbWidth(url, width);
        if (width > MAX_IMAGE_WIDTH) {
          expect(out).toBeNull();
          return;
        }
        expect(out).not.toBeNull();
        const w = widthOf(out!);
        expectAllowed(out!, w);
        expect(w).toBe(smallestStandardAtLeast(width));
        expect(w).toBeGreaterThanOrEqual(width);
      }),
      RUNS,
    );
  });

  it("rewriteThumbWidth and thumbFromOriginal reject other hosts and non-https", () => {
    const badHost = fc.constantFrom("example.com", "upload.wikimedia.org.evil.com", "evil.com", "commons.wikimedia.org");
    fc.assert(
      fc.property(thumbUrlArb, originalUrlArb, badHost, fc.constantFrom(...STD.filter((w) => w <= 1920)), (t, o, host, w) => {
        expect(rewriteThumbWidth(t.replace(HOST, host), w)).toBeNull();
        expect(rewriteThumbWidth(t.replace("https:", "http:"), w)).toBeNull();
        expect(thumbFromOriginal(o.replace(HOST, host), w)).toBeNull();
        expect(thumbFromOriginal(o.replace("https:", "http:"), w)).toBeNull();
      }),
      RUNS,
    );
  });

  it("thumbFromOriginal builds a standard-width https thumbnail only for standard widths <= 1920", () => {
    fc.assert(
      fc.property(originalUrlArb, fc.integer({ min: 1, max: 6000 }), (url, width) => {
        const out = thumbFromOriginal(url, width);
        const usable = STD.includes(width) && width <= MAX_IMAGE_WIDTH;
        if (!usable) {
          expect(out).toBeNull();
          return;
        }
        expect(out).not.toBeNull();
        expectAllowed(out!, widthOf(out!));
        expect(widthOf(out!)).toBe(width);
        expect(new URL(out!).pathname).toContain("/thumb/");
      }),
      RUNS,
    );
  });

  it("srcset entries are ascending, 1x then 2x, with ascending widths when built from chosen widths", () => {
    fc.assert(
      fc.property(sizeArb, fc.integer({ min: 1, max: 6000 }), originalUrlArb, (size, orig, originalUrl) => {
        const r = chooseWidths(size, orig, 500);
        if (r === null) return;
        const x1 = thumbFromOriginal(originalUrl, r.x1);
        expect(x1).not.toBeNull();
        if (r.x2 === undefined) {
          expect(buildSrcSet(x1!)).toBeUndefined();
          return;
        }
        const x2 = thumbFromOriginal(originalUrl, r.x2);
        expect(x2).not.toBeNull();
        const set = buildSrcSet(x1!, x2!);
        expect(set).toBe(`${x1} 1x, ${x2} 2x`);
        const entries = set!.split(", ").map((e) => {
          const [url, d] = e.split(" ");
          return { url, density: Number(d.replace("x", "")), width: widthOf(url) };
        });
        expect(entries.map((e) => e.density)).toEqual([1, 2]);
        expect(entries[1].width).toBeGreaterThan(entries[0].width);
        for (const e of entries) expectAllowed(e.url, e.width);
      }),
      RUNS,
    );
  });

  it("buildSrcSet is undefined without a 2x entry", () => {
    fc.assert(
      fc.property(thumbUrlArb, (u) => {
        expect(buildSrcSet(u)).toBeUndefined();
        expect(buildSrcSet(u, "")).toBeUndefined();
      }),
      RUNS,
    );
  });

  it("smallestStandardAtLeast / largestStandardAtMost stay standard and capped", () => {
    fc.assert(
      fc.property(fc.double({ min: -100, max: 8000, noNaN: true }), (w) => {
        const hi = smallestStandardAtLeast(w);
        const lo = largestStandardAtMost(w);
        if (hi !== null) {
          expect(STD).toContain(hi);
          expect(hi).toBeLessThanOrEqual(MAX_IMAGE_WIDTH);
          expect(hi).toBeGreaterThanOrEqual(w);
        } else {
          expect(w).toBeGreaterThan(MAX_IMAGE_WIDTH);
        }
        if (lo !== null) {
          expect(STD).toContain(lo);
          expect(lo).toBeLessThanOrEqual(MAX_IMAGE_WIDTH);
          expect(lo).toBeLessThanOrEqual(w);
        }
      }),
      RUNS,
    );
    expect(smallestStandardAtLeast(Number.NaN)).toBeNull();
    expect(largestStandardAtMost(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
