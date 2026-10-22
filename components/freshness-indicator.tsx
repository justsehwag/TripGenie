import type { LiveMode } from "@/lib/live-data";

/**
 * Freshness_Indicator (design: Live-data surfacing + Freshness_Indicator,
 * Req 5.5/5.6/10.4).
 *
 * A compact, purely presentational label for a {@link LiveResult}. It maps the
 * live-data `mode` (`live | cached | fallback`) + `provider` to honest, visible
 * text rendered through EXISTING provenance/eyebrow classes only — it adds NO
 * new token, `:root` var, or styled class of its own. When `mode === "fallback"`
 * the value is clearly labelled a fallback and never presented as a live reading
 * (Req 5.6).
 *
 * This is a plain function component (no hooks), so it is server-safe and needs
 * no `"use client"` directive.
 */

const FRESHNESS_TEXT: Record<LiveMode, string> = {
  live: "Live",
  cached: "Cached",
  fallback: "Unavailable (showing fallback)",
};

/**
 * Pure helper mapping a {@link LiveMode} to its human-readable freshness label.
 * Exported so components and tests can reuse the exact wording.
 */
export function freshnessLabel(mode: LiveMode): string {
  return FRESHNESS_TEXT[mode];
}

/**
 * Map the live-data mode to the existing `.provenance__badge[data-mode]` style
 * hook. Only `live` and `estimated` have dedicated badge styling; `cached` falls
 * back to the neutral base badge, and `fallback` reuses the caution `estimated`
 * styling so a fallback value is never dressed up as a live reading (Req 5.6).
 */
const BADGE_DATA_MODE: Record<LiveMode, string> = {
  live: "live",
  cached: "cached",
  fallback: "estimated",
};

export interface FreshnessIndicatorProps {
  mode: LiveMode;
  provider: string;
  /** ISO-8601 (or any displayable) timestamp of when the value was retrieved. */
  retrievedAt?: string;
}

/**
 * Render a compact freshness label. The mode wording is real text (not an
 * icon-only signal) so it stays accessible; decorative separators are marked
 * `aria-hidden`.
 */
export function FreshnessIndicator({
  mode,
  provider,
  retrievedAt,
}: FreshnessIndicatorProps) {
  const isFallback = mode === "fallback";
  return (
    <span className={`provenance provenance--${mode}`} data-freshness={mode}>
      <span className="provenance__badge" data-mode={BADGE_DATA_MODE[mode]}>
        {freshnessLabel(mode)}
      </span>
      <span
        className={`provenance__note${isFallback ? " provenance__note--estimated" : ""}`}
      >
        {provider}
        {retrievedAt ? (
          <>
            <span aria-hidden="true"> · </span>
            <span className="eyebrow">updated {retrievedAt}</span>
          </>
        ) : null}
      </span>
    </span>
  );
}

export default FreshnessIndicator;
