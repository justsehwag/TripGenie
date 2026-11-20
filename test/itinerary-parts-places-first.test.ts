import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { StopMeta, StopPhoto, PriceCellNote, safeText, hoursLine } from "@/components/itinerary-parts";
import type { Activity } from "@/lib/types";

const base: Activity = { time: "09:00", title: "Fort", description: "d", cost: 0 };
const BANNED = /confirmed|bookable|guaranteed|100% accurate/i;
const BAD_VALUES = /undefined|null|NaN|>0</;
const detail = (text: string) => ({
  text,
  sourceUrl: "https://example.com/p",
  sourceHost: "example.com",
  checkedAt: "2026-05-01T10:00:00.000Z",
});
const meta = (a: Activity) => renderToStaticMarkup(createElement(StopMeta, { a, hasNext: false }));

describe("itinerary-parts places-first fields", () => {
  it("renders a legacy stop without any new text", () => {
    const html = meta({ ...base, area: "Old Town" });
    expect(html).toBe('<span class="stop-meta"><span class="stop-meta__area">Old Town</span></span>');
  });

  it("builds the hours line", () => {
    expect(hoursLine({ hoursLabel: "Hours not listed" })).toBe("Hours not listed");
    expect(hoursLine({ hoursLabel: "Typical hours", openingHours: "Monday: 9:00 AM – 5:00 PM" }))
      .toBe("Typical hours: Monday: 9:00 AM – 5:00 PM");
    expect(hoursLine({ openingHours: "Monday: 9:00 AM – 5:00 PM" })).toBe("Monday: 9:00 AM – 5:00 PM");
    expect(hoursLine({})).toBe("");
    expect(hoursLine({ hoursLabel: "Typical hours" })).toBe("");
  });

  it("shows details with host and date, and the web estimate badge", () => {
    const html = meta({
      ...base,
      priceSource: "web",
      cost: 500,
      sourceUrl: "https://example.com/p",
      sourceHost: "example.com",
      checkedAt: "2026-05-01T10:00:00.000Z",
      openingHours: "Monday: 9:00 AM – 5:00 PM",
      hoursLabel: "Typical hours",
      webDetails: { checked: true, tip: detail("Go early"), booking: detail("Book online") },
    });
    expect(html).toContain("Typical hours: Monday");
    expect(html).toContain("Go early");
    expect(html).toContain("example.com");
    expect(html).toContain("checked ");
    expect(html).toContain("Web estimate");
    expect(html).toContain("No best time found online");
    expect(html).not.toMatch(BAD_VALUES);
  });

  it("shows Not checked for an unchecked stop and not-found texts for a checked one", () => {
    expect(meta({ ...base, webDetails: { checked: false } })).toContain("Not checked");
    const checked = meta({ ...base, webDetails: { checked: true } });
    expect(checked).toContain("No tip found online");
    expect(checked).toContain("No booking information found online");
    expect(checked).not.toContain("Not checked");
  });

  it("drops text that claims certainty", () => {
    expect(safeText("Guaranteed entry")).toBe("");
    expect(safeText("100% Accurate")).toBe("");
    const html = meta({
      ...base,
      area: "Bookable area",
      webDetails: { checked: true, tip: detail("It is confirmed open") },
    });
    expect(html).not.toMatch(BANNED);
    expect(html).toContain("No tip found online");
  });

  it("PriceCellNote follows webDetails.checked and ignores legacy and priced stops", () => {
    const render = (a: Activity) => renderToStaticMarkup(createElement(PriceCellNote, { a }));
    expect(render({ ...base, webDetails: { checked: true } })).toContain("No price found online");
    expect(render({ ...base, webDetails: { checked: false } })).toContain("Not checked");
    expect(render(base)).toBe("");
    expect(render({
      ...base, priceSource: "web", cost: 10, webDetails: { checked: true },
      sourceUrl: "https://example.com/p", sourceHost: "example.com", checkedAt: "2026-05-01T10:00:00.000Z",
    })).toBe("");
  });

  it("StopPhoto requests only the first Google photo and falls back to the illustration", () => {
    const render = (a: Activity) => renderToStaticMarkup(createElement(StopPhoto, { a }));
    const withPhotos = render({ ...base, photos: ["places/abc/photos/one", "places/abc/photos/two"] });
    expect(withPhotos).toContain("/api/place-photo?ref=");
    expect(withPhotos).toContain("w=160");
    expect(withPhotos).toContain('loading="lazy"');
    expect(withPhotos).not.toContain("two");
    const none = render({ ...base, photos: [] });
    expect(none).not.toContain("/api/place-photo");
    expect(none).not.toContain("/api/image");
    expect(none).toContain("<img");
  });

  it("keeps the onError photo fallbacks in the source", () => {
    const src = readFileSync("components/itinerary-parts.tsx", "utf8");
    expect(src.match(/onError=/g)?.length).toBeGreaterThanOrEqual(2);
    expect(src).not.toMatch(/\/api\/image|wikipedia/i);
  });
});
