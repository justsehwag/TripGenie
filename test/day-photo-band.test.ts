/**
 * Bug condition exploration: day-photo-band.
 * Property 1: the Misc placeholder shimmer stays inside its box and runs only while loading.
 *
 * EXPECTED ON UNFIXED CODE: this test FAILS (failure confirms the bug).
 * Counterexamples observed on unfixed app/globals.css:
 *   - { state: "loading", reducedMotion: false|true }:
 *       effective overflow of ".misc-line[aria-busy=\"true\"] .misc-line__placeholder" falls back to
 *       ".misc-line__placeholder" and resolves to "visible" (summary-compact override, ~line 8783), not "hidden".
 *   - { state: "unavailable", reducedMotion: false|true } and { state: "none", ... }:
 *       ".misc-line__placeholder::after" content resolves to "\"\"" (~lines 8394-8403, animation
 *       skeleton-shimmer infinite) instead of "none", so the band keeps sweeping over the day photo.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

type Decl = Record<string, string>;
type Rule = { selectors: string[]; decls: Decl };

function stripComments(css: string): string {
  return css.replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");
}

function parseDecls(body: string): Decl {
  const out: Decl = {};
  for (const part of body.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/** Splits CSS into blocks { prelude, body } with brace matching. */
function blocks(css: string): { prelude: string; body: string }[] {
  const res: { prelude: string; body: string }[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open < 0) break;
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      j++;
    }
    res.push({ prelude: css.slice(i, open).trim(), body: css.slice(open + 1, j - 1) });
    i = j;
  }
  return res;
}

function toRules(css: string): Rule[] {
  return blocks(css)
    .filter((b) => !b.prelude.startsWith("@"))
    .map((b) => ({
      selectors: b.prelude.split(",").map((s) => s.trim()).filter(Boolean),
      decls: parseDecls(b.body),
    }));
}

function parse(css: string): { top: Rule[]; reduced: Rule[] } {
  const clean = stripComments(css);
  const top: Rule[] = [];
  const reduced: Rule[] = [];
  const rules = blocks(clean);
  for (const b of rules) {
    if (b.prelude.startsWith("@media")) {
      if (/prefers-reduced-motion\s*:\s*reduce/.test(b.prelude)) reduced.push(...toRules(b.body));
    } else if (!b.prelude.startsWith("@")) {
      top.push({
        selectors: b.prelude.split(",").map((s) => s.trim()).filter(Boolean),
        decls: parseDecls(b.body),
      });
    }
  }
  return { top, reduced };
}

function lastValue(rules: Rule[], selector: string, prop: string): string | undefined {
  let found: string | undefined;
  for (const r of rules) {
    if (r.selectors.includes(selector) && prop in r.decls) found = r.decls[prop];
  }
  return found;
}

const effective = (css: string, selector: string, prop: string) =>
  lastValue(parse(css).top, selector, prop);
const reducedMotionEffective = (css: string, selector: string, prop: string) =>
  lastValue(parse(css).reduced, selector, prop);

describe("css resolver fixtures", () => {
  const css = `
    /* c */ .a, .b { color: red; }
    .b { color: blue; }
    @media (prefers-reduced-motion: reduce) { .a { color: green; } }
    .c .a { color: pink; }
  `;
  it("last declaration wins", () => expect(effective(css, ".b", "color")).toBe("blue"));
  it("comma lists match exactly", () => {
    expect(effective(css, ".a", "color")).toBe("red");
    expect(effective(css, ".c .a", "color")).toBe("pink");
  });
  it("@media is excluded from top-level and exposed separately", () => {
    expect(effective(css, ".a", "color")).toBe("red");
    expect(reducedMotionEffective(css, ".a", "color")).toBe("green");
    expect(reducedMotionEffective(css, ".b", "color")).toBeUndefined();
  });
});

const css = readFileSync(path.join(__dirname, "..", "app", "globals.css"), "utf8");
const PLAIN = ".misc-line__placeholder";
const LOADING = '.misc-line[aria-busy="true"] .misc-line__placeholder';

const topWithFallback = (scope: string, plain: string, prop: string) =>
  effective(css, scope, prop) ?? effective(css, plain, prop);
const reducedWithFallback = (scope: string, plain: string, prop: string) =>
  reducedMotionEffective(css, scope, prop) ?? reducedMotionEffective(css, plain, prop);

describe("Property 1: Misc placeholder shimmer stays inside its box and only while loading", () => {
  it("holds for every placeholder state", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("loading", "unavailable", "none"),
        fc.boolean(),
        (state, reducedMotion) => {
          if (state === "loading") {
            expect(topWithFallback(LOADING, PLAIN, "overflow")).toBe("hidden");
            expect(topWithFallback(`${LOADING}::after`, `${PLAIN}::after`, "content")).not.toBe("none");
            if (reducedMotion) {
              expect(reducedWithFallback(`${LOADING}::after`, `${PLAIN}::after`, "animation")).toContain(
                "skeleton-pulse",
              );
              expect(reducedWithFallback(`${LOADING}::after`, `${PLAIN}::after`, "transform")).toBe("none");
            }
          } else {
            expect(effective(css, `${PLAIN}::after`, "content")).toBe("none");
          }
        },
      ),
    );
  });
});
