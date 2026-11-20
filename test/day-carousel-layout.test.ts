import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const planner = readFileSync(join(root, "components", "planner.tsx"), "utf8");
const css = readFileSync(join(root, "app", "globals.css"), "utf8");

describe("planner.tsx wiring (day-carousel-layout)", () => {
  it("no longer references StopPhoto or day-toggle__thumb (Req 1.2)", () => {
    expect(planner).not.toContain("StopPhoto");
    expect(planner).not.toContain("day-toggle__thumb");
  });

  it("imports DayCarousel exactly once and renders it once (Req 1.1)", () => {
    const imports = planner.match(/import\s*\{[^}]*\bDayCarousel\b[^}]*\}\s*from/g) ?? [];
    expect(imports).toHaveLength(1);
    expect(planner.match(/<DayCarousel\b/g) ?? []).toHaveLength(1);
  });

  it("uses the stop-row layout classes", () => {
    expect(planner).toContain("stop-row__time");
    expect(planner).toContain("stop-row__price");
    expect(planner).toContain("price-group");
  });

  it.each(["Price basis", "per person", "per group"])(
    "keeps honest-label string %j (Req 5.1)",
    (label) => {
      expect(planner).toContain(label);
    },
  );
});

describe("globals.css new rules (day-carousel-layout)", () => {
  it.each([".day-carousel", ".stop-row", ".stop-row__time", ".stop-row__price", ".price-group"])(
    "defines selector %s",
    (sel) => {
      const escaped = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(css).toMatch(new RegExp(`${escaped}\\s*[{,:\\s]`));
    },
  );

  it("has a 768px side-by-side breakpoint and an 11rem price column (Req 4.1, 4.5)", () => {
    expect(css).toContain("@media (min-width: 768px)");
    expect(css).toContain("11rem");
    expect(css).toMatch(/\.stop-row\s*\{[^}]*minmax\(11rem/);
  });

  it("gives carousel controls a 44px size (Req 2.13)", () => {
    const btn = css.match(/\.day-carousel__btn\s*\{[^}]*\}/)?.[0] ?? "";
    expect(btn).toMatch(/min-width:\s*44px/);
    expect(btn).toMatch(/min-height:\s*44px/);
    const dot = css.match(/\.day-carousel__dot\s*\{[^}]*\}/)?.[0] ?? "";
    expect(dot).toMatch(/min-width:\s*44px/);
    expect(dot).toMatch(/min-height:\s*44px/);
  });

  it("has :focus-visible rings for carousel controls (Req 6.2)", () => {
    expect(css).toMatch(/\.day-carousel__btn:focus-visible/);
    expect(css).toMatch(/\.day-carousel__dot:focus-visible/);
  });

  it("disables carousel transitions under reduced motion (Req 6.3)", () => {
    const m = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.day-carousel__img[^}]*\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/\.day-carousel__btn/);
    expect(m![0]).toMatch(/transition:\s*none/);
  });
});
