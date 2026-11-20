"use client";

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

export type ItinerarySearchProps = {
  value: string;
  onQueryChange: (q: string) => void;
  count: number;
  active: boolean;
  debounceMs?: number;
};

export function ItinerarySearch({
  value,
  onQueryChange,
  count,
  active,
  debounceMs = 150,
}: ItinerarySearchProps) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEmitted = useRef(value);
  const onChangeRef = useRef(onQueryChange);
  onChangeRef.current = onQueryChange;

  const cancelTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  // Adopt external changes to the parent query (not echoes of our own emits).
  useEffect(() => {
    if (value !== lastEmitted.current) {
      lastEmitted.current = value;
      cancelTimer();
      setDraft(value);
    }
  }, [value]);

  useEffect(() => cancelTimer, []);

  const emit = (q: string) => {
    lastEmitted.current = q;
    onChangeRef.current(q);
  };

  const schedule = (q: string) => {
    cancelTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      emit(q);
    }, debounceMs);
  };

  const clearNow = () => {
    cancelTimer();
    setDraft("");
    emit("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      clearNow();
    }
  };

  return (
    <div className="itin-search">
      <input
        ref={inputRef}
        type="search"
        className="itin-search__input"
        aria-label="Search itinerary"
        placeholder="Search itinerary"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          schedule(e.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      {draft !== "" && (
        <button
          type="button"
          className="itin-search__clear"
          aria-label="Clear search"
          onClick={() => {
            clearNow();
            inputRef.current?.focus();
          }}
        >
          ×
        </button>
      )}
      <p role="status" className="itin-search__status">
        {active
          ? count === 0
            ? "No matches in this itinerary"
            : count === 1
              ? "1 match"
              : `${count} matches`
          : ""}
      </p>
    </div>
  );
}

export default ItinerarySearch;
