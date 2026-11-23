"use client";

import { useId } from "react";
import { todayIst } from "@/lib/ist-time";
import { DATE_CHIPS, resolveDateChip } from "@/lib/start-date";

export interface StartDatePromptProps {
  onPick: (iso: string) => void;
  onSkip: () => void;
  /** ISO date used as the `min` of the date input. */
  today: string;
}

/** Date input and quick chips shown under "What date do you start?" in the chat. */
export function StartDatePrompt({ onPick, onSkip, today }: StartDatePromptProps) {
  const inputId = useId();

  return (
    <div className="start-date-prompt" role="group" aria-label="Choose your start date">
      <label className="field" htmlFor={inputId}>
        <span>Start date</span>
      </label>
      <input
        id={inputId}
        type="date"
        min={today}
        onChange={(e) => {
          const value = e.target.value;
          if (value) onPick(value);
        }}
      />
      <div className="start-date-prompt__row">
        {DATE_CHIPS.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className="chat-chip press"
            onClick={() => {
              const iso = resolveDateChip(chip.id, todayIst());
              if (iso) onPick(iso);
            }}
          >
            {chip.label}
          </button>
        ))}
        <button type="button" className="chat-chip press" onClick={onSkip}>
          Skip
        </button>
      </div>
    </div>
  );
}
