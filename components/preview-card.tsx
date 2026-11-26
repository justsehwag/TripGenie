"use client";

import type { ActionStatus } from "../lib/site-assistant/action-reducer";
import type { ActionProposal } from "../lib/site-assistant/types";

export interface PreviewCardProps {
  proposal: ActionProposal;
  status: ActionStatus;
  /** True once the page handler returned `{ undo }` for an applied proposal. */
  canUndo?: boolean;
  onApply: (proposal: ActionProposal) => void;
  onCancel: (id: string) => void;
  onUndo?: (id: string) => void;
}

const STATUS_LABEL: Record<Exclude<ActionStatus, "pending">, string> = {
  applied: "Applied",
  cancelled: "Cancelled",
  undone: "Undone",
  stale: "Stale",
};

/** Before/after preview of one assistant-proposed action. */
export function PreviewCard({ proposal, status, canUndo = false, onApply, onCancel, onUndo }: PreviewCardProps) {
  const pending = status === "pending";
  const modifier =
    status === "applied"
      ? " trip-assistant__proposal--applied"
      : status === "cancelled" || status === "undone"
        ? " trip-assistant__proposal--dismissed"
        : status === "stale"
          ? " trip-assistant__proposal--stale"
          : "";

  return (
    <section
      className={`trip-assistant__proposal site-assistant__preview${modifier}`}
      data-status={status}
      aria-label={`Proposed change: ${proposal.summary}`}
    >
      <p className="trip-assistant__proposal-summary site-assistant__preview-summary">{proposal.summary}</p>

      <ul className="trip-assistant__rows site-assistant__preview-fields">
        {proposal.fields.map((field, index) => (
          <li
            key={`${field.label}-${index}`}
            className={`trip-assistant__row site-assistant__preview-field${
              field.before !== undefined && field.before !== field.after ? " trip-assistant__row--changed" : ""
            }`}
          >
            <span className="trip-assistant__row-time site-assistant__preview-label">{field.label}</span>
            <span className="trip-assistant__row-title site-assistant__preview-values">
              {field.before !== undefined ? (
                <>
                  <span className="site-assistant__preview-before">
                    <span className="sr-only">Before: </span>
                    {field.before}
                  </span>
                  <span className="site-assistant__preview-arrow" aria-hidden="true">
                    {" \u2192 "}
                  </span>
                </>
              ) : null}
              <span className="site-assistant__preview-after">
                <span className="sr-only">After: </span>
                {field.after}
              </span>
            </span>
          </li>
        ))}
      </ul>

      <div className="trip-assistant__proposal-actions site-assistant__preview-actions">
        {pending ? (
          <>
            <button
              type="button"
              className="btn btn--primary site-assistant__preview-apply"
              aria-label={`Apply: ${proposal.summary}`}
              disabled={!pending}
              onClick={() => onApply(proposal)}
            >
              Apply
            </button>
            <button
              type="button"
              className="btn site-assistant__preview-cancel"
              aria-label={`Cancel: ${proposal.summary}`}
              onClick={() => onCancel(proposal.id)}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <span
              className={`trip-assistant__badge site-assistant__preview-badge${
                status === "stale" ? " trip-assistant__badge--warn site-assistant__preview-badge--stale" : ""
              }`}
              role="status"
            >
              {STATUS_LABEL[status]}
            </span>
            {status === "applied" && canUndo && onUndo ? (
              <button
                type="button"
                className="btn site-assistant__preview-undo"
                aria-label={`Undo: ${proposal.summary}`}
                onClick={() => onUndo(proposal.id)}
              >
                Undo
              </button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

export default PreviewCard;
