"use client";

/**
 * Shared_Trip_Context client store/provider (realtime-ai-integration spec,
 * task 6 — design section "Shared_Trip_Context → store").
 *
 * This is a PROVIDER-ONLY module: it introduces no new visual element, no
 * layout change, and no design-token change. It holds exactly one
 * `SharedTripContextState { context: TripContext; dates: DateHints }` for the
 * browser session, mirrors the pure `editField` semantics from
 * `lib/preference-controller.ts` for single-field edits, and persists to
 * `sessionStorage` so navigation between pages preserves the captured context.
 *
 * SSR-safe: every `window`/`sessionStorage` access is guarded with
 * `typeof window !== "undefined"`. Corrupt or missing storage rehydrates to the
 * empty default `{ context: {}, dates: {} }`. Nothing here ever throws during
 * normal use (storage read/write is wrapped in try/catch).
 *
 * This module is intentionally NOT mounted into `app/layout.tsx` in this task —
 * wiring it into the concierge (and deciding mount scope to avoid any visual or
 * behavioral change) is part of task 7.
 *
 * Requirements: 4.1, 4.7.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { TripContext, Itinerary } from "@/lib/types";
import type { DateHints } from "@/lib/trip-context-map";
import type { RequiredField } from "@/lib/preference-controller";

// ---------------------------------------------------------------------------
// State shape (design: Data Models → Shared_Trip_Context shape)
// ---------------------------------------------------------------------------

/**
 * The single session-scoped record. `context` is the canonical `TripContext`
 * carried everywhere; `dates` holds the lightweight ISO date hints that feed
 * the criteria mappers where `TripContext` has no date field.
 */
export interface SharedTripContextState {
  context: TripContext;
  dates: DateHints;
  /** The most recently generated itinerary, persisted so the results page
      can render it without regenerating (survives navigation). */
  itinerary?: Itinerary | null;
}

/** The empty default used at session start and on any corrupt/missing storage. */
function emptyState(): SharedTripContextState {
  return { context: {}, dates: {} };
}

// ---------------------------------------------------------------------------
// Context value — state + actions
// ---------------------------------------------------------------------------

export interface TripContextValue extends SharedTripContextState {
  /** Replace the entire canonical context. */
  setContext: (context: TripContext) => void;
  /** Shallow-merge a partial into the context: `{ ...prev.context, ...partial }`. */
  patchContext: (partial: Partial<TripContext>) => void;
  /**
   * Per-field edit mirroring `editField` in `lib/preference-controller.ts`:
   * passing `undefined` deletes the field; any other value sets it. No other
   * field is touched.
   */
  editField: <K extends RequiredField>(field: K, value: TripContext[K]) => void;
  /** Replace the entire date-hints block. */
  setDates: (dates: DateHints) => void;
  /** Shallow-merge a partial into the date hints. */
  patchDates: (partial: Partial<DateHints>) => void;
  /** Reset back to the empty default `{ context: {}, dates: {} }`. */
  reset: () => void;
  /** Store (or clear) the most recently generated itinerary. */
  setItinerary: (itinerary: Itinerary | null) => void;
}

const SharedTripContext = createContext<TripContextValue | null>(null);

// ---------------------------------------------------------------------------
// sessionStorage persistence (SSR-guarded, never throws)
// ---------------------------------------------------------------------------

/** Storage key for the persisted session state. */
export const STORAGE_KEY = "tripgenie.shared-trip-context";

/**
 * Rehydrate from `sessionStorage`. Returns the empty default on the server, on
 * a missing key, or on any parse/shape error — never throws.
 */
function readStorage(): SharedTripContextState {
  if (typeof window === "undefined") return emptyState();
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return emptyState();
    const candidate = parsed as Partial<SharedTripContextState>;
    const context =
      candidate.context && typeof candidate.context === "object"
        ? (candidate.context as TripContext)
        : {};
    const dates =
      candidate.dates && typeof candidate.dates === "object"
        ? (candidate.dates as DateHints)
        : {};
    const itinerary =
      candidate.itinerary && typeof candidate.itinerary === "object"
        ? (candidate.itinerary as Itinerary)
        : null;
    return { context, dates, itinerary };
  } catch {
    // Corrupt JSON or unavailable storage ⇒ empty default; never throw.
    return emptyState();
  }
}

/** Persist to `sessionStorage`; silently no-ops on the server or on any error. */
function writeStorage(state: SharedTripContextState): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota/availability errors must never break the planner.
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface TripContextProviderProps {
  children: ReactNode;
}

/**
 * Holds one `SharedTripContextState` for the session. Starts from the empty
 * default (so server and first client render agree), rehydrates from
 * `sessionStorage` on mount, and persists on every change.
 */
export function TripContextProvider({ children }: TripContextProviderProps) {
  // Start empty on both server and client to avoid hydration mismatch; the
  // mount effect below pulls any persisted value in immediately after.
  const [state, setState] = useState<SharedTripContextState>(emptyState);

  // Tracks whether rehydration has run, so the persist effect does not write
  // the empty default over good stored data before rehydration completes.
  const hydrated = useRef(false);

  // Rehydrate once on mount (client-only).
  useEffect(() => {
    const stored = readStorage();
    hydrated.current = true;
    setState(stored);
  }, []);

  // Persist on every change, but only after the initial rehydration.
  useEffect(() => {
    if (!hydrated.current) return;
    writeStorage(state);
  }, [state]);

  const setContext = useCallback((context: TripContext) => {
    setState((prev) => ({ ...prev, context }));
  }, []);

  const patchContext = useCallback((partial: Partial<TripContext>) => {
    setState((prev) => ({ ...prev, context: { ...prev.context, ...partial } }));
  }, []);

  const editField = useCallback(
    <K extends RequiredField>(field: K, value: TripContext[K]) => {
      setState((prev) => {
        // Mirror pure `editField` semantics: undefined deletes, else sets.
        const context: TripContext = { ...prev.context };
        if (value === undefined) {
          delete context[field];
        } else {
          context[field] = value;
        }
        return { ...prev, context };
      });
    },
    [],
  );

  const setItinerary = useCallback((itinerary: Itinerary | null) => {
    setState((prev) => ({ ...prev, itinerary }));
  }, []);

  const setDates = useCallback((dates: DateHints) => {
    setState((prev) => ({ ...prev, dates }));
  }, []);

  const patchDates = useCallback((partial: Partial<DateHints>) => {
    setState((prev) => ({ ...prev, dates: { ...prev.dates, ...partial } }));
  }, []);

  const reset = useCallback(() => {
    setState(emptyState());
  }, []);

  const value = useMemo<TripContextValue>(
    () => ({
      context: state.context,
      dates: state.dates,
      itinerary: state.itinerary,
      setContext,
      patchContext,
      editField,
      setDates,
      patchDates,
      reset,
      setItinerary,
    }),
    [state, setContext, patchContext, editField, setDates, patchDates, reset, setItinerary],
  );

  return (
    <SharedTripContext.Provider value={value}>
      {children}
    </SharedTripContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Access the Shared_Trip_Context state and actions. Throws a clear error when
 * used outside a `TripContextProvider`.
 */
export function useTripContext(): TripContextValue {
  const value = useContext(SharedTripContext);
  if (value === null) {
    throw new Error(
      "useTripContext must be used within a <TripContextProvider>.",
    );
  }
  return value;
}
