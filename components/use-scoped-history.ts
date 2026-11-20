"use client";

/**
 * useScopedHistory() — the unified client-side history/drafts service
 * (design section "Components and Interfaces" §5 "useScopedHistory() hook";
 * Requirements 2.2, 2.3, 3.1, 3.2, 3.6, 4.8, 4.9, 5.4, 7.1, 7.2, 7.5).
 *
 * One interface, two scope-backed implementations:
 *   • Guest scope   → Local_Store (device-only localStorage; owner "@local").
 *   • Signed-in scope → the account trips API at `/api/trips` (GET, idempotent
 *                       POST, DELETE). The server derives the owner from the
 *                       session cookie; the client never sends `owner`/`userId`.
 *
 * Scope is resolved from the SERVER session: `fetchSession()` on mount, then
 * `subscribeSession()` for sign-in / sign-out / 401 changes (account-sync
 * Req 4.1, 4.7). The browser-local `tripgenie.session` value is only a display
 * cache and is never used to decide signed-in state. A sign-out immediately
 * re-scopes the Drawer/History and never leaks the prior user's records to a
 * later guest.
 *
 * Retention: the account keeps the newest 20 trips (enforced by the server);
 * the device-only guest store keeps the newest 5 (`lib/history/local-store`).
 *
 * After sign-in is detected the hook runs `runMigrationV2()` and
 * `runGuestMerge()` once each per page load, then reloads the account trips.
 *
 * Signed-in draft persist-failure fallback (R5.4): when a signed-in `save`
 * returns `persisted !== true` or throws, the Draft is written to Local_Store
 * for this device, an error is surfaced, and `{ persisted: false }` is
 * returned — captured data is never lost.
 *
 * This module imports ONLY client-safe modules (lib/history/*, lib/trip-retention
 * types, lib/identity type) and the DOM `fetch`. It NEVER imports Cognito /
 * SerpApi / config / Bedrock or any server-only secret, and never places a
 * secret in a client payload.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { IdentitySession } from "@/lib/identity";
import { resolveScope, type Scope } from "@/lib/history/scope";
import {
  readLocalHistory,
  saveLocal,
  removeLocal,
} from "@/lib/history/local-store";
import { toSharedContext, type CapturedPlan } from "@/lib/history/record-codec";
import type { SaveInput, StoredTrip } from "@/lib/trip-retention";
import {
  fetchSession,
  handleUnauthorized,
  runMigrationV2,
  subscribeSession,
  type SessionState,
} from "@/lib/client/account-session";
import { runGuestMerge } from "@/lib/client/run-guest-merge";
import {
  setSyncFailed,
  setSyncSaved,
  setSyncSaving,
  setSyncUnavailable,
} from "@/lib/client/use-sync-status";

/** Display label used as the scope's non-authoritative id (never sent to the server). */
function scopeFromSession(state: SessionState): Scope {
  return state.signedIn && state.user
    ? resolveScope({ userId: state.user.email })
    : { kind: "guest" };
}

/** Migration and guest merge each run at most once per page load, after sign-in. */
let postSignInStarted = false;

/** A trip whose stored status marks it a confirmed booking (reused from my-trips). */
function isConfirmedBooking(trip: StoredTrip): boolean {
  return trip.status.trim().toLowerCase() === "confirmed";
}

/** A trip that is still in progress and can be resumed (reused from my-trips). */
function isResumable(trip: StoredTrip): boolean {
  const s = trip.status.trim().toLowerCase();
  return s === "draft" || s === "in-progress" || s === "planning";
}

/** The public shape the Drawer / My Trips / planner consume. */
export interface ScopedHistory {
  scope: Scope;
  items: StoredTrip[];
  drafts: StoredTrip[]; // status in draft | in-progress | planning
  history: StoredTrip[]; // everything else (e.g. "ready")
  bookings: StoredTrip[]; // status === confirmed
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  save: (input: SaveInput) => Promise<{ persisted: boolean }>;
  remove: (tripId: string) => Promise<void>;
  resume: (tripId: string) => CapturedPlan | null;
}

/**
 * Scope-aware history/drafts service. `sessionOverride` mirrors the test seam
 * already present in my-trips-client.tsx / global-nav.tsx: pass `undefined`
 * (the default) to read from browser-local storage, or pass `null` to force an
 * explicitly-anonymous (guest) scope.
 */
export function useScopedHistory(
  sessionOverride?: IdentitySession | null,
): ScopedHistory {
  // Scope comes from the server session. `resolved` stays false until the first
  // fetchSession() settles, so the drawer shows a skeleton instead of flashing
  // the guest list (Req 4.1, 4.2). An explicit override resolves immediately.
  const [scope, setScope] = useState<Scope>(() =>
    sessionOverride === undefined ? { kind: "guest" } : resolveScope(sessionOverride),
  );
  const [resolved, setResolved] = useState<boolean>(sessionOverride !== undefined);

  useEffect(() => {
    if (sessionOverride !== undefined) {
      // Explicit override drives scope directly; no server session check.
      setScope(resolveScope(sessionOverride));
      setResolved(true);
      return;
    }
    let cancelled = false;
    const apply = (state: SessionState) => {
      if (cancelled) return;
      const next = scopeFromSession(state);
      setScope((prev) =>
        prev.kind === next.kind &&
        (prev.kind === "guest" || (next.kind === "signed-in" && prev.userId === next.userId))
          ? prev
          : next,
      );
      if (!state.error) setResolved(true);
      if (!state.signedIn && !state.error) postSignInStarted = false;
    };
    const unsubscribe = subscribeSession(apply);
    void fetchSession().then((state) => {
      // A network error leaves local data usable as a guest list.
      if (state.error) setResolved(true);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [sessionOverride]);

  const [items, setItems] = useState<StoredTrip[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Reload the current scope's records. Guest → Local_Store; signed-in →
   * GET /api/trips (the server derives the owner from the session cookie).
   * Never throws. On a 401 it calls handleUnauthorized(); on any signed-in load
   * failure it surfaces an error and keeps the data already on screen, falling
   * back to the device's local records when nothing is loaded yet (Req 4.3).
   */
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    if (scope.kind === "guest") {
      setItems(readLocalHistory());
      setLoading(false);
      return;
    }
    try {
      const res = await fetch("/api/trips", {
        method: "GET",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (res.status === 401) {
        handleUnauthorized();
        throw new Error("Signed out.");
      }
      if (!res.ok) throw new Error(`Request failed (${res.status}).`);
      const body = (await res.json()) as { trips?: StoredTrip[] };
      setItems(Array.isArray(body.trips) ? body.trips : []);
    } catch {
      setError("We could not load your plans. Please try again.");
      setItems((prev) => (prev.length > 0 ? prev : readLocalHistory()));
    } finally {
      setLoading(false);
    }
  }, [scope]);

  // Load once the session is known; re-run when scope changes (sign-in / sign-out).
  useEffect(() => {
    if (!resolved) return;
    void reload();
  }, [reload, resolved]);

  // After sign-in is detected: one-time storage migration, then the guest merge,
  // each once per page load. Reload the account trips if the merge uploaded any.
  useEffect(() => {
    if (!resolved || scope.kind !== "signed-in" || postSignInStarted) return;
    postSignInStarted = true;
    runMigrationV2();
    void runGuestMerge().then((summary) => {
      if (summary.uploaded > 0) void reload();
    });
  }, [resolved, scope, reload]);

  /**
   * Save a draft/plan. Guest saves go to Local_Store and are always locally
   * "persisted" (device-only, newest 5). Signed-in saves POST to /api/trips
   * (idempotent by session owner + clientDraftId; the account keeps the newest
   * 20) and set the sync status around the call. On a signed-in persist-failure (non-OK response,
   * `persisted !== true`, or a thrown error) the Draft falls back to
   * Local_Store for this device and an error is surfaced (R5.4); the promise
   * still resolves with `{ persisted: false }`.
   */
  const save = useCallback(
    async (input: SaveInput): Promise<{ persisted: boolean }> => {
      if (scope.kind === "guest") {
        saveLocal(input);
        setItems(readLocalHistory());
        return { persisted: true };
      }

      // The server derives the owner from the session cookie; none is sent.
      const syncFailedMessage =
        "We saved this plan on this device, but could not sync it to your account. Please try again.";
      const fallback = (): { persisted: false } => {
        // Persist-failure fallback: keep the Draft on this device (R5.4).
        saveLocal(input);
        setError(syncFailedMessage);
        return { persisted: false };
      };
      setSyncSaving();
      try {
        const res = await fetch("/api/trips", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({
            clientDraftId: input.clientDraftId,
            name: input.name,
            status: input.status,
            payload: input.payload,
            mode: "save",
          }),
        });
        if (res.status === 401) {
          handleUnauthorized();
          setSyncFailed();
          return fallback();
        }
        if (res.status === 503) {
          setSyncUnavailable();
          return fallback();
        }
        if (!res.ok) throw new Error(`Save failed (${res.status}).`);
        const body = (await res.json()) as { persisted?: boolean };
        if (body.persisted !== true) {
          setSyncFailed(() => void save(input));
          return fallback();
        }
        // Saved is shown only after the server confirms persistence (Req 4.5).
        setSyncSaved();
        await reload();
        return { persisted: true };
      } catch {
        // Network / non-OK failure fallback: keep the Draft on this device (R5.4).
        setSyncFailed(() => void save(input));
        return fallback();
      }
    },
    [scope, reload],
  );

  /**
   * Remove a record by tripId. Guest → Local_Store; signed-in → owner-scoped
   * DELETE /api/trips. On a signed-in delete failure the item is retained and
   * an error is surfaced (the list is not reloaded).
   */
  const remove = useCallback(
    async (tripId: string): Promise<void> => {
      if (scope.kind === "guest") {
        removeLocal(tripId);
        setItems(readLocalHistory());
        return;
      }
      setError(null);
      try {
        const res = await fetch("/api/trips", {
          method: "DELETE",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({ tripId }),
        });
        if (res.status === 401) {
          handleUnauthorized();
          throw new Error("Signed out.");
        }
        if (!res.ok) throw new Error(`Delete failed (${res.status}).`);
        await reload();
      } catch {
        setError("We could not delete that plan. Please try again.");
      }
    },
    [scope, reload],
  );

  /**
   * Resume: find the record in the current items and return its CapturedPlan
   * via the total codec. Returns null when the tripId is not in scope.
   */
  const resume = useCallback(
    (tripId: string): CapturedPlan | null => {
      const found = items.find((t) => t.tripId === tripId);
      if (!found) return null;
      return toSharedContext(found.payload);
    },
    [items],
  );

  // Classify items into drafts / bookings / history using the status helpers
  // reused from my-trips-client.tsx.
  const { drafts, history, bookings } = useMemo(() => {
    const drafts: StoredTrip[] = [];
    const history: StoredTrip[] = [];
    const bookings: StoredTrip[] = [];
    for (const item of items) {
      if (isConfirmedBooking(item)) {
        bookings.push(item);
      } else if (isResumable(item)) {
        drafts.push(item);
      } else {
        history.push(item);
      }
    }
    return { drafts, history, bookings };
  }, [items]);

  return {
    scope,
    items,
    drafts,
    history,
    bookings,
    loading,
    error,
    reload,
    save,
    remove,
    resume,
  };
}
