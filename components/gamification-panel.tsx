"use client";

/**
 * Gamification panel (TripGenie parity with TripSaathi FR-06). A presentational
 * client component that renders a summary of the pure lib/gamification.ts state:
 * total XP, current level with a progress bar toward the next band, unlocked
 * badges, and quest progress. State is owned by the caller (idempotent award()),
 * so this component never mutates anything - it only visualizes a summary.
 *
 * Token-only styling via the xp-* classes in globals.css; no new :root tokens.
 */

import { summarize, type XpState } from "@/lib/gamification";

export default function GamificationPanel({ state }: { state: XpState }) {
  const { total, level, badges, quests } = summarize(state);
  const span = level.nextAt !== null ? level.nextAt - level.min : 1;
  const progressed = total - level.min;
  const pct = level.nextAt !== null ? Math.max(0, Math.min(100, Math.round((progressed / span) * 100))) : 100;

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

      <ul className="xp-quests" aria-label="Quests">
        {quests.map((quest) => (
          <li key={quest.id} className="xp-quest">
            <div className={`xp-quest__row${quest.complete ? " xp-quest__row--done" : ""}`}>
              <span>{quest.name}</span>
              <span>
                {quest.done}/{quest.total}
                {quest.complete ? " done" : ""}
              </span>
            </div>
            <div className="xp-bar" aria-hidden="true">
              <span
                className="xp-bar__fill"
                style={{ width: `${Math.round((quest.done / quest.total) * 100)}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}