/**
 * Context_Registry: a module-level store of per-page context slots.
 * Pure and client-safe (no React import). Components subscribe through
 * `subscribe` + `getMergedContext` (e.g. with useSyncExternalStore).
 */
import type { PageActionHandlers, PageContextSlot, PageId } from "./types";

export type { PageId, PageActionHandlers, PageContextSlot } from "./types";

export interface MergedContext {
  summary: string;
  data: unknown;
  actions: PageActionHandlers;
}

interface Entry {
  slot: PageContextSlot;
}

/** Insertion-ordered; re-registering a (page, slot) replaces it in place. */
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
/** Bumped on every change; used to cache merged results per page. */
let version = 0;
const mergeCache = new Map<PageId, { version: number; value: MergedContext }>();

function keyOf(page: PageId, slot: string): string {
  return `${page}\u0000${slot}`;
}

function notify(): void {
  version += 1;
  mergeCache.clear();
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch {
      // A failing listener must not break other subscribers.
    }
  }
}

/** Registers (or replaces) a slot. Returns an unregister function. */
export function registerContext(slot: PageContextSlot): () => void {
  const key = keyOf(slot.page, slot.slot);
  const entry: Entry = { slot };
  entries.set(key, entry);
  notify();
  return () => {
    // Only remove if this registration is still the current one, so a stale
    // cleanup cannot drop a newer registration for the same slot.
    if (entries.get(key) === entry) {
      entries.delete(key);
      notify();
    }
  };
}

/**
 * Merges every slot registered for `page`. Summaries are joined with a
 * newline, data is keyed by slot name, actions are shallow-merged (later
 * registrations win). Returns a stable object until the registry changes.
 */
export function getMergedContext(page: PageId): MergedContext {
  const cached = mergeCache.get(page);
  if (cached && cached.version === version) return cached.value;

  const summaries: string[] = [];
  const data: Record<string, unknown> = {};
  const actions: PageActionHandlers = {};

  for (const { slot } of entries.values()) {
    if (slot.page !== page) continue;
    if (slot.summary) summaries.push(slot.summary);
    if (slot.data !== undefined) data[slot.slot] = slot.data;
    if (slot.actions) Object.assign(actions, slot.actions);
  }

  const value: MergedContext = {
    summary: summaries.join("\n"),
    data,
    actions,
  };
  mergeCache.set(page, { version, value });
  return value;
}

/** Subscribes to registry changes. Returns an unsubscribe function. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
