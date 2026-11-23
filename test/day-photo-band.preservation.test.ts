// Preservation tests for the day-photo-band bugfix (observed on UNFIXED code, must pass before and after).
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import fc from "fast-check";

import { DayCarousel } from "../components/day-carousel";
import { MiscLine } from "../components/misc-line";
import { ROTATION_INTERVAL_MS, shouldRotate, stepIndex, type Slide } from "../lib/itinerary/carousel";
import { MISC_NONE_TEXT, MISC_UNAVAILABLE_TEXT, MISC_WEB_TITLE } from "../lib/itinerary/misc-estimate-shared";
import type { MiscEntry } from "../components/use-misc-estimate";
import type { TripDay } from "../lib/types";

const RUNS = { numRuns: 50 };
const CSS_PATH = join(__dirname, "..", "app", "globals.css");
const BYTES = readFileSync(CSS_PATH);
const CSS = BYTES.toString("utf8").replace(/\r\n/g, "\n");

// Observed on unfixed code (before the append-only fix).
const ORIGINAL_LENGTH = 379401;
const ORIGINAL_SHA256 = "eaac2f824b79de7157ea208e260499f9c5194f3b7c9686334a8442e8e8c49fd4";

function slides(n: number): Slide[] {
  return Array.from({ length: n }, (_, i) => ({
    ref: `places/p${i}/photos/ref${i}`,
    name: `Place ${i}`,
    time: i % 2 === 0 ? `0${i % 10}:00` : "",
  }));
}
const render = (s: Slide[]) => renderToStaticMarkup(createElement(DayCarousel, { slides: s, active: true }));

describe("carousel rotation helpers", () => {
  it("stepIndex stays in range and wraps", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 12 }), fc.integer({ min: -50, max: 50 }), fc.constantFrom<1 | -1>(1, -1), (count, index, dir) => {
        const r = stepIndex(index, count, dir);
        if (count === 0) return r === 0;
        return r >= 0 && r < count && r === (((index + dir) % count) + count) % count;
      }),
      RUNS,
    );
  });

  it("shouldRotate only when count >= 2 and no pause flag", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 12 }),
        fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(),
        (count, hovered, focused, hidden, reducedMotion, active) => {
          const expected = count >= 2 && !hovered && !focused && !hidden && !reducedMotion && active;
          return shouldRotate({ count, hovered, focused, hidden, reducedMotion, active }) === expected;
        },
      ),
      RUNS,
    );
  });

  it("ROTATION_INTERVAL_MS is 5000", () => {
    expect(ROTATION_INTERVAL_MS).toBe(5000);
  });
});

describe("DayCarousel markup", () => {
  it("dots, buttons and aria labels for 2..8 slides", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 8 }), (n) => {
        const html = render(slides(n));
        const dots = html.match(/<button[^>]*day-carousel__dot[^>]*>/g) ?? [];
        expect(dots.length).toBe(n);
        expect((html.match(/aria-current="true"/g) ?? []).length).toBe(1);
        expect(html).toContain('aria-label="Previous photo"');
        expect(html).toContain('aria-label="Next photo"');
        expect(html).toContain(`aria-label="1 of ${n}"`);
      }),
      { numRuns: 7 },
    );
  });

  it("caption, time and Google brand", () => {
    const html = render(slides(3));
    expect(html).toContain("day-carousel__name");
    expect(html).toContain("Place 0");
    expect(html).toContain("day-carousel__time");
    expect(html).toContain("gpm__brand");
    expect(html).toContain("Google");
    const noTime = render([{ ref: "places/p/photos/r", name: "Solo", time: "" }]);
    expect(noTime).not.toContain("day-carousel__time");
  });

  it("one slide has no buttons, zero slides show the illustration", () => {
    expect(render(slides(1))).not.toContain("<button");
    expect(render([])).toContain("day-hero__img--illustration");
  });
});

describe("carousel and layout CSS", () => {
  it("keeps collapsed hiding and grid placement rules verbatim", () => {
    expect(CSS).toContain(".planner-day.is-collapsed > .day-carousel { display: none; }");
    expect(CSS).toContain(
      ".planner-day.timeline__card > .day-carousel { grid-row: 1 / span 30; align-self: stretch; width: 100%; height: auto; min-height: 0; aspect-ratio: auto; }",
    );
    expect(CSS).toContain(
      "@media (max-width: 1023px) { .planner-day.timeline__card > .day-carousel { grid-row: auto; height: auto; min-height: 200px; aspect-ratio: 16 / 9; } }",
    );
  });

  it("keeps 44px button and dot targets", () => {
    for (const sel of [".day-carousel__btn", ".day-carousel__dot"]) {
      const i = CSS.indexOf(sel + " {");
      expect(i).toBeGreaterThan(-1);
      const body = CSS.slice(i, CSS.indexOf("}", i));
      expect(body).toMatch(/44px/);
    }
  });
});

describe("MiscLine markup", () => {
  const day = { activities: [{ name: "A" }] } as unknown as TripDay;
  const item = { label: "Parking", amountInr: 100, sourceUrl: "https://x.test/a", sourceHost: "x.test", checkedAt: "2025-01-01T00:00:00Z" };
  const entry: fc.Arbitrary<MiscEntry | undefined> = fc.oneof(
    fc.constant(undefined),
    fc.constant("loading" as const),
    fc.constant({ status: "unavailable" as const }),
    fc.array(fc.string({ maxLength: 8 }), { maxLength: 3 }).map((missing) => ({ status: "none" as const, missing })),
    fc.tuple(fc.integer({ min: 0, max: 99999 }), fc.array(fc.string({ maxLength: 8 }), { maxLength: 3 })).map(([sumInr, missing]) => ({
      status: "ok" as const,
      items: [item],
      sumInr,
      missing,
    })),
  );

  it("renders the observed markup per state", () => {
    fc.assert(
      fc.property(entry, (r) => {
        const html = renderToStaticMarkup(createElement(MiscLine, { day, result: r }));
        expect(html).toContain(MISC_WEB_TITLE);
        const busy = r === undefined || r === "loading";
        expect(html.includes('aria-busy="true"')).toBe(busy);
        if (busy) {
          expect(html).toContain('<span class="misc-line__placeholder" aria-hidden="true">…</span>');
        } else if (r.status === "unavailable") {
          expect(html).toContain(`<span class="misc-line__placeholder">${MISC_UNAVAILABLE_TEXT}</span>`);
        } else if (r.status === "none") {
          expect(html).toContain("misc-line__placeholder");
          expect(html).toContain(MISC_NONE_TEXT);
        } else {
          expect(html).not.toContain("misc-line__placeholder");
          expect(html).toContain("misc-line__sum");
          expect(html).toContain("misc-line__not-in-total");
        }
        if (!busy && r.status !== "unavailable" && (r.status === "ok" || r.missing.length > 0)) {
          expect(html).toContain('aria-expanded="false"');
          expect(html).toContain(">Details<");
          expect(html).not.toContain("misc-line__detail");
        }
      }),
      RUNS,
    );
  });
});

describe("other shimmers and file integrity", () => {
  it("other shimmers keep their declarations", () => {
    const block = CSS.slice(CSS.indexOf(".skeleton__block::after {"));
    expect(block.slice(0, block.indexOf("}"))).toContain("animation: skeleton-shimmer 1.4s ease-in-out infinite;");
    expect(CSS).toContain("@keyframes skeleton-shimmer { 100% { transform: translateX(100%); } }");
    expect(CSS).toContain("@keyframes skeleton-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 0.7; } }");
    const chat = CSS.slice(CSS.indexOf(".chat-skeleton__line {"));
    expect(chat.slice(0, chat.indexOf("}"))).toContain("animation: chat-shimmer 1.1s var(--ease-standard) infinite;");
    const bar = CSS.slice(CSS.indexOf(".trip-assistant__pending-bar {"));
    expect(bar.slice(0, bar.indexOf("}"))).toContain("animation: trip-assistant-shimmer 1.4s linear infinite;");
    expect(CSS).toContain(".trip-assistant__pending-bar::after { display: none; }");
  });

  it("globals.css has no bare LF", () => {
    expect(BYTES.toString("utf8").replace(/\r\n/g, "").includes("\n")).toBe(false);
  });

  it("original content is an unchanged prefix", () => {
    expect(BYTES.length).toBeGreaterThanOrEqual(ORIGINAL_LENGTH);
    const prefix = BYTES.subarray(0, ORIGINAL_LENGTH);
    expect(createHash("sha256").update(prefix).digest("hex")).toBe(ORIGINAL_SHA256);
  });

  it("adds no :root custom property after the original content", () => {
    const tail = BYTES.subarray(ORIGINAL_LENGTH).toString("utf8");
    expect(tail).not.toMatch(/:root/);
    expect(tail).not.toMatch(/^\s*--[\w-]+\s*:/m);
  });
});
