/**
 * Minimalist illustration-led Design_System - the single, framework-free source
 * of truth for the UI redesign. Encodes the approved color palette, the nine
 * named typography styles and the two font faces, the spacing scale, the focus
 * policy, and the motion policy, plus the pure helpers (`contrastRatio`,
 * `luminance`, `resolveMotion`) and the token round-trip support
 * (`cssVarName`, `tokenEntries`) that keep `app/globals.css` mirrored 1:1.
 *
 * This module imports no framework (no React/Next/styling) so every invariant
 * is verifiable offline. Requirements: 1.1, 1.2, 1.4, 2.1, 2.6, 3.1, 3.2, 3.5,
 * 3.7, 16.1, 16.5, 16.6, 20.1.
 */

/** The eleven approved palette values (white / emerald / mint / orange). */
export interface ColorTokens {
  background: string; // #FFFFFF
  primaryText: string; // #26332F
  secondaryText: string; // #7B8580
  actionOrange: string; // #FF901F
  orangeHover: string; // #F47D0B
  primaryGreen: string; // #16B982
  deepEmerald: string; // #087F63
  paleMint: string; // #E8FAF2
  softGreen: string; // #C8F2DF
  lightBorder: string; // #E8ECE9
  mutedBg: string; // #F8FBF9
}

/** Exact approved hex values for every color token (Requirement 2.1). */
export const COLOR_TOKENS: ColorTokens = {
  background: "#FFFFFF",
  primaryText: "#26332F",
  secondaryText: "#7B8580",
  actionOrange: "#FF901F",
  orangeHover: "#F47D0B",
  primaryGreen: "#16B982",
  deepEmerald: "#087F63",
  paleMint: "#E8FAF2",
  softGreen: "#C8F2DF",
  lightBorder: "#E8ECE9",
  mutedBg: "#F8FBF9",
} as const;

/** A single named text style in the typography scale. */
export interface TypographyStyle {
  /** Serif display face vs sans body face. */
  fontFamily: "display" | "body";
  /** Font size in px. */
  fontSize: number;
  /** Unitless line-height multiplier. */
  lineHeight: number;
  fontWeight: 400 | 700;
  /** Letter spacing in em (e.g. "0em", "-0.01em"). */
  letterSpacing: string;
}

/** The nine named typography styles. */
export type TypographyName =
  | "hero"
  | "section"
  | "pageTitle"
  | "cardTitle"
  | "body"
  | "label"
  | "helper"
  | "button"
  | "nav";

/**
 * Nine named styles. Heading tiers are strictly ordered by size
 * (hero > section > pageTitle > cardTitle >= body); hero/section/pageTitle/
 * cardTitle use the serif "display" face, the remainder use the sans "body"
 * face. The body style stays within 14-18px / 1.4-1.8 line-height
 * (Requirements 3.2, 3.5, 3.7).
 */
export const TYPOGRAPHY_SCALE: Record<TypographyName, TypographyStyle> = {
  hero: { fontFamily: "display", fontSize: 56, lineHeight: 1.1, fontWeight: 400, letterSpacing: "-0.02em" },
  section: { fontFamily: "display", fontSize: 40, lineHeight: 1.15, fontWeight: 400, letterSpacing: "-0.01em" },
  pageTitle: { fontFamily: "display", fontSize: 32, lineHeight: 1.2, fontWeight: 400, letterSpacing: "-0.01em" },
  cardTitle: { fontFamily: "display", fontSize: 20, lineHeight: 1.3, fontWeight: 700, letterSpacing: "0em" },
  body: { fontFamily: "body", fontSize: 16, lineHeight: 1.6, fontWeight: 400, letterSpacing: "0em" },
  label: { fontFamily: "body", fontSize: 14, lineHeight: 1.4, fontWeight: 700, letterSpacing: "0.01em" },
  helper: { fontFamily: "body", fontSize: 13, lineHeight: 1.5, fontWeight: 400, letterSpacing: "0em" },
  button: { fontFamily: "body", fontSize: 15, lineHeight: 1.2, fontWeight: 700, letterSpacing: "0.01em" },
  nav: { fontFamily: "body", fontSize: 15, lineHeight: 1.4, fontWeight: 400, letterSpacing: "0em" },
} as const;

/** A font face record: family, fallback stack, and the two loaded weights. */
export interface TypographyFace {
  family: string;
  fallback: string;
  weights: [400, 700];
}

/** Serif display face + sans body face used by the redesign (Requirement 3.1). */
export const TYPOGRAPHY_FACES: { display: TypographyFace; body: TypographyFace } = {
  display: {
    family: "DM Serif Display",
    fallback: "var(--font-display-face), Georgia, 'Times New Roman', serif",
    weights: [400, 700],
  },
  body: {
    family: "Inter",
    fallback: "var(--font-body-face), system-ui, -apple-system, 'Segoe UI', sans-serif",
    weights: [400, 700],
  },
} as const;

/** Spacing scale in px (Requirement 3 spacing consistency). */
export const SPACING: Record<string, number> = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

/** Focus indicator policy; ring color drawn from a green/orange token. */
export const FOCUS: { ringColor: string; ringWidth: number; offset: number } = {
  ringColor: COLOR_TOKENS.primaryGreen,
  ringWidth: 2,
  offset: 2,
} as const;

/** Motion duration bounds in ms (Requirement 16.5). */
export const MOTION_MIN_MS = 120;
export const MOTION_MAX_MS = 400;

/* ------------------------------------------------------------------------- *
 * Pure helpers (kept from the legacy module).
 * ------------------------------------------------------------------------- */

/** Relative luminance of an sRGB color per WCAG 2.x (exported for tests). */
export function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const [r, g, b] = rgb.map((c) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two sRGB hex colors (range 1..21). */
export function contrastRatio(fg: string, bg: string): number {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/* ------------------------------------------------------------------------- *
 * Motion policy (kept from the legacy module).
 * ------------------------------------------------------------------------- */

/** Motion policy durations in ms. */
export const MOTION_NORMAL_MS = 400;
export const MOTION_REDUCED_MS = 200;

export type MotionTrigger = "user-action" | "state-change" | "none";

export interface MotionDecision {
  play: boolean;
  durationMs: number;
  /** Under reduced motion, essential motion is limited to opacity. */
  opacityOnly: boolean;
}

/**
 * Resolve whether/how an animation plays. Animations only start on a user
 * action or state change and complete within 400ms. Under reduced motion,
 * non-essential motion is suppressed and essential motion is opacity-only
 * within 200ms.
 */
export function resolveMotion(
  trigger: MotionTrigger,
  opts: { reducedMotion: boolean; essential: boolean },
): MotionDecision {
  // Never animate without a trigger.
  if (trigger === "none") return { play: false, durationMs: 0, opacityOnly: false };
  if (opts.reducedMotion) {
    // Suppress non-essential motion; essential motion is opacity-only within 200ms.
    if (!opts.essential) return { play: false, durationMs: 0, opacityOnly: false };
    return { play: true, durationMs: MOTION_REDUCED_MS, opacityOnly: true };
  }
  return { play: true, durationMs: MOTION_NORMAL_MS, opacityOnly: false };
}

/* ------------------------------------------------------------------------- *
 * Token round-trip support (module <-> app/globals.css mirror).
 *
 * `cssVarName(group, key)` is the single, deterministic mapping from a token
 * group + key to its CSS custom property name. `tokenEntries()` returns the
 * flat list of every mirrored token as { cssVar, value }; it is the single
 * source the CSS `:root` block (task 3) and the consistency test (task 4)
 * compare against.
 *
 * Naming convention (kebab-cased keys; see `kebab`):
 *   color    primaryText            -> --color-primary-text
 *   type     hero + "size"          -> --type-hero-size
 *            hero + "line"          -> --type-hero-line
 *            hero + "weight"        -> --type-hero-weight
 *            hero + "spacing"       -> --type-hero-spacing
 *   face     display                -> --font-display
 *            body                   -> --font-body
 *   space    md                     -> --space-md
 *   focus    ringColor              -> --focus-ring-color
 *            ringWidth              -> --focus-ring-width
 *            offset                 -> --focus-offset
 *   motion   min                    -> --motion-min
 *            max                    -> --motion-max
 *            normal                 -> --motion-normal
 *            reduced                -> --motion-reduced
 *
 * Value serialization (what `tokenEntries().value` holds):
 *   - color hex strings are emitted verbatim (uppercase as authored).
 *   - typography fontSize and letterSpacing: fontSize as "<n>px", letterSpacing
 *     verbatim (already carries its "em" unit); lineHeight and fontWeight are
 *     unitless plain strings (e.g. "1.6", "400").
 *   - faces: the fallback stack string verbatim (the family is loaded by
 *     next/font and injected as var(--font-*) by task 5, so the token value is
 *     the declared fallback).
 *   - spacing: px numbers as "<n>px".
 *   - focus: ringColor as the hex string, ringWidth and offset as "<n>px".
 *   - motion: durations as "<n>ms".
 * ------------------------------------------------------------------------- */

/** Token groups that participate in the CSS mirror. */
export type TokenGroup = "color" | "type" | "face" | "space" | "focus" | "motion";

/** A single mirrored token: its CSS custom property name and serialized value. */
export interface TokenEntry {
  cssVar: string;
  value: string;
}

/** camelCase / single-word key -> kebab-case (primaryText -> primary-text). */
function kebab(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** px serialization helper. */
function px(n: number): string {
  return `${n}px`;
}

/** ms serialization helper. */
function ms(n: number): string {
  return `${n}ms`;
}

/**
 * Deterministic mapping from a token group + key to its CSS custom property
 * name. This is the single convention tasks 3 and 4 rely on.
 *
 * For the "type" group the key is `"<styleName> <facet>"` where facet is one of
 * "size" | "line" | "weight" | "spacing" (e.g. `cssVarName("type", "hero size")`
 * -> `--type-hero-size`).
 */
export function cssVarName(group: TokenGroup, key: string): string {
  switch (group) {
    case "color":
      return `--color-${kebab(key)}`;
    case "type": {
      const [name, facet] = key.split(/\s+/);
      return `--type-${kebab(name)}-${facet}`;
    }
    case "face":
      return `--font-${kebab(key)}`;
    case "space":
      return `--space-${kebab(key)}`;
    case "focus": {
      // ringColor -> ring-color, ringWidth -> ring-width, offset -> offset
      return `--focus-${kebab(key)}`;
    }
    case "motion":
      return `--motion-${kebab(key)}`;
  }
}

/**
 * Flat list of every mirrored token as `{ cssVar, value }`. The single source
 * the CSS mirror (task 3) and the token<->CSS consistency test (task 4) compare
 * against. Order is deterministic: color, then typography (by style, then
 * size/line/weight/spacing), then faces, spacing, focus, motion.
 */
export function tokenEntries(): TokenEntry[] {
  const entries: TokenEntry[] = [];

  // Color tokens.
  for (const key of Object.keys(COLOR_TOKENS) as (keyof ColorTokens)[]) {
    entries.push({ cssVar: cssVarName("color", key), value: COLOR_TOKENS[key] });
  }

  // Typography styles (size / line / weight / spacing per named style).
  for (const name of Object.keys(TYPOGRAPHY_SCALE) as TypographyName[]) {
    const style = TYPOGRAPHY_SCALE[name];
    entries.push({ cssVar: cssVarName("type", `${name} size`), value: px(style.fontSize) });
    entries.push({ cssVar: cssVarName("type", `${name} line`), value: String(style.lineHeight) });
    entries.push({ cssVar: cssVarName("type", `${name} weight`), value: String(style.fontWeight) });
    entries.push({ cssVar: cssVarName("type", `${name} spacing`), value: style.letterSpacing });
  }

  // Font faces (fallback stack; family is injected by next/font).
  entries.push({ cssVar: cssVarName("face", "display"), value: TYPOGRAPHY_FACES.display.fallback });
  entries.push({ cssVar: cssVarName("face", "body"), value: TYPOGRAPHY_FACES.body.fallback });

  // Spacing scale.
  for (const key of Object.keys(SPACING)) {
    entries.push({ cssVar: cssVarName("space", key), value: px(SPACING[key]) });
  }

  // Focus policy.
  entries.push({ cssVar: cssVarName("focus", "ringColor"), value: FOCUS.ringColor });
  entries.push({ cssVar: cssVarName("focus", "ringWidth"), value: px(FOCUS.ringWidth) });
  entries.push({ cssVar: cssVarName("focus", "offset"), value: px(FOCUS.offset) });

  // Motion durations.
  entries.push({ cssVar: cssVarName("motion", "min"), value: ms(MOTION_MIN_MS) });
  entries.push({ cssVar: cssVarName("motion", "max"), value: ms(MOTION_MAX_MS) });
  entries.push({ cssVar: cssVarName("motion", "normal"), value: ms(MOTION_NORMAL_MS) });
  entries.push({ cssVar: cssVarName("motion", "reduced"), value: ms(MOTION_REDUCED_MS) });

  return entries;
}
