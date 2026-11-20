import { useSyncExternalStore } from "react";

/**
 * Tiny module-level store for the account sync status (requirements 4.5, 5.5, 7.5).
 * Any module can call the setters; components read it with `useSyncStatus`.
 */

export type SyncStatus =
  | { state: "idle"; note?: string }
  | { state: "saving"; note?: string }
  | { state: "saved"; note?: string }
  | { state: "failed"; retry?: () => void; note?: string }
  | { state: "unavailable"; note?: string };

const IDLE: SyncStatus = { state: "idle" };

let current: SyncStatus = IDLE;
const listeners = new Set<() => void>();

function emit(next: SyncStatus): void {
  current = next;
  for (const l of Array.from(listeners)) {
    try {
      l();
    } catch {
      /* a listener must not break others */
    }
  }
}

export function getSyncStatus(): SyncStatus {
  return current;
}

export function subscribeSyncStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setSyncIdle(note?: string): void {
  emit(note ? { state: "idle", note } : IDLE);
}
export function setSyncSaving(note?: string): void {
  emit({ state: "saving", note });
}
export function setSyncSaved(note?: string): void {
  emit({ state: "saved", note });
}
export function setSyncFailed(retry?: () => void, note?: string): void {
  emit({ state: "failed", retry, note });
}
export function setSyncUnavailable(note?: string): void {
  emit({ state: "unavailable", note });
}

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(subscribeSyncStatus, getSyncStatus, () => IDLE);
}
