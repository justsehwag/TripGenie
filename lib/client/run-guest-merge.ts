import {
  applyMergeResults,
  droppedCount,
  planMerge,
  type MergeResult,
} from "@/lib/account/merge";
import { handleUnauthorized, GUEST_HISTORY_KEY } from "@/lib/client/account-session";
import {
  setSyncFailed,
  setSyncIdle,
  setSyncSaved,
  setSyncSaving,
  setSyncUnavailable,
} from "@/lib/client/use-sync-status";
import { parseLocalHistory } from "@/lib/history/local-store";

/**
 * Uploads Guest_History to the account one trip at a time (requirements 5.1,
 * 5.3-5.5, 5.7). A guest trip is removed only after its own confirmed response.
 */

export interface MergeDeps {
  fetch?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  /** Called on 401. Defaults to `handleUnauthorized`. */
  onUnauthorized?: () => void;
}

export type MergeOutcome =
  | "nothing"
  | "merged"
  | "unauthorized"
  | "unavailable"
  | "failed"
  | "busy";

export interface MergeSummary {
  outcome: MergeOutcome;
  uploaded: number;
  remaining: number;
  pruned: number;
  /** e.g. "2 older trips were not kept"; undefined when nothing was dropped. */
  message?: string;
}

let running = false;

function defaultStorage(): MergeDeps["storage"] {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function prunedMessage(n: number): string | undefined {
  if (n <= 0) return undefined;
  return n === 1 ? "1 older trip was not kept" : `${n} older trips were not kept`;
}

export async function runGuestMerge(deps: MergeDeps = {}): Promise<MergeSummary> {
  if (running) return { outcome: "busy", uploaded: 0, remaining: 0, pruned: 0 };
  running = true;
  try {
    const store = deps.storage === undefined ? defaultStorage() : deps.storage;
    const doFetch = deps.fetch ?? (typeof fetch === "function" ? fetch : undefined);
    const unauthorized = deps.onUnauthorized ?? handleUnauthorized;
    if (!store || !doFetch) return { outcome: "nothing", uploaded: 0, remaining: 0, pruned: 0 };

    const read = () => {
      try {
        return parseLocalHistory(store.getItem(GUEST_HISTORY_KEY));
      } catch {
        return [];
      }
    };
    const guest = read();
    const uploads = planMerge(guest);
    if (uploads.length === 0) return { outcome: "nothing", uploaded: 0, remaining: 0, pruned: 0 };

    setSyncSaving();
    const results: MergeResult[] = [];
    let outcome: MergeOutcome = "merged";

    for (const upload of uploads) {
      let res: Response;
      try {
        res = await doFetch("/api/trips", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(upload),
        });
      } catch {
        outcome = "failed";
        break;
      }
      if (res.status === 401) {
        unauthorized();
        outcome = "unauthorized";
        break;
      }
      if (res.status === 503) {
        outcome = "unavailable";
        break;
      }
      if (!res.ok) {
        outcome = "failed";
        break;
      }
      let body: { pruned?: unknown } | null = null;
      try {
        body = (await res.json()) as { pruned?: unknown };
      } catch {
        body = null;
      }
      const pruned = typeof body?.pruned === "number" ? body.pruned : 0;
      results.push({ clientDraftId: upload.clientDraftId, ok: true, pruned });

      // Remove only this confirmed trip, re-reading storage to avoid clobbering new saves.
      try {
        const kept = read().filter((t) => t.clientDraftId !== upload.clientDraftId);
        if (kept.length === 0) store.removeItem(GUEST_HISTORY_KEY);
        else store.setItem(GUEST_HISTORY_KEY, JSON.stringify(kept));
      } catch {
        /* keep going; the trip stays and a later run is idempotent */
      }
    }

    const pruned = droppedCount(results);
    const message = prunedMessage(pruned);
    const remaining = applyMergeResults(guest, results).length;
    if (outcome === "merged") setSyncSaved(message);
    else if (outcome === "unavailable") setSyncUnavailable(message);
    else if (outcome === "failed") setSyncFailed(() => void runGuestMerge(deps), message);
    else setSyncIdle(message);

    return { outcome, uploaded: results.length, remaining, pruned, message };
  } finally {
    running = false;
  }
}
