import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StopMeta, PriceCellNote } from "@/components/itinerary-parts";
import { NOT_CHECKED_TEXT, NOT_CHECKED_UNAVAILABLE_TEXT } from "@/lib/itinerary/labels";
import type { Activity } from "@/lib/types";

const base: Activity = { time: "09:00", title: "Fort", description: "d", cost: 0 };
const strip = (html: string) => html.replace(/<link[^>]*rel="preload"[^>]*\/?>/g, "");
const meta = (a: Activity) => strip(renderToStaticMarkup(createElement(StopMeta, { a, hasNext: false })));
const note = (a: Activity) => strip(renderToStaticMarkup(createElement(PriceCellNote, { a })));
const count = (s: string, needle: string) => s.split(needle).length - 1;

describe("price lookup unavailable label", () => {
  it("StopMeta shows the unavailable text on all three lines", () => {
    const html = meta({ ...base, webDetails: { checked: false, unavailable: true } });
    expect(count(html, NOT_CHECKED_UNAVAILABLE_TEXT)).toBe(3);
  });

  it("StopMeta keeps plain Not checked without the flag", () => {
    const html = meta({ ...base, webDetails: { checked: false } });
    expect(count(html, `: ${NOT_CHECKED_TEXT}<`)).toBe(3);
    expect(html).not.toContain("price lookup unavailable");
  });

  it("PriceCellNote shows the unavailable text only when flagged", () => {
    expect(note({ ...base, webDetails: { checked: false, unavailable: true } })).toContain(NOT_CHECKED_UNAVAILABLE_TEXT);
    const plain = note({ ...base, webDetails: { checked: false } });
    expect(plain).toContain(NOT_CHECKED_TEXT);
    expect(plain).not.toContain("unavailable");
  });

  it("a checked stop never shows the unavailable text", () => {
    const a: Activity = { ...base, webDetails: { checked: true } };
    expect(note(a)).not.toContain("unavailable");
    expect(meta(a)).not.toContain("unavailable");
  });
});
