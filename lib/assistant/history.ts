/**
 * Pure undo stack for applied assistant edits. Client-safe, immutable.
 * Newest entry last. Capped at MAX_HISTORY_ENTRIES (>= 20 required).
 */
import type { Itinerary } from "../types";
import type { AppliedEdit, HistoryState } from "./types";

export const MAX_HISTORY_ENTRIES = 50;

export function emptyHistory(): HistoryState {
  return { entries: [] };
}

/** Stable JSON: object keys sorted, undefined dropped. Never throws. */
function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) return null;
    seen.add(v as object);
    if (Array.isArray(v)) {
      const arr = v.map((x) => walk(x));
      seen.delete(v as object);
      return arr;
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined && typeof x !== "function") out[k] = walk(x);
    }
    seen.delete(v as object);
    return out;
  };
  try {
    return JSON.stringify(walk(value)) ?? "";
  } catch {
    return "";
  }
}

/** Stable fingerprint of an itinerary (key-order independent JSON). */
export function itineraryFingerprint(it: Itinerary | null | undefined): string {
  return it ? stableStringify(it) : "";
}

/** Appends an entry; drops the oldest entries beyond the cap. Returns a new state. */
export function pushEdit(history: HistoryState, edit: AppliedEdit): HistoryState {
  const entries = [...history.entries, edit];
  const start = Math.max(0, entries.length - MAX_HISTORY_ENTRIES);
  return { entries: start > 0 ? entries.slice(start) : entries };
}

/** Removes the newest entry. `edit` is null when the stack is empty. */
export function popEdit(history: HistoryState): { history: HistoryState; edit: AppliedEdit | null } {
  if (history.entries.length === 0) return { history, edit: null };
  return {
    history: { entries: history.entries.slice(0, -1) },
    edit: history.entries[history.entries.length - 1],
  };
}

/**
 * True only when the stack is non-empty and the current itinerary is the one the
 * newest edit produced (same reference, or identical fingerprint). Guards stale undo
 * after other changes such as Edit Day.
 */
export function canUndo(history: HistoryState, currentItinerary: Itinerary | null | undefined): boolean {
  const top = history.entries[history.entries.length - 1];
  if (!top || !currentItinerary) return false;
  if (top.after === currentItinerary) return true;
  return itineraryFingerprint(top.after) === itineraryFingerprint(currentItinerary);
}
