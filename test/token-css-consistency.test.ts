import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import path from "node:path";
import { tokenEntries, type TokenEntry } from "@/lib/design-system";

/**
 * Token ↔ CSS consistency suite (ui-redesign spec, task 4).
 *
 * Feature: ui-redesign, Property 1: Token-centralization round-trip (module <-> CSS).
 *
 * Reads app/globals.css live from disk, extracts the first :root { ... } block
 * into a map of custom-property name -> value, and asserts a STRICT BIJECTION
 * with tokenEntries() from lib/design-system.ts:
 *   1. every module token entry has exactly one matching :root custom property
 *      with an identical normalized value,
 *   2. no tokenEntries() cssVar is duplicated, and
 *   3. no EXTRA :root custom property that belongs to a token-group prefix
 *      (--color-/--type-/--font-/--space-/--focus-/--motion-) is absent from
 *      tokenEntries() (catches a stray token var that drifts from the module).
 * Non-token helpers (--radius-*, --shadow-*, --ease-standard) are allowed to
 * exist freely outside the mirror.
 *
 * The CSS is read at runtime so the test reflects whatever the module and
 * stylesheet currently hold (e.g. task 5 may rewrite --font-display/--font-body
 * values); it stays correct only while module and CSS stay in sync.
 */

const GLOBALS_CSS_PATH = path.resolve(__dirname, "../app/globals.css");

/** Token-group prefixes the module owns and that MUST live in the mirror. */
const TOKEN_GROUP_PREFIXES = [
  "--color-",
  "--type-",
  "--font-",
  "--space-",
  "--focus-",
  "--motion-",
] as const;

const NUM_RUNS = { numRuns: 100 } as const;

/**
 * Normalize a token value for comparison: trim, collapse internal whitespace to
 * a single space, and uppercase any hex color literals so the comparison is
 * case-insensitive on hex while remaining exact elsewhere.
 */
function normalizeValue(raw: string): string {
  const collapsed = raw.trim().replace(/\s+/g, " ");
  // Uppercase 3/4/6/8-digit hex color literals (#abc, #aabbcc, #aabbccdd).
  return collapsed.replace(/#[0-9a-fA-F]{3,8}\b/g, (m) => m.toUpperCase());
}

/**
 * Extract the FIRST `:root { ... }` block from the stylesheet and parse its
 * `--name: value;` declarations into a Map (normalized values). Brace-matched
 * so nested blocks (there are none here, but be safe) don't leak in.
 */
function parseRootCustomProperties(css: string): Map<string, string> {
  const rootIdx = css.indexOf(":root");
  if (rootIdx === -1) throw new Error("globals.css has no :root block");
  const open = css.indexOf("{", rootIdx);
  if (open === -1) throw new Error("globals.css :root block has no opening brace");

  // Brace-match to find the matching close for this :root block.
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
  if (close === -1) throw new Error("globals.css :root block is not closed");

  const body = css.slice(open + 1, close);
  const map = new Map<string, string>();
  const decl = /(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(body)) !== null) {
    const name = m[1];
    const value = normalizeValue(m[2]);
    if (map.has(name)) {
      throw new Error(`Duplicate :root custom property parsed: ${name}`);
    }
    map.set(name, value);
  }
  return map;
}

/** True when a custom-property name belongs to a module-owned token group. */
function isTokenGroupVar(name: string): boolean {
  return TOKEN_GROUP_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Pure match helper: does the given entry have a matching :root custom property
 * with an equal normalized value? Returns a structured result so an injected
 * mismatch can be asserted against this exact function without touching files.
 */
function matchEntry(
  entry: TokenEntry,
  root: Map<string, string>,
): { ok: true } | { ok: false; reason: string } {
  if (!root.has(entry.cssVar)) {
    return { ok: false, reason: `missing :root custom property ${entry.cssVar}` };
  }
  const cssValue = root.get(entry.cssVar)!;
  const expected = normalizeValue(entry.value);
  if (cssValue !== expected) {
    return {
      ok: false,
      reason: `value mismatch for ${entry.cssVar}: module="${expected}" css="${cssValue}"`,
    };
  }
  return { ok: true };
}

const CSS = readFileSync(GLOBALS_CSS_PATH, "utf8");
const ROOT = parseRootCustomProperties(CSS);
const ENTRIES = tokenEntries();

describe("Feature: ui-redesign, Task 4 — token <-> CSS consistency", () => {
  it("module and CSS both expose the token set (sanity: non-empty, no module dupes)", () => {
    expect(ENTRIES.length).toBeGreaterThan(0);
    expect(ROOT.size).toBeGreaterThan(0);

    // No tokenEntries() cssVar is duplicated.
    const seen = new Set<string>();
    for (const e of ENTRIES) {
      expect(seen.has(e.cssVar), `duplicate module cssVar ${e.cssVar}`).toBe(false);
      seen.add(e.cssVar);
    }
  });

  // Feature: ui-redesign, Property 1: Token-centralization round-trip (module -> CSS).
  it("Property 1 (forward): every tokenEntries() entry maps to exactly one :root property with an equal value", () => {
    for (const entry of ENTRIES) {
      const result = matchEntry(entry, ROOT);
      // NAME the offending token on failure.
      expect(result.ok, result.ok ? "" : result.reason).toBe(true);
    }
  });

  // Feature: ui-redesign, Property 1: Token-centralization round-trip (CSS -> module).
  it("Property 1 (reverse): every token-group :root property maps back to exactly one module entry", () => {
    const expected = new Set(ENTRIES.map((e) => e.cssVar));
    const extras: string[] = [];
    for (const name of ROOT.keys()) {
      if (!isTokenGroupVar(name)) continue; // non-token helpers may exist freely
      if (!expected.has(name)) extras.push(name);
    }
    expect(extras, `stray token-group custom properties not in tokenEntries(): ${extras.join(", ")}`).toEqual([]);
  });

  // Feature: ui-redesign, Property 1: Token-centralization round-trip (order-independent).
  it("Property 1 (order-independent): the per-entry match holds for any shuffled subset of tokenEntries()", () => {
    fc.assert(
      fc.property(fc.shuffledSubarray(ENTRIES, { minLength: 1 }), (subset) => {
        for (const entry of subset) {
          const result = matchEntry(entry, ROOT);
          if (!result.ok) throw new Error(result.reason);
        }
      }),
      NUM_RUNS,
    );
  });

  // Feature: ui-redesign, Property 1: injected mismatch confirms the comparison would fail.
  it("Property 1 (negative): an injected wrong value makes the match helper report a mismatch", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ENTRIES), (entry) => {
        // Construct a fake entry with a deliberately wrong value; do NOT mutate
        // the real module or CSS — only exercise the local match helper.
        const fake: TokenEntry = { cssVar: entry.cssVar, value: `${entry.value} __WRONG__` };
        const result = matchEntry(fake, ROOT);
        expect(result.ok).toBe(false);
      }),
      NUM_RUNS,
    );

    // A token that does not exist in :root at all is also reported as missing.
    const absent: TokenEntry = { cssVar: "--color-does-not-exist", value: "#000000" };
    const absentResult = matchEntry(absent, ROOT);
    expect(absentResult.ok).toBe(false);
  });
});
