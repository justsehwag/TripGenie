import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fc from "fast-check";
import * as labels from "@/lib/itinerary/labels";
import { StopMeta, PriceCellNote } from "@/components/itinerary-parts";
import type { Activity } from "@/lib/types";

// Feature: places-first-itinerary, Property 25: Labels never claim certainty and prices say "estimate"
// **Validates: Requirements 6.10, 12.5, 12.6**

const BANNED = /confirmed|bookable|guaranteed|100% accurate/i;
const WORDS = ["confirmed", "bookable", "guaranteed", "100% accurate"];

const caseMix = (w: string) =>
  fc.array(fc.boolean(), { minLength: w.length, maxLength: w.length }).map((bits) =>
    w.split("").map((c, i) => (bits[i] ? c.toUpperCase() : c.toLowerCase())).join(""),
  );

/** Free text that may embed a banned phrase in any case. */
const adversarialText = fc
  .tuple(fc.string({ maxLength: 20 }), fc.constantFrom(...WORDS).chain(caseMix), fc.string({ maxLength: 20 }), fc.boolean())
  .map(([a, w, b, embed]) => (embed ? `${a} ${w} ${b}` : `${a}${b}`));

/** Hostname-shaped text that may embed a banned word. */
const adversarialHost = fc
  .tuple(
    fc.stringMatching(/^[a-z0-9]{1,8}$/),
    fc.constantFrom("confirmed", "bookable", "guaranteed").chain(caseMix),
    fc.boolean(),
  )
  .map(([a, w, embed]) => (embed ? `${w}.${a}.com` : `${a}.com`));

const isoDate = fc
  .date({ min: new Date("2020-01-01T00:00:00Z"), max: new Date("2035-01-01T00:00:00Z"), noInvalidDate: true })
  .map((d) => d.toISOString());

const detail = fc.option(
  fc.record({ text: adversarialText, sourceHost: adversarialHost, checkedAt: isoDate }).map((d) => ({
    ...d,
    sourceUrl: "https://example.com/page",
  })),
  { nil: undefined },
);

const activity: fc.Arbitrary<Activity> = fc.record({
  title: adversarialText,
  placeName: fc.option(adversarialText, { nil: undefined }),
  area: fc.option(adversarialText, { nil: undefined }),
  openingHours: fc.option(adversarialText, { nil: undefined }),
  hoursLabel: fc.option(fc.constantFrom("Typical hours" as const, "Hours not listed" as const), { nil: undefined }),
  priced: fc.boolean(),
  verified: fc.boolean(),
  sourceHost: adversarialHost,
  checkedAt: isoDate,
  checked: fc.boolean(),
  tip: detail,
  booking: detail,
  bestTime: detail,
  travel: fc.option(fc.integer({ min: 0, max: 600 }), { nil: undefined }),
}).map((r): Activity => ({
  time: "09:00",
  title: r.title,
  description: "d",
  cost: r.priced ? 500 : 0,
  ...(r.priced
    ? { priceSource: "web" as const, sourceUrl: "https://example.com/price", sourceHost: r.sourceHost, checkedAt: r.checkedAt }
    : {}),
  placeName: r.placeName,
  area: r.area,
  openingHours: r.openingHours,
  hoursLabel: r.hoursLabel,
  ...(r.verified
    ? { verified: true as const, placeId: "abc", mapsUrl: "https://www.google.com/maps/search/?api=1&query=x" }
    : {}),
  travelToNextMin: r.travel,
  webDetails: { checked: r.checked, tip: r.tip, booking: r.booking, bestTime: r.bestTime },
}));

const stopMeta = (a: Activity, hasNext: boolean) => renderToStaticMarkup(createElement(StopMeta, { a, hasNext }));
const priceNote = (a: Activity) => renderToStaticMarkup(createElement(PriceCellNote, { a }));

describe("Property 25: honest labels", () => {
  it("every string exported by labels.ts, constant or produced from adversarial input, avoids certainty words", () => {
    const fns = Object.entries(labels).filter(([, v]) => typeof v === "function") as [string, (...args: unknown[]) => unknown][];
    const consts = Object.entries(labels).filter(([, v]) => typeof v === "string") as [string, string][];
    expect(consts.length).toBeGreaterThan(5);
    expect(fns.length).toBeGreaterThan(5);
    for (const [name, value] of consts) expect(value, name).not.toMatch(BANNED);

    fc.assert(
      fc.property(
        adversarialText,
        fc.integer({ min: -5, max: 40 }),
        fc.integer({ min: -5, max: 40 }),
        fc.constantFrom("ai", "estimated", "web", "x"),
        fc.boolean(),
        (text, n, m, source, hasWeb) => {
          const argSets: unknown[][] = [
            [text], [n], [n, m], [text, n, m], [source], ["verifying", n, m], ["added", n, m], ["withheld", n, m],
            [{ priceSource: source, webDetails: hasWeb ? { checked: true } : undefined }],
            [n, m, n], [null], [undefined],
          ];
          for (const [name, fn] of fns) {
            for (const args of argSets) {
              let out: unknown;
              try {
                out = fn(...args);
              } catch {
                continue;
              }
              if (typeof out === "string") {
                expect(out, `${name}(${JSON.stringify(args)})`).not.toMatch(BANNED);
              }
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("StopMeta and PriceCellNote markup never contains certainty words", () => {
    fc.assert(
      fc.property(activity, fc.boolean(), (a, hasNext) => {
        expect(stopMeta(a, hasNext)).not.toMatch(BANNED);
        expect(priceNote(a)).not.toMatch(BANNED);
      }),
      { numRuns: 200 },
    );
  });

  it("every shown price says estimate and carries its source host", () => {
    fc.assert(
      fc.property(activity, (a) => {
        const html = stopMeta(a, false);
        const badge = html.match(/<span class="price-badge[^"]*">([^<]*)<\/span>/);
        const shownHost = !!a.sourceHost && !BANNED.test(a.sourceHost);
        if (a.priceSource === "web" && shownHost) {
          expect(badge, "price badge").not.toBeNull();
          expect(badge![1]).toMatch(/estimate/i);
          expect(html).toContain(`>${a.sourceHost}</a>`);
          expect(html).toMatch(/checked /);
        } else {
          expect(badge).toBeNull();
        }
      }),
      { numRuns: 200 },
    );
  });

  it("price badge text from labels.ts always says estimate for places-first stops", () => {
    fc.assert(
      fc.property(fc.constantFrom("ai", "estimated", "web", undefined), (source) => {
        expect(labels.priceBadgeText({ priceSource: source, webDetails: { checked: true } })).toMatch(/estimate/i);
      }),
      { numRuns: 100 },
    );
  });
});
