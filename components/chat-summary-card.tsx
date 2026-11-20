"use client";

// Trip summary shown by the chat concierge once intake is finished (design "Part A").
// Presentational only: it lists `summaryRows` in their fixed order, tags carried values,
// offers an Edit button per row and an explicit "Generate itinerary" button. Navigation
// happens only through `onGenerate`; nothing here navigates on its own.
import type { RequiredField } from "@/lib/preference-controller";
import type { SummaryRow } from "@/lib/chat-intake";

export const CARRIED_TAG_TEXT = "from your earlier trip";
export const GENERATE_LABEL = "Generate itinerary";
export const GENERATE_BLOCKED_TEXT = "Add where you are travelling from and to before generating.";

export interface ChatSummaryCardProps {
  rows: readonly SummaryRow[];
  onEdit: (field: RequiredField) => void;
  onGenerate: () => void;
  /** Prefix for element ids, so two cards on one page do not clash. */
  idPrefix?: string;
}

function hasAnswer(rows: readonly SummaryRow[], field: RequiredField): boolean {
  const row = rows.find((r) => r.field === field);
  return !!row && (row.status === "answered" || row.status === "carried");
}

export default function ChatSummaryCard({ rows, onEdit, onGenerate, idPrefix = "chat-summary" }: ChatSummaryCardProps) {
  const canGenerate = hasAnswer(rows, "origin") && hasAnswer(rows, "destination");
  const titleId = `${idPrefix}-title`;
  const hintId = `${idPrefix}-hint`;

  return (
    <section className="chat-summary" aria-labelledby={titleId}>
      <h3 id={titleId} className="chat-summary__title">
        Your trip summary
      </h3>
      <ul className="chat-summary__list">
        {rows.map((row) => {
          const empty = row.status === "skipped" || row.status === "not-answered";
          return (
            <li key={row.field} className="chat-summary__row" data-field={row.field}>
              <div className="chat-summary__main">
                <span className="chat-summary__label">{row.label}</span>
                <span className={empty ? "chat-summary__value chat-summary__value--empty" : "chat-summary__value"}>
                  {row.display}
                </span>
                {row.carried ? <span className="chat-summary__tag">{CARRIED_TAG_TEXT}</span> : null}
                {row.defaultNote ? <span className="chat-summary__note">{row.defaultNote}</span> : null}
              </div>
              <button
                type="button"
                className="btn chat-summary__edit"
                aria-label={`Edit ${row.label}`}
                onClick={() => onEdit(row.field)}
              >
                Edit
              </button>
            </li>
          );
        })}
      </ul>
      {canGenerate ? null : (
        <p id={hintId} className="chat-summary__hint">
          {GENERATE_BLOCKED_TEXT}
        </p>
      )}
      <button
        type="button"
        className="btn btn--primary chat-summary__generate"
        disabled={!canGenerate}
        aria-describedby={canGenerate ? undefined : hintId}
        onClick={onGenerate}
      >
        {GENERATE_LABEL}
      </button>
    </section>
  );
}
