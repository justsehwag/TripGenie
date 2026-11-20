"use client";

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import ConciergeHome from "@/components/concierge-home";
import QuickForm from "@/components/quick-form";
import {
  readStoredMode,
  resolveInitialMode,
  writeStoredMode,
  type PlannerMode,
} from "@/lib/planner-mode";

export interface PlannerEntryProps {
  initialQuery: string;
  initialDestination: string;
  initialTrip: string;
}

const TABS: ReadonlyArray<{ mode: PlannerMode; label: string }> = [
  { mode: "quick", label: "Quick form" },
  { mode: "chat", label: "Chat with AI" },
];

const tabId = (m: PlannerMode) => `planner-mode-tab-${m}`;
const panelId = (m: PlannerMode) => `planner-mode-panel-${m}`;

/**
 * /plan entry: a Mode_Toggle ("Quick form" | "Chat with AI") above either the
 * Quick_Form or the Chat_Concierge. Switching modes only writes the mode key;
 * it never touches the Shared_Trip_Context, so captured values persist.
 */
export default function PlannerEntry({
  initialQuery,
  initialDestination,
  initialTrip,
}: PlannerEntryProps) {
  // null until mounted: server and first client render match (no hydration drift).
  const [mode, setMode] = useState<PlannerMode | null>(null);
  const tabRefs = useRef<Record<PlannerMode, HTMLButtonElement | null>>({
    quick: null,
    chat: null,
  });

  useEffect(() => {
    const hasHandoff = Boolean(
      initialQuery.trim() || initialDestination.trim() || initialTrip.trim(),
    );
    let storage: Storage | undefined;
    try {
      storage = window.localStorage;
    } catch {
      storage = undefined;
    }
    // Hand-off opens chat for this load without rewriting the stored mode (C5).
    setMode(resolveInitialMode(readStoredMode(storage), hasHandoff));
    // Runs once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function select(next: PlannerMode, focus = false) {
    setMode(next);
    let storage: Storage | undefined;
    try {
      storage = window.localStorage;
    } catch {
      storage = undefined;
    }
    writeStoredMode(storage, next);
    if (focus) tabRefs.current[next]?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const current = mode ?? "chat";
    const idx = TABS.findIndex((t) => t.mode === current);
    let target = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") target = (idx + 1) % TABS.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") target = (idx - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") target = 0;
    else if (e.key === "End") target = TABS.length - 1;
    if (target < 0) return;
    e.preventDefault();
    select(TABS[target].mode, true);
  }

  return (
    <div className="planner-entry">
      <div className="mode-toggle" role="tablist" aria-label="How do you want to plan?">
        {TABS.map((t) => {
          const selected = mode === t.mode;
          // Roving tabindex; before mount (no selection) the first tab is the tab stop.
          const tabStop = mode === null ? t.mode === "quick" : selected;
          return (
            <button
              key={t.mode}
              ref={(el) => {
                tabRefs.current[t.mode] = el;
              }}
              type="button"
              role="tab"
              id={tabId(t.mode)}
              aria-selected={selected}
              aria-controls={panelId(t.mode)}
              tabIndex={tabStop ? 0 : -1}
              className={`mode-toggle__tab${selected ? " mode-toggle__tab--active" : ""}`}
              onClick={() => select(t.mode)}
              onKeyDown={onKeyDown}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {mode !== null && (
        <div
          role="tabpanel"
          id={panelId(mode)}
          aria-labelledby={tabId(mode)}
          className="mode-toggle__panel"
        >
          {mode === "quick" ? (
            <QuickForm />
          ) : (
            <ConciergeHome
              variant="assistant"
              initialQuery={initialQuery}
              initialDestination={initialDestination}
              initialTrip={initialTrip}
            />
          )}
        </div>
      )}
    </div>
  );
}
