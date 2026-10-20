import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Responsive / overflow STATIC assertions over app/globals.css (ui-redesign
 * spec, task 21.1).
 *
 * SCOPE & LIMITATION — READ FIRST:
 * These are static, mechanism-presence assertions over the stylesheet TEXT.
 * They prove the CSS *mechanisms* that back the responsive guarantees of
 * Requirement 19 are present (single-column stacking at <=1023px, fluid grid
 * tracks that never force a fixed width wider than the viewport, overflow
 * safety on media + long strings, 44px touch targets, and a >=16px serif
 * heading floor).
 *
 * They do NOT — and cannot — verify true PIXEL-LEVEL behavior. Confirming that
 * nothing produces horizontal overflow and that every interactive control
 * actually computes to >=44x44 CSS px at 320px / 768px / 1023px requires a
 * real browser (layout + computed-style engine). That is a MANUAL / visual QA
 * step, tracked by task 22 (full redesign validation). These static checks are
 * the automatable half: if a mechanism goes missing here, the manual pass is
 * guaranteed to regress, so this suite is an early tripwire.
 *
 * The CSS is read live from disk at test time so the assertions reflect the
 * current stylesheet. Regexes are intentionally whitespace-tolerant and
 * case-insensitive where sensible so they assert the mechanism, not formatting.
 */

const GLOBALS_CSS_PATH = path.resolve(__dirname, "../app/globals.css");
const CSS = readFileSync(GLOBALS_CSS_PATH, "utf8");

/** Collapse runs of whitespace to a single space for robust substring checks. */
const FLAT = CSS.replace(/\s+/g, " ");

/**
 * Extract the body of every `@media (max-width: 1023px)` block (optional
 * decimals, optional "px") via brace-matching, so we can assert declarations
 * that live *inside* the tablet/mobile band rather than anywhere in the file.
 */
function extractMediaBlocks(css: string, re: RegExp): string[] {
  const bodies: string[] = [];
  let search = 0;
  // Re-anchor a fresh global regex each pass so lastIndex handling is simple.
  const finder = new RegExp(re.source, "gi");
  finder.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = finder.exec(css)) !== null) {
    const open = css.indexOf("{", m.index + m[0].length - 1);
    if (open === -1) break;
    let depth = 0;
    let close = -1;
    for (let i = open; i < css.length; i++) {
      const ch = css[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) break;
    bodies.push(css.slice(open + 1, close));
    search = close + 1;
    finder.lastIndex = search;
  }
  return bodies;
}

/** Matches `@media (max-width: 1023px)` tolerating decimals and optional px. */
const TABLET_MEDIA_RE = /@media\s*\(\s*max-width\s*:\s*1023(?:\.\d+)?(?:px)?\s*\)/i;

describe("Feature: ui-redesign, Property: responsive CSS guarantees (Req 19.2/19.3/19.5)", () => {
  // ── 1. Single-column stacking at <=1023px (Req 19.2) ──────────────────────
  // Feature: ui-redesign, Property: responsive CSS guarantees (Req 19.2/19.3/19.5)
  it("stacks multi-column layouts into a single column at <=1023px", () => {
    // The tablet/mobile breakpoint exists.
    expect(TABLET_MEDIA_RE.test(CSS)).toBe(true);

    // At least one <=1023px block collapses tracks to a single column: its body
    // contains a `grid-template-columns: 1fr` declaration (whitespace-tolerant).
    const tabletBodies = extractMediaBlocks(CSS, TABLET_MEDIA_RE);
    expect(tabletBodies.length).toBeGreaterThan(0);

    const singleColDecl = /grid-template-columns\s*:\s*1fr\s*;/i;
    const stacksToOneColumn = tabletBodies.some((body) => singleColDecl.test(body));
    expect(stacksToOneColumn).toBe(true);
  });

  // ── 2. Fluid grid tracks — no fixed width forced past the viewport (Req 19.5)
  // Feature: ui-redesign, Property: responsive CSS guarantees (Req 19.2/19.3/19.5)
  it("defines fluid grid tracks with minmax(min(100%, …)) so no track forces a fixed width wider than the viewport", () => {
    // `minmax(min(100%, …)` guarantees each track caps at the container width.
    const fluidTrack = /minmax\(\s*min\(\s*100%/i;
    expect(fluidTrack.test(FLAT)).toBe(true);

    // Several card/offer/recent grids use the pattern — assert >=1 (robust) and
    // report the count for confidence.
    const occurrences = (FLAT.match(/minmax\(\s*min\(\s*100%/gi) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(1);
  });

  // ── 3. Overflow safety on media + long strings (Req 19.5) ─────────────────
  // Feature: ui-redesign, Property: responsive CSS guarantees (Req 19.2/19.3/19.5)
  it("caps media at max-width: 100% and wraps long strings to prevent horizontal overflow", () => {
    // Media elements never exceed the viewport width.
    const mediaCapped = /max-width\s*:\s*100%/i;
    expect(mediaCapped.test(FLAT)).toBe(true);

    // An explicit img rule carries the cap (belt-and-braces alongside .illustration).
    const imgCapped = /img[^{}]*\{[^{}]*max-width\s*:\s*100%/i;
    const imgInSelectorList = /img\s*,[^{}]*\{[^{}]*max-width\s*:\s*100%/i;
    expect(imgCapped.test(FLAT) || imgInSelectorList.test(FLAT)).toBe(true);

    // Long unbroken strings (URLs/codes) wrap rather than force overflow.
    expect(/overflow-wrap\s*:\s*(anywhere|break-word)/i.test(FLAT)).toBe(true);
  });

  // ── 4. Touch targets — 44px minimum (Req 19.3) ────────────────────────────
  // Feature: ui-redesign, Property: responsive CSS guarantees (Req 19.2/19.3/19.5)
  it("declares 44px minimum touch targets for interactive controls", () => {
    const touchTargets = (FLAT.match(/min-height\s*:\s*44px/gi) ?? []).length;
    expect(touchTargets).toBeGreaterThanOrEqual(1);
    // Many controls carry it (fields, buttons, chips, tabs, nav, drawer, modal).
    expect(touchTargets).toBeGreaterThanOrEqual(3);
  });

  // ── 5. Heading floor >=16px at <=1023px (Req 19.6, supports 19.2) ─────────
  // Feature: ui-redesign, Property: responsive CSS guarantees (Req 19.2/19.3/19.5)
  it("guarantees a >=16px serif heading floor (max(1rem, …) and/or a >=2.2rem hero clamp floor)", () => {
    const remFloor = /max\(\s*1rem/i.test(FLAT); // max(1rem, …) clamps headings to a 16px floor
    const heroClampFloor = /clamp\(\s*2\.2rem/i.test(FLAT); // hero clamp floor is 2.2rem (35.2px) >= 16px
    // At least one heading-floor guarantee must exist; this stylesheet has both.
    expect(remFloor || heroClampFloor).toBe(true);
  });
});
