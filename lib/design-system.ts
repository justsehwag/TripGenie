/**
 * Editorial + Glassmorphism + Motion design system - design section 15.
 * Pure, framework-free policy module: encodes the typographic scale, glass
 * opacity band, glass surface proportion, opaque booking surfaces, and motion
 * policy so the UI invariants (Properties 49-53) are testable offline.
 * Requirements: 15.1-15.9.
 */

/** Editorial palette - deliberately distinct from TripSaathi's teal/navy/coral. */
export const palette = {
  ink: "#1a1714",       // warm near-black (editorial, not navy)
  paper: "#f4efe6",     // bone/cream
  accent: "#b84a2e",    // burnt sienna (not coral/teal)
  accentAlt: "#363f2a", // deep olive
  gold: "#c49e45",
} as const;

/** Editorial typography: serif display + humanist body (not TripSaathi's Arial). */
export const fonts = {
  display: 'Garamond, "Times New Roman", serif',
  body: 'Inter, system-ui, sans-serif',
} as const;

/** Type steps in rem, largest first; each step is at least 1.25x the next. */
export const typeScale = [3, 2.25, 1.75, 1.25, 1] as const;

export const MIN_TYPE_STEP = 1.25;

/** True iff every adjacent pair in the scale keeps at least the 1.25x step. */
export function typeScaleValid(scale: readonly number[] = typeScale): boolean {
  for (let i = 0; i < scale.length - 1; i++) {
    if (scale[i] / scale[i + 1] < MIN_TYPE_STEP - 1e-9) return false;
  }
  return true;
}

/** Glass opacity band for accent surfaces (inclusive). */
export const GLASS_OPACITY_MIN = 0.60;
export const GLASS_OPACITY_MAX = 0.85;

export function accentGlassOpacityValid(o: number): boolean {
  return o >= GLASS_OPACITY_MIN - 1e-9 && o <= GLASS_OPACITY_MAX + 1e-9;
}

/** Glass surfaces may cover at most 30% of visible card surfaces per viewport. */
export const GLASS_SURFACE_MAX_RATIO = 0.30;

export interface Surface {
  kind: "glass" | "opaque";
  /** True for core booking surfaces (itinerary detail, payment, confirmation). */
  booking: boolean;
}

/** Fraction of card surfaces that use glass. */
export function glassSurfaceRatio(surfaces: readonly Surface[]): number {
  if (surfaces.length === 0) return 0;
  const glass = surfaces.filter((s) => s.kind === "glass").length;
  return glass / surfaces.length;
}

export function glassProportionValid(surfaces: readonly Surface[]): boolean {
  return glassSurfaceRatio(surfaces) <= GLASS_SURFACE_MAX_RATIO + 1e-9;
}

/** Core booking surfaces are never glass: they render fully opaque. */
export function bookingSurfacesOpaque(surfaces: readonly Surface[]): boolean {
  return surfaces.every((s) => !s.booking || s.kind === "opaque");
}

export const BOOKING_SURFACE_OPACITY = 1.0;
export const MIN_BOOKING_CONTRAST = 4.5;

/** Relative luminance of an sRGB color per WCAG 2.x. */
function luminance(hex: string): number {
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

/** Booking text (ink on paper) must clear the 4.5:1 minimum. */
export function bookingLegible(fg = palette.ink, bg = palette.paper): boolean {
  return contrastRatio(fg, bg) >= MIN_BOOKING_CONTRAST;
}

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

/** TripSaathi palette/font we must not reproduce (for distinctness assertions). */
export const TRIPSAATHI_LEGACY = {
  colors: ["#12275f", "#078f9a", "#12b8c4", "#6947e8", "#c93491", "#ff5d68"],
  font: "Arial",
} as const;
