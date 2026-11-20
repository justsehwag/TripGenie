import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { StopMeta } from "@/components/itinerary-parts";
import { StopDetails } from "@/components/stop-details";
import { isStopOpen, stopKey, toggleStop, type StopOpenMap } from "@/lib/itinerary/stop-expand";
import { toastForSave, saveFingerprint, shouldSkipSave } from "@/lib/save-feedback";
import type { Activity } from "@/lib/types";

// Feature: itinerary-layout-refresh
// Validates: Requirements 1.1, 1.4, 1.5, 1.8, 1.9, 2.1, 2.8, 3.3, 3.4, 3.7, 3.10

describe("stops collapsed by default and toggle independence", () => {
  it("isStopOpen of an empty map is false for any key", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 60 }), fc.integer({ min: 0, max: 60 }), (d, i) => {
        expect(isStopOpen({}, stopKey(d, i))).toBe(false);
      }),
      { numRuns: 100 },
    );
    expect(isStopOpen({}, stopKey(1, 0))).toBe(false);
    expect(isStopOpen({}, "anything")).toBe(false);
  });

  it("toggling changes only that key and twice restores it", () => {
    const keyArb = fc.tuple(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 5 })).map(([d, i]) => stopKey(d, i));
    fc.assert(
      fc.property(fc.dictionary(keyArb, fc.boolean()), keyArb, (m, k) => {
        const once = toggleStop(m as StopOpenMap, k);
        expect(isStopOpen(once, k)).toBe(!isStopOpen(m, k));
        for (const other of new Set([...Object.keys(m), ...Object.keys(once)])) {
          if (other !== k) expect(isStopOpen(once, other)).toBe(isStopOpen(m, other));
        }
        const twice = toggleStop(once, k);
        for (const any of new Set([...Object.keys(m), ...Object.keys(twice), k])) {
          expect(isStopOpen(twice, any)).toBe(isStopOpen(m, any));
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe("expanded details keep all honest labels", () => {
  const base: Activity = { time: "09:00", title: "Fort", description: "d", cost: 0 };
  const detail = (text: string) => ({
    text,
    sourceUrl: "https://example.com/p",
    sourceHost: "example.com",
    checkedAt: "2026-05-01T10:00:00.000Z",
  });
  const verified: Activity = {
    ...base,
    verified: true,
    placeId: "p1",
    mapsUrl: "https://www.google.com/maps/place/?q=place_id:p1",
  };
  const webEstimate: Activity = {
    ...base,
    priceSource: "web",
    cost: 500,
    sourceUrl: "https://example.com/p",
    sourceHost: "example.com",
    checkedAt: "2026-05-01T10:00:00.000Z",
    webDetails: { checked: true, tip: detail("Go early") },
  };
  const checkedEmpty: Activity = { ...base, webDetails: { checked: true } };
  const fixtures: Array<{ name: string; a: Activity; labels: string[] }> = [
    { name: "verified", a: verified, labels: ["Verified on Google Maps"] },
    { name: "web estimate", a: webEstimate, labels: ["Web estimate", "No booking information found online", "No best time found online"] },
    {
      name: "checked, nothing found",
      a: checkedEmpty,
      labels: ["No tip found online", "No booking information found online", "No best time found online"],
    },
    { name: "legacy", a: { ...base, area: "Old Town" }, labels: [] },
  ];
  const ALL = [
    "Verified on Google Maps",
    "Web estimate",
    "No tip found online",
    "No booking information found online",
    "No best time found online",
  ];

  for (const f of fixtures) {
    for (const open of [true, false]) {
      it(`${f.name}, ${open ? "open" : "closed"}: wrapped markup keeps StopMeta and labels`, () => {
        const alone = renderToStaticMarkup(createElement(StopMeta, { a: f.a, hasNext: false }));
        const wrapped = renderToStaticMarkup(
          createElement(StopDetails, {
            id: "stop-details-1-0",
            open,
            children: createElement(StopMeta, { a: f.a, hasNext: false }),
          }),
        );
        expect(wrapped).toContain(alone);
        expect(wrapped).toContain('id="stop-details-1-0"');
        expect(/\shidden(=|\s|>)/.test(wrapped.slice(0, wrapped.indexOf(">") + 1))).toBe(!open);
        for (const label of ALL) {
          expect(wrapped.includes(label)).toBe(f.labels.includes(label));
          expect(wrapped.includes(label)).toBe(alone.includes(label));
        }
      });
    }
  }

  it("legacy fixtures render labels only in StopMeta (all five covered above)", () => {
    const covered = new Set(fixtures.flatMap((f) => f.labels));
    for (const label of ALL) expect(covered.has(label)).toBe(true);
  });
});

describe("save outcome to toast mapping", () => {
  it("maps each outcome", () => {
    expect(toastForSave(0, { kind: "saved", scope: "account" })).toMatchObject({ kind: "success", message: "Trip saved. Find it under My trips." });
    const dev = toastForSave(0, { kind: "saved", scope: "device" });
    expect(dev.kind).toBe("success");
    expect(dev.message).toContain("Saved on this device");
    expect(toastForSave(0, { kind: "unchanged" })).toMatchObject({ kind: "info", message: "Already saved" });
    const withReason = toastForSave(0, { kind: "failed", reason: "Sign in to save this trip" });
    expect(withReason.kind).toBe("error");
    expect(withReason.message).toContain("Sign in to save this trip");
    expect(withReason.message.toLowerCase()).toContain("try again");
    const noReason = toastForSave(0, { kind: "failed" });
    expect(noReason.kind).toBe("error");
    expect(noReason.message.toLowerCase()).toContain("try again");
  });

  it("id is prevId + 1 and failures are never success", () => {
    const outcome = fc.oneof(
      fc.constant({ kind: "saved", scope: "account" } as const),
      fc.constant({ kind: "saved", scope: "device" } as const),
      fc.constant({ kind: "unchanged" } as const),
      fc.record({ kind: fc.constant("failed" as const), reason: fc.option(fc.string(), { nil: undefined }) }),
    );
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100000 }), outcome, (prev, o) => {
        const t = toastForSave(prev, o);
        expect(t.id).toBe(prev + 1);
        expect(t.message.length).toBeGreaterThan(0);
        if (o.kind === "failed") {
          expect(t.kind).toBe("error");
          expect(t.message.toLowerCase()).toContain("try again");
        }
      }),
      { numRuns: 100 },
    );
  });

  it("unchanged itinerary skips with Already saved; an edit saves for real", () => {
    const trip = { name: "Goa", status: "ready", itinerary: { days: [{ day: 1, activities: [{ title: "Fort", cost: 0 }] }] } };
    const fp1 = saveFingerprint(trip);
    let last: string | null = null;
    expect(shouldSkipSave(last, fp1)).toBe(false);
    last = fp1;
    const again = saveFingerprint(JSON.parse(JSON.stringify(trip)));
    expect(shouldSkipSave(last, again)).toBe(true);
    expect(toastForSave(1, { kind: "unchanged" }).message).toBe("Already saved");
    const edited = saveFingerprint({ ...trip, itinerary: { days: [{ day: 1, activities: [{ title: "Beach", cost: 0 }] }] } });
    expect(shouldSkipSave(last, edited)).toBe(false);
  });
});

describe("summary before day list (planner source)", () => {
  const src = readFileSync("components/planner.tsx", "utf8");
  it("puts the summary above the day list and keeps labels", () => {
    const s = src.indexOf("planner-summary");
    const ol = src.indexOf('<ol className="timeline planner-itinerary">');
    expect(s).toBeGreaterThan(-1);
    expect(ol).toBeGreaterThan(-1);
    expect(s).toBeLessThan(ol);
    expect(src).toContain("Final payable");
    expect(src).toContain("Stay");
    expect(src).toContain("Gross");
  });
  it("has one DayCarousel, no StopPhoto, no planner-save-msg", () => {
    expect(src.match(/<DayCarousel/g)?.length).toBe(1);
    expect(src).not.toContain("StopPhoto");
    expect(src).not.toContain("planner-save-msg");
  });
});
