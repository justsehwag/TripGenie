import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DayCarousel } from "../components/day-carousel";
import type { Slide } from "../lib/itinerary/carousel";

const SRC = readFileSync(join(__dirname, "..", "components", "day-carousel.tsx"), "utf8");

function slide(n: number): Slide {
  return { ref: `places/p${n}/photos/ref${n}`, name: `Place ${n}`, time: `0${n}:00` };
}

function render(slides: Slide[], active = true): string {
  return renderToStaticMarkup(createElement(DayCarousel, { slides, active }));
}

describe("DayCarousel markup", () => {
  it("renders a single slide without buttons or dots", () => {
    const html = render([slide(1)]);
    expect(html).toContain("/api/place-photo?ref=");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("day-carousel__dots");
    expect(html).toContain("gpm__brand");
  });

  it("renders previous, next, dots and aria attributes for 3 slides", () => {
    const html = render([slide(1), slide(2), slide(3)]);
    expect(html).toContain('aria-label="Previous photo"');
    expect(html).toContain('aria-label="Next photo"');
    expect((html.match(/class="day-carousel__dot"/g) ?? []).length).toBe(3);
    expect(html).not.toContain("day-carousel__dot-mark");
    expect(html).toContain('aria-roledescription="carousel"');
    expect(html).toContain('aria-roledescription="slide"');
    expect(html).toContain('aria-label="1 of 3"');
    expect(html).toContain('aria-live="off"');
    expect(html).toContain("Google</span>");
    expect(html).toContain("gpm__brand");
  });

  it("loads only the first photo", () => {
    const html = render([slide(1), slide(2), slide(3)]);
    // React 19 may also emit a preload <link> for the same image, so count <img> tags.
    expect((html.match(/<img /g) ?? []).length).toBe(1);
    expect(html).toContain("/api/place-photo?ref=");
    expect(html).toContain(encodeURIComponent("places/p1/photos/ref1"));
    expect(html).not.toContain(encodeURIComponent("places/p2/photos/ref2"));
  });

  it("renders the illustration with no controls for 0 slides", () => {
    const html = render([]);
    expect(html).toContain("day-hero__img--illustration");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("day-carousel__dots");
    expect(html).not.toContain("/api/place-photo");
  });
});

describe("DayCarousel source", () => {
  it("is a client component with cleanup and error handling", () => {
    expect(SRC.trimStart().startsWith('"use client"')).toBe(true);
    expect(SRC).toContain("clearTimeout");
    expect(SRC).toContain("removeEventListener");
    expect(SRC).toContain("onError");
  });
});
