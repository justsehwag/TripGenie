import type { StoredTrip } from "@/lib/trip-retention";

/**
 * Pure, client-safe guest-merge helpers (design: "Guest merge flow").
 * No IO, no window, no fetch. The runner uploads one trip at a time and removes
 * a guest trip only after its own confirmed response.
 *
 * Requirements: 5.1, 5.3, 5.4, 5.5.
 */

/** One upload body for `POST /api/trips` with `mode: "merge"`. */
export interface MergeUpload {
  clientDraftId: string;
  name: string;
  status: string;
  payload: Record<string, unknown>;
  /** Guest record's own `updatedAt` (server clamps it). */
  updatedAt: string;
  mode: "merge";
}

/** Outcome of one upload, keyed by the trip's `clientDraftId`. */
export interface MergeResult {
  clientDraftId: string;
  /** True only when the server confirmed the trip (created or already present). */
  ok: boolean;
  /** `pruned` reported by the server for this upload. */
  pruned?: number;
}

/**
 * One upload per guest trip, deduped by `clientDraftId` (first occurrence wins),
 * in original order.
 */
export function planMerge(guestTrips: StoredTrip[]): MergeUpload[] {
  const seen = new Set<string>();
  const uploads: MergeUpload[] = [];
  for (const t of guestTrips) {
    if (seen.has(t.clientDraftId)) continue;
    seen.add(t.clientDraftId);
    uploads.push({
      clientDraftId: t.clientDraftId,
      name: t.name,
      status: t.status,
      payload: t.payload,
      updatedAt: t.updatedAt,
      mode: "merge",
    });
  }
  return uploads;
}

/**
 * Trips that must stay in Guest_History: every trip without a confirmed
 * (`ok: true`) result, in original order. Trips with no result (not attempted,
 * e.g. after a crash) are kept.
 */
export function applyMergeResults(
  guestTrips: StoredTrip[],
  results: MergeResult[],
): StoredTrip[] {
  const confirmed = new Set<string>();
  for (const r of results) {
    if (r.ok) confirmed.add(r.clientDraftId);
  }
  return guestTrips.filter((t) => !confirmed.has(t.clientDraftId));
}

/** Sum of `pruned` reported by the server (non-finite or negative values count as 0). */
export function droppedCount(results: MergeResult[]): number {
  let total = 0;
  for (const r of results) {
    const p = r.pruned;
    if (typeof p === "number" && Number.isFinite(p) && p > 0) total += p;
  }
  return total;
}
