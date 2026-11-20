import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { tokenEntries } from "@/lib/design-system";

/**
 * Static CSS examples for trip-planning-v2 (task 12.4).
 * Requirements: 5.2, 5.4, 5.6-5.10, 2.10, 12.14.
 */

const CSS = readFileSync(path.resolve(__dirname, "../app/globals.css"), "utf8")
  .replace(/\r\n?/g, "\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
  selectors: string[];
  body: string;
}

/** Flat leaf rules (also those nested inside @media), whitespace-normalised. */
function allRules(css: string): Rule[] {
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    out.push({
      selectors: m[1].split(",").map((s) => s.replace(/\s+/g, " ").trim()),
      body: m[2].replace(/\s+/g, " ").trim(),
    });
  }
  return out;
}

const RULES = allRules(CSS);

/** Bodies of every rule that lists the exact selector. */
function bodiesFor(selector: string): string[] {
  return RULES.filter((r) => r.selectors.includes(selector)).map((r) => r.body);
}

/** Brace-matched bodies of every `@media (max-width: 420px)` block. */
function media420Blocks(css: string): string[] {
  const blocks: string[] = [];
  const re = /@media\s*\(\s*max-width\s*:\s*420px\s*\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    blocks.push(css.slice(re.lastIndex, i - 1));
  }
  return blocks;
}

describe("history drawer action row CSS (Req 5)", () => {
  it("action row is a single non-wrapping flex line", () => {
    const bodies = bodiesFor(".history-drawer__actions");
    expect(bodies.some((b) => /flex-wrap:\s*nowrap/.test(b))).toBe(true);
    // The last declaration wins; the final rule must be nowrap.
    expect(bodies[bodies.length - 1]).toMatch(/flex-wrap:\s*nowrap/);
  });

  it("buttons and .cta in the row have margin: 0 and min-height: 44px", () => {
    for (const sel of [".history-drawer__actions > .btn", ".history-drawer__actions > .cta"]) {
      const bodies = bodiesFor(sel);
      expect(bodies.some((b) => /(^|;|\s)margin:\s*0(;|$)/.test(b)), `${sel} margin`).toBe(true);
      expect(bodies.some((b) => /min-height:\s*44px/.test(b)), `${sel} min-height`).toBe(true);
    }
  });

  it("has a max-width 420px block that targets the action row", () => {
    const blocks = media420Blocks(CSS);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.some((b) => b.includes(".history-drawer__actions"))).toBe(true);
  });

  it("hidden sizer: inactive label is hidden and both labels stack in one grid cell", () => {
    expect(bodiesFor('.history-drawer__label[data-active="false"]').some((b) => /visibility:\s*hidden/.test(b))).toBe(true);
    expect(
      bodiesFor('.history-drawer__actions [data-action="view"]').some((b) => /display:\s*inline-grid/.test(b)),
    ).toBe(true);
    expect(
      bodiesFor('.history-drawer__actions [data-action="view"] > .history-drawer__label').some((b) =>
        /grid-area:\s*1\s*\/\s*1/.test(b),
      ),
    ).toBe(true);
  });

  it("action buttons have a :focus-visible ring built from --focus-ring-* tokens", () => {
    for (const sel of [
      ".history-drawer__actions > .btn:focus-visible",
      ".history-drawer__actions > .cta:focus-visible",
    ]) {
      const bodies = bodiesFor(sel);
      expect(bodies.some((b) => /outline:[^;]*var\(--focus-ring-width\)/.test(b) && /var\(--focus-ring-color\)/.test(b)), sel).toBe(true);
    }
  });
});

describe("planner entry CSS (Req 2.10)", () => {
  it(".mode-toggle wraps and .quick-form exists as a single-column stack", () => {
    expect(bodiesFor(".mode-toggle").some((b) => /flex-wrap:\s*wrap/.test(b))).toBe(true);
    const qf = bodiesFor(".quick-form");
    expect(qf.length).toBeGreaterThan(0);
    expect(qf.some((b) => /flex-direction:\s*column/.test(b))).toBe(true);
  });
});

describe("flight / vendor blocks (Req 12.14)", () => {
  it("no fixed width wider than 320px in .flight-option* / .vendor-prices* rules", () => {
    const offenders: string[] = [];
    for (const r of RULES) {
      if (!r.selectors.some((s) => /\.(flight-option|vendor-prices)/.test(s))) continue;
      const re = /(?:^|[;\s])(min-)?width:\s*(\d+(?:\.\d+)?)px/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(r.body)) !== null) {
        if (Number(m[2]) > 320) offenders.push(`${r.selectors.join(", ")} { ${m[0].trim()} }`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the flight and vendor blocks exist", () => {
    expect(bodiesFor(".flight-option-list").length).toBeGreaterThan(0);
    expect(bodiesFor(".vendor-prices__row").length).toBeGreaterThan(0);
  });
});

describe("no new :root tokens (Req 5.10)", () => {
  /** Non-token helpers currently present in the :root block. */
  const HELPERS = [
    "--radius-sm", "--radius-md", "--radius-lg", "--radius-pill", "--radius-xl",
    "--shadow-sm", "--shadow-md", "--shadow-lg", "--shadow-xl",
    "--elevation-hover", "--ease-standard", "--ease-emphasis",
    "--anim-stagger-step", "--anim-reveal-shift",
    "--gradient-image-scrim", "--surface-editorial",
  ];

  it("has exactly one :root block whose custom properties equal tokenEntries() plus the helpers", () => {
    expect((CSS.match(/:root\s*\{/g) ?? []).length).toBe(1);
    const open = CSS.indexOf("{", CSS.indexOf(":root"));
    const close = CSS.indexOf("}", open);
    const body = CSS.slice(open + 1, close);
    const names = [...body.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)].map((m) => m[1]);
    expect(new Set(names).size).toBe(names.length);
    const expected = new Set([...tokenEntries().map((e) => e.cssVar), ...HELPERS]);
    expect(new Set(names)).toEqual(expected);
  });
});
