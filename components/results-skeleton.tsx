/**
 * Shared Results_Page loading skeleton (Req 28.2).
 *
 * Rendered by each booking-site route's `loading.tsx` while the route segment
 * (which calls the Search_API via `runSearch`) is still resolving. It mirrors
 * the eventual Results_Page layout — an eyebrow, heading, a lead line, a
 * controls bar, and a grid of offer-card placeholders — so the transition to
 * real content is calm and shift-free. The skeleton is a static, overflow-free
 * block set whose shimmer honors reduced-motion via the globals.css policy
 * (Req 28.6 / 28.8).
 *
 * It is purely presentational and announces its busy state to assistive tech
 * with an aria-busy live region.
 */
export default function ResultsSkeleton({
  eyebrow = "Searching",
  cards = 6,
}: {
  eyebrow?: string;
  cards?: number;
}) {
  return (
    <main
      className="shell skeleton"
      aria-busy="true"
      aria-live="polite"
      aria-label={`${eyebrow} — loading results`}
    >
      <div className="skeleton__block skeleton__block--eyebrow" />
      <div className="skeleton__block skeleton__block--title" />
      <div className="skeleton__block skeleton__block--line" />
      <div className="skeleton__block skeleton__controls" />
      <div className="skeleton__grid">
        {Array.from({ length: Math.max(1, cards) }).map((_, i) => (
          <div key={i} className="skeleton__block skeleton__card" />
        ))}
      </div>
      {/* Visually-hidden status for screen readers. */}
      <span className="sr-only">Loading results, please wait.</span>
    </main>
  );
}
