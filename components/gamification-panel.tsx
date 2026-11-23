"use client";

/**
 * Gamification panel (TripGenie parity with TripSaathi FR-06). A presentational
 * client component that renders a summary of the pure lib/gamification.ts state:
 * total XP, current level with a progress bar toward the next band, unlocked
 * badges. State is owned by the caller (idempotent award()),
 * so this component never mutates anything - it only visualizes a summary.
 *
 * Token-only styling via the xp-* classes in globals.css; no new :root tokens.
 */

import Link from "next/link";
import { summarize, type XpState } from "@/lib/gamification";

function XpSummary({ state, compact = false }: { state: XpState; compact?: boolean }) {
  const { total, level, badges } = summarize(state);
  const span = level.nextAt !== null ? level.nextAt - level.min : 1;
  const progressed = total - level.min;
  const pct = level.nextAt !== null ? Math.max(0, Math.min(100, Math.round((progressed / span) * 100))) : 100;

  const bar = (
    <div
      className="xp-bar"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={level.nextAt !== null ? `${level.toNext} XP to next level` : "Top level reached"}
    >
      <span className="xp-bar__fill" style={{ width: `${pct}%` }} />
    </div>
  );
  const nextText = level.nextAt !== null ? `${level.toNext} XP to the next level` : "You've reached the top level.";
  const badgeList = badges.length > 0 && (
    <ul className="xp-badges" aria-label="Badges earned">
      {badges.map((badge) => (
        <li key={badge.id} className="xp-badge" title={badge.description}>
          {badge.name}
        </li>
      ))}
    </ul>
  );

  if (compact) {
    return (
      <section className="xp-panel xp-panel--compact" aria-label="Your travel progress">
        <span className="xp-panel__level">
          Level {level.level} · {level.name}
        </span>
        <span className="xp-panel__total">{total} XP</span>
        {bar}
        <span className="xp-panel__next">{nextText}</span>
        {badgeList}
      </section>
    );
  }

  return (
    <section className="card xp-panel" aria-label="Your travel progress">
      <div className="xp-panel__head">
        <p className="xp-panel__level">
          Level {level.level} · {level.name}
        </p>
        <p className="xp-panel__total">{total} XP</p>
      </div>

      <div
        className="xp-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={level.nextAt !== null ? `${level.toNext} XP to next level` : "Top level reached"}
      >
        <span className="xp-bar__fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="xp-panel__next">
        {level.nextAt !== null ? `${level.toNext} XP to the next level` : "You've reached the top level."}
      </p>

      {badges.length > 0 && (
        <ul className="xp-badges" aria-label="Badges earned">
          {badges.map((badge) => (
            <li key={badge.id} className="xp-badge" title={badge.description}>
              {badge.name}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function GamificationPanel({
  state,
  compact = false,
  guest = false,
  loading = false,
  error = null,
  onRetry,
}: {
  state?: XpState | null;
  compact?: boolean;
  guest?: boolean;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}) {
  if (!guest && !loading && !error) {
    return state ? <XpSummary state={state} compact={compact} /> : null;
  }

  const wrapperClass = compact ? "xp-panel xp-panel--compact" : "card xp-panel";

  if (guest) {
    return (
      <section className={wrapperClass} aria-label="Your travel progress">
        <p className="xp-panel__next">Sign in to earn XP</p>
        <Link className="btn btn--primary" href="/account">
          Sign in
        </Link>
      </section>
    );
  }

  if (loading) {
    return (
      <section className={wrapperClass} aria-label="Your travel progress" aria-busy="true">
        <div className="skeleton" role="status" aria-label="Loading your progress">
          <div className="skeleton__block skeleton__block--title" />
          <div className="skeleton__block skeleton__block--line" />
        </div>
      </section>
    );
  }

  return (
    <>
      <div className={wrapperClass} role="alert">
        <p className="xp-panel__next">{error}</p>
        {onRetry && (
          <button type="button" className="btn" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
      {state ? <XpSummary state={state} compact={compact} /> : null}
    </>
  );
}
