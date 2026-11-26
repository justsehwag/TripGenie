"use client";

import { useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import {
  didYouMean,
  fuzzyMatch,
  normalizePlace,
  type FuzzyCandidate,
} from "@/lib/fuzzy-match";
import { suggestReducer, type SuggestNavKey } from "@/lib/suggest-nav";

/**
 * Text input with a typo-tolerant suggestion listbox (ARIA combobox).
 *
 * Suggestions come from the local candidate list through the fuzzy matcher and,
 * when `remote` is set, from GET /api/place-correct (server side Google Places).
 * The typed text is replaced only when the user accepts a suggestion (click or
 * Enter on the active option) or presses the "Did you mean" accept button.
 */

export interface PlaceSuggestInputProps {
  id: string;
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  candidates: readonly FuzzyCandidate[];
  /** Also ask /api/place-correct (Google Places) for suggestions. */
  remote?: boolean;
  /** Id of an element describing a validation error for this input. */
  errorId?: string;
  required?: boolean;
  /** Sets aria-invalid on the input when the field has a validation error. */
  ariaInvalid?: boolean;
  /** Start with the list open (used for static markup tests). */
  initialOpen?: boolean;
}

const MAX_SUGGESTIONS = 6;
const DEBOUNCE_MS = 200;
const MIN_REMOTE_LENGTH = 2;

interface RemoteResult {
  q: string;
  labels: string[];
  failed: boolean;
}

export function PlaceSuggestInput({
  id,
  name,
  label,
  value,
  onChange,
  placeholder,
  candidates,
  remote = false,
  errorId,
  required,
  ariaInvalid,
  initialOpen = false,
}: PlaceSuggestInputProps) {
  const reactId = useId();
  const listId = `${id}-list`;
  const hintId = `${id}-hint`;
  const statusId = `${id}-status-${reactId.replace(/:/g, "")}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);

  const [nav, dispatch] = useReducer(suggestReducer, {
    text: value,
    active: -1,
    open: initialOpen,
  });
  const [remoteResult, setRemoteResult] = useState<RemoteResult | null>(null);

  const trimmed = value.trim();
  const wantsRemote = remote && nav.open && trimmed.length >= MIN_REMOTE_LENGTH;

  useEffect(() => {
    if (!wantsRemote) return;
    const q = trimmed;
    const request = ++requestRef.current;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/place-correct?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!res.ok) throw new Error("bad status");
        const data = (await res.json()) as { suggestions?: { label?: unknown }[] };
        const labels = (Array.isArray(data.suggestions) ? data.suggestions : [])
          .map((s) => (typeof s?.label === "string" ? s.label : ""))
          .filter(Boolean);
        if (request === requestRef.current) setRemoteResult({ q, labels, failed: false });
      } catch {
        if (request === requestRef.current && !controller.signal.aborted) {
          setRemoteResult({ q, labels: [], failed: true });
        }
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [wantsRemote, trimmed]);

  const loading = wantsRemote && remoteResult?.q !== trimmed;
  const remoteLabels =
    remote && remoteResult && remoteResult.q === trimmed ? remoteResult.labels : [];

  const localLabels = useMemo(
    () => fuzzyMatch(value, candidates, MAX_SUGGESTIONS).map((h) => h.label),
    [value, candidates],
  );

  const options = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    // Remote (Google) results first, then the local list.
    for (const l of [...remoteLabels, ...localLabels]) {
      const key = normalizePlace(l);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(l);
      if (out.length >= MAX_SUGGESTIONS) break;
    }
    return out;
  }, [remoteLabels, localLabels]);

  const localOnly = remoteLabels.length === 0 && localLabels.length > 0;
  const hint = useMemo(() => didYouMean(value, candidates), [value, candidates]);

  const expanded = nav.open && options.length > 0;
  const showEmpty = nav.open && !loading && options.length === 0 && trimmed.length > 0;
  const activeId = expanded && nav.active >= 0 ? `${id}-opt-${nav.active}` : undefined;

  function accept(next: string) {
    dispatch({ type: "accept", value: next });
    onChange(next);
  }

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    dispatch({ type: "input", text: e.target.value });
    onChange(e.target.value);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const key = e.key;
    if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
      if (!expanded && key !== "ArrowDown") return;
      e.preventDefault();
      dispatch({ type: "key", key: key as SuggestNavKey, length: options.length });
    } else if (key === "Escape") {
      if (nav.open) e.preventDefault();
      dispatch({ type: "key", key: "Escape", length: options.length });
    } else if (key === "Enter" && expanded && nav.active >= 0 && nav.active < options.length) {
      e.preventDefault();
      accept(options[nav.active]);
    }
  }

  function handleBlur() {
    // Close once focus leaves the whole widget (options and accept button count as inside).
    setTimeout(() => {
      const root = rootRef.current;
      if (root && !root.contains(document.activeElement)) {
        dispatch({ type: "key", key: "Escape", length: options.length });
      }
    }, 0);
  }

  const describedBy = [hint ? hintId : "", errorId ?? ""].filter(Boolean).join(" ") || undefined;

  return (
    <div className="place-suggest" ref={rootRef} onBlur={handleBlur}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={name}
        type="text"
        value={value}
        placeholder={placeholder}
        required={required}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-invalid={ariaInvalid ? true : undefined}
        aria-describedby={describedBy}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />
      <div aria-busy={loading ? "true" : "false"}>
        <ul
          id={listId}
          role="listbox"
          aria-label={`${label} suggestions`}
          className="place-suggest__list"
          hidden={!expanded}
        >
          {options.map((opt, i) => (
            <li
              key={opt}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === nav.active}
              className="place-suggest__option"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => accept(opt)}
            >
              {opt}
            </li>
          ))}
        </ul>
        {loading ? (
          <p className="place-suggest__status" id={statusId} role="status">
            Searching places…
          </p>
        ) : null}
        {expanded && !loading && localOnly ? (
          <p className="place-suggest__status">From our airport and city list</p>
        ) : null}
        {showEmpty ? (
          <p className="place-suggest__status" role="status">
            No matching places. Check the spelling.
          </p>
        ) : null}
      </div>
      {hint ? (
        <p className="place-suggest__hint" id={hintId}>
          Did you mean{" "}
          <button type="button" onClick={() => accept(hint.label)}>
            {hint.label}
          </button>
          ?
        </p>
      ) : null}
    </div>
  );
}
