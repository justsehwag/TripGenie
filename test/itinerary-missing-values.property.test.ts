// Feature: places-first-itinerary, Property 26: Missing values show the defined text, never a placeholder
// Validates: Requirements 6.8, 6.9, 12.4, 12.7, 12.8, 12.9, 12.10
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { StopMeta, StopPhoto, PriceCellNote, hoursLine } from "@/components/itinerary-parts";
import {
  NO_PRICE_TEXT,
  NO_TIP_TEXT,
  NO_BOOKING_TEXT,
  NO_BEST_TIME_TEXT,
  NOT_CHECKED_TEXT,
  HOURS_NOT_LISTED,
  TIP_LABEL,
  BOOKING_LABEL,
  BEST_TIME_LABEL,
  travelLabel,
} from "@/lib/itinerary/labels";
import { illustration } from "@/lib/illustrations";
import type { Activity, WebDetail } from "@/lib/types";

const PIN = illustration("location-pin");
const HOURS = "Monday: 9:00 AM – 5:00 PM";

const detailOf = (text: string): WebDetail => ({
  text,
  sourceUrl: "https://example.com/p",
  sourceHost: "example.com",
  checkedAt: "2026-05-01T10:00:00.000Z",
});

interface Spec {
  openingHours: boolean;
  hoursLabel: "Typical hours" | "Hours not listed" | undefined;
  photos: "undefined" | "empty" | "one" | "invalid";
  webDetails: "none" | "checked" | "unchecked";
  tip: boolean;
  booking: boolean;
  bestTime: boolean;
  webPrice: boolean;
  area: boolean;
  travel: boolean;
}

const specArb: fc.Arbitrary<Spec> = fc.record({
  openingHours: fc.boolean(),
  hoursLabel: fc.constantFrom<Spec["hoursLabel"]>("Typical hours", "Hours not listed", undefined),
  photos: fc.constantFrom<Spec["photos"]>("undefined", "empty", "one", "invalid"),
  webDetails: fc.constantFrom<Spec["webDetails"]>("none", "checked", "unchecked"),
  tip: fc.boolean(),
  booking: fc.boolean(),
  bestTime: fc.boolean(),
  webPrice: fc.boolean(),
  area: fc.boolean(),
  travel: fc.boolean(),
});

function build(s: Spec): Activity {
  const a: Activity = { time: "09:00", title: "Fort", description: "d", cost: 0 };
  if (s.openingHours) a.openingHours = HOURS;
  if (s.hoursLabel) a.hoursLabel = s.hoursLabel;
  if (s.photos === "empty") a.photos = [];
  if (s.photos === "one") a.photos = ["places/abc123/photos/def456"];
  if (s.photos === "invalid") a.photos = ["not a ref", "https://evil.example/x.jpg"];
  if (s.area) a.area = "Old Town";
  if (s.travel) a.travelToNextMin = 12;
  if (s.webPrice) {
    a.priceSource = "web";
    a.cost = 500;
    a.sourceUrl = "https://example.com/p";
    a.sourceHost = "example.com";
    a.checkedAt = "2026-05-01T10:00:00.000Z";
  }
  if (s.webDetails !== "none") {
    a.webDetails = {
      checked: s.webDetails === "checked",
      ...(s.tip ? { tip: detailOf("Go early") } : {}),
      ...(s.booking ? { booking: detailOf("Book online") } : {}),
      ...(s.bestTime ? { bestTime: detailOf("Morning") } : {}),
    };
  }
  return a;
}

const renderMeta = (a: Activity, hasNext: boolean) =>
  renderToStaticMarkup(createElement(StopMeta, { a, hasNext }));
const renderNote = (a: Activity) => renderToStaticMarkup(createElement(PriceCellNote, { a }));
const renderPhoto = (a: Activity) => renderToStaticMarkup(createElement(StopPhoto, { a }));

const textOf = (html: string) => html.replace(/<[^>]*>/g, "\u0001");
const assertNoPlaceholder = (html: string) => {
  const text = textOf(html);
  expect(text).not.toMatch(/undefined|null|NaN/);
  expect(html).not.toMatch(/=\"(undefined|null|NaN)\"/);
  expect(html).not.toMatch(/[?&]ref=(undefined|null)/);
  // A lone "0" as a value.
  expect(text).not.toMatch(/(^|\u0001)\s*0\s*(\u0001|$)/);
  expect(html).not.toMatch(/INR 0\b/);
  // Empty chip: an inner span/anchor/time with no content.
  expect(html).not.toMatch(/<(span|a|time)\s+class="(?!stop-meta")[^"]*"[^>]*><\/\1>/);
};

describe("Property 26: missing values show the defined text, never a placeholder", () => {
  it("hoursLine shows the defined text for every hours combination", () => {
    fc.assert(
      fc.property(specArb, (s) => {
        const a = build(s);
        const line = hoursLine(a);
        if (s.hoursLabel === "Hours not listed") expect(line).toBe(HOURS_NOT_LISTED);
        else if (s.openingHours) {
          expect(line).toBe(s.hoursLabel ? `Typical hours: ${HOURS}` : HOURS);
        } else expect(line).toBe("");
        expect(line).not.toMatch(/undefined|null|NaN/);
      }),
      { numRuns: 200 },
    );
  });

  it("StopMeta renders the exact missing-value text for each missing detail", () => {
    fc.assert(
      fc.property(specArb, fc.boolean(), (s, hasNext) => {
        const a = build(s);
        const html = renderMeta(a, hasNext);
        assertNoPlaceholder(html);

        const hl = hoursLine(a);
        if (hl) expect(html).toContain(hl);
        if (s.hoursLabel === "Hours not listed") expect(html).toContain(HOURS_NOT_LISTED);

        const kinds: Array<[boolean, string, string, string]> = [
          [s.tip, TIP_LABEL, NO_TIP_TEXT, "Go early"],
          [s.booking, BOOKING_LABEL, NO_BOOKING_TEXT, "Book online"],
          [s.bestTime, BEST_TIME_LABEL, NO_BEST_TIME_TEXT, "Morning"],
        ];
        for (const [present, label, missing, value] of kinds) {
          if (s.webDetails === "none") {
            expect(html).not.toContain(missing);
            expect(html).not.toContain(`${label}: ${NOT_CHECKED_TEXT}`);
          } else if (present) {
            expect(html).toContain(`${label}: ${value}`);
            expect(html).not.toContain(missing);
          } else if (s.webDetails === "checked") {
            expect(html).toContain(missing);
          } else {
            expect(html).toContain(`${label}: ${NOT_CHECKED_TEXT}`);
            expect(html).not.toContain(missing);
          }
        }
        if (hasNext && s.travel) expect(html).toContain("Next stop: ");
        else expect(html).not.toContain("Next stop");
      }),
      { numRuns: 300 },
    );
  });

  it("PriceCellNote shows the defined price text, or nothing", () => {
    fc.assert(
      fc.property(specArb, (s) => {
        const a = build(s);
        const html = renderNote(a);
        if (s.webDetails === "none" || s.webPrice) {
          expect(html).toBe("");
        } else {
          const expected = s.webDetails === "checked" ? NO_PRICE_TEXT : NOT_CHECKED_TEXT;
          expect(html).toBe(`<span class="price-cell__note">${expected}</span>`);
          assertNoPlaceholder(html);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("StopPhoto shows the Image_Fallback unless there is a valid first photo", () => {
    fc.assert(
      fc.property(specArb, (s) => {
        const a = build(s);
        const html = renderPhoto(a);
        assertNoPlaceholder(html);
        expect(html).not.toContain("/api/image");
        if (s.photos === "one") {
          expect(html).toContain("/api/place-photo?ref=places%2Fabc123%2Fphotos%2Fdef456");
          expect(html).toContain("Fort - Google photo");
        } else {
          expect(html).toContain(`src="${PIN.src}"`);
          expect(html).toContain('alt=""');
          expect(html).not.toContain("/api/place-photo");
        }
      }),
      { numRuns: 200 },
    );
  });

  it("legacy Stops (none of the new fields) render as before", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.boolean(), (area, travel, hasNext) => {
        const a: Activity = { time: "09:00", title: "Fort", description: "d", cost: 0 };
        if (area) a.area = "Old Town";
        if (travel) a.travelToNextMin = 12;
        const expected =
          '<span class="stop-meta">' +
          (area ? '<span class="stop-meta__area">Old Town</span>' : "") +
          (hasNext && travel ? `<span class="travel-estimate">Next stop: ${travelLabel(12)}</span>` : "") +
          "</span>";
        expect(renderMeta(a, hasNext)).toBe(expected);
        expect(renderNote(a)).toBe("");
        expect(hoursLine(a)).toBe("");
        // React 19 prepends a preload <link> for <img src>; the img itself is what matters.
        expect(renderPhoto(a).replace(/<link [^>]*>/g, "")).toBe(
          `<img src="${PIN.src}" alt="" width="${PIN.width}" height="${PIN.height}"/>`,
        );
      }),
      { numRuns: 100 },
    );
  });
});
