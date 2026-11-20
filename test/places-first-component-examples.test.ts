import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { StopMeta, StopPhoto } from "@/components/itinerary-parts";
import type { Activity } from "@/lib/types";

// Task 11.6: component example tests (Requirements 4.4, 4.5, 12.4, 12.11).

/** React 19 hoists <link rel="preload"> into the markup; drop it before comparing. */
const strip = (html: string) => html.replace(/<link\b[^>]*\brel="preload"[^>]*\/?>/g, "");

const oldStop: Activity = { time: "09:00", title: "Fort", description: "d", cost: 0, area: "Old Town" };

describe("places-first component examples (11.6)", () => {
  it("StopPhoto with 0 photos shows the illustration and no /api/image", () => {
    for (const a of [
      { ...oldStop, photos: [] },
      { ...oldStop },
    ] as Activity[]) {
      const html = strip(renderToStaticMarkup(createElement(StopPhoto, { a })));
      expect(html).toContain("<img");
      expect(html).not.toContain("/api/image");
      expect(html).not.toContain("/api/place-photo");
    }
  });

  it("StopPhoto onError swap is wired", () => {
    const src = readFileSync("components/itinerary-parts.tsx", "utf8");
    const start = src.indexOf("export function StopPhoto");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toMatch(/onError=\{\(\) => setFailedRef\(ref\)\}/);
    // After a failure the illustration is rendered instead of the photo.
    expect(body).toContain("LOCATION_PIN.src");
    expect(body).toMatch(/failedRef/);
  });

  it("StopMeta for an old stored Stop renders exactly what it rendered before", () => {
    const html = strip(renderToStaticMarkup(createElement(StopMeta, { a: oldStop, hasNext: false })));
    expect(html).toBe('<span class="stop-meta"><span class="stop-meta__area">Old Town</span></span>');
  });

  it("planner.tsx uses costUnit inr and keeps only the legacy startPricing call", () => {
    const src = readFileSync("components/planner.tsx", "utf8");
    expect(src).toContain('costUnit: "inr"');
    const calls = src.match(/(?<!function\s)\bstartPricing\(/g) ?? [];
    expect(calls.length).toBe(1);
    // The one remaining call belongs to the stored-itinerary path (costUnit !== "inr" branch).
    const at = src.indexOf("startPricing(it,");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(Math.max(0, at - 600), at)).toContain('shown.costUnit === "inr"');
  });
});
