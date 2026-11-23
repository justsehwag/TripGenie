import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import GamificationPanel from "@/components/gamification-panel";
import { awardMany, emptyXp } from "@/lib/gamification";

// Feature: summary-compact
// Validates: Requirements 1.4, 1.5, 2.2, 2.3, 3.1, 4.2, 5.3

const root = process.cwd();
const plannerSrc = readFileSync(join(root, "components", "planner.tsx"), "utf8");
const css = readFileSync(join(root, "app", "globals.css"), "utf8");

describe("summary-compact: pricing rows", () => {
  it("guards the Gross row by gross !== finalPayable", () => {
    const guard = "state.pricing.gross !== state.pricing.finalPayable";
    const guardIdx = plannerSrc.indexOf(guard);
    const grossIdx = plannerSrc.indexOf("<span>Gross</span>");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(grossIdx).toBeGreaterThan(guardIdx);
    // The guard block closes before the Final payable row.
    const finalIdx = plannerSrc.indexOf("Final payable");
    expect(finalIdx).toBeGreaterThan(grossIdx);
    const between = plannerSrc.slice(guardIdx, finalIdx);
    expect(between).toMatch(/\)\}/);
  });

  it("renders Final payable outside the Gross guard", () => {
    const finalIdx = plannerSrc.indexOf("Final payable");
    const lineStart = plannerSrc.lastIndexOf("\n", finalIdx) + 1;
    const line = plannerSrc.slice(lineStart, plannerSrc.indexOf("\n", finalIdx));
    expect(line).toContain("row--final");
    expect(line).not.toContain("&&");
    // Nearest preceding guard has been closed before this line.
    const before = plannerSrc.slice(plannerSrc.lastIndexOf("state.pricing.gross !== state.pricing.finalPayable"), lineStart);
    expect(before).toMatch(/^\s*\)\}\s*$/m);
  });
});

describe("summary-compact: XP panel", () => {
  const state = awardMany(emptyXp(), ["concierge_started", "route_set"]);

  it("compact renders xp-panel--compact with no Quests <details>", () => {
    const html = renderToStaticMarkup(createElement(GamificationPanel, { state, compact: true }));
    expect(html).toContain("xp-panel--compact");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("xp-quests");
  });

  it("default render has no xp-panel--compact", () => {
    const html = renderToStaticMarkup(createElement(GamificationPanel, { state }));
    expect(html).not.toContain("xp-panel--compact");
  });
});

describe("summary-compact: CSS block", () => {
  const idx = css.indexOf("summary-compact");
  const block = css.slice(idx);

  it("has the marker comment", () => {
    expect(idx).toBeGreaterThan(-1);
  });

  it("toolbar gap uses --space-md", () => {
    expect(block).toMatch(/\.timeline__actions\.planner-toolbar\s*\{[^}]*gap:\s*var\(--space-md\)/);
  });

  it("stop-row toggle has min-height 44px", () => {
    expect(block).toMatch(/\.stop-row__toggle\s*\{[^}]*min-height:\s*44px/);
  });
});
