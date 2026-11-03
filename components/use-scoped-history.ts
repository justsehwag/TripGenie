"use client";

/**
 * useScopedHistory() — the unified client-side history/drafts service
 * (design section "Components and Interfaces" §5 "useScopedHistory() hook";
 * Requirements 2.2, 2.3, 3.1, 3.2, 3.6, 4.8, 4.9, 5.4, 7.1, 7.2, 7.5).
 *
 * One interface, two scope-backed implementations:
 *   • Guest scope   → Local_Store (device-only localStorage; owner "@local").
 *   • Signed-in scope → the Trip_Store adapter over `/api/trips`
 *                       (GET ?owner=<userId>, idempotent POST, owner-scoped DELETE).
 *
 * Scope is resolved by the single pure resolver `resolveScope(readSession())`.
 * `readSession()` parses the browser-local `tripgenie.session` key with the
 * EXACT logic used by my-trips-client.tsx and global-nav.tsx (JSON-parse,
 * require a non-empty trimmed `userId`, treat corrupt JSON as anonymous). The
 * hook re-reads scope on a window `storage` event for `tripgenie.session`
 * (mirroring the global-nav session bridge), so a sign-out immediately
 * re-scopes the Drawer/History and never leaks the prior user's cloud records
 * to a later guest.
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

/** The browser-local key the session seam reads (same as my-trips/global-nav). */
const SESSION_KEY = "tripgenie.session";

/**
 * Resolve the current session from the browser-local seam, using the same parse
 * logic as my-trips-client.tsx / global-nav.tsx: JSON-parse the stored value,
 * require `typeof userId === "string"` with a non-empty trimmed value, and
 * treat any corrupt / missing value as anonymous (never as another traveler).
 * SSR-guarded: returns null on the server.
 */
function readSession(): IdentitySession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<IdentitySession>;
    if (parsed && typeof parsed.userId === "string" && parsed.userId.trim()) {
      return {
        userId: parsed.userId.trim(),
        firstName: typeof parsed.firstName === "string" ? parsed.firstName : undefined,
        email: typeof parsed.email === "string" ? parsed.email : undefined,
      };
    }
  } catch {
    // A corrupt session is treated as anonymous, never as another traveler.
  }
  return null;
}

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
  // Resolve scope once on mount (or from the override), then re-resolve on a
  // `storage` event for `tripgenie.session` (or a cleared key). SSR-guarded.
  const [scope, setScope] = useState<Scope>(() =>
    resolveScope(sessionOverride === undefined ? readSession() : sessionOverride),
  );

  useEffect(() => {
    if (sessionOverride !== undefined) {
      // Explicit override drives scope directly; no storage bridge needed.
      setScope(resolveScope(sessionOverride));
      return;
    }
    if (typeof window === "undefined") return;
    setScope(resolveScope(readSession()));
    function onStorage(e: StorageEvent) {
      if (e.key === SESSION_KEY || e.key === null) {
        setScope(resolveScope(readSession()));
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [sessionOverride]);

  const [items, setItems] = useState<StoredTrip[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Reload the current scope's records. Guest → Local_Store; signed-in →
   * GET /api/trips?owner=<userId> (parsed `{ trips }`). Never throws; on a
   * signed-in load failure it surfaces an error and leaves items unchanged.
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
      const res = await fetch(
        `/api/trips?owner=${encodeURIComponent(scope.userId)}`,
        { headers: { accept: "application/json" }, cache: "no-store" },
      );
      if (!res.ok) throw new Error(`Request failed (${res.status}).`);
      const body = (await res.json()) as { trips?: StoredTrip[] };
      setItems(Array.isArray(body.trips) ? body.trips : []);
    } catch {
      setError("We could not load your plans. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [scope]);

  // Initial load, re-run whenever scope changes (sign-in / sign-out re-scopes).
  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * Save a draft/plan. Guest saves go to Local_Store and are always locally
   * "persisted" (device-only). Signed-in saves POST to /api/trips (idempotent
   * by owner+clientDraftId). On a signed-in persist-failure (non-OK response,
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

      const signedInput: SaveInput = { ...input, owner: scope.userId };
      try {
        const res = await fetch("/api/trips", {
          method: "POST",
          headers: { "content-type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({
            owner: scope.userId,
            clientDraftId: signedInput.clientDraftId,
            name: signedInput.name,
            status: signedInput.status,
            payload: signedInput.payload,
            ttl: signedInput.ttl,
          }),
        });
        if (!res.ok) throw new Error(`Save failed (${res.status}).`);
        const body = (await res.json()) as { persisted?: boolean };
        if (body.persisted !== true) {
          // Persist-failure fallback: keep the Draft on this device (R5.4).
          saveLocal(signedInput);
          setError(
            "We saved this plan on this device, but could not sync it to your account. Please try again.",
          );
          return { persisted: false };
        }
        await reload();
        return { persisted: true };
      } catch {
        // Network / non-OK failure fallback: keep the Draft on this device (R5.4).
        saveLocal(signedInput);
        setError(
          "We saved this plan on this device, but could not sync it to your account. Please try again.",
        );
        return { persisted: false };
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
          headers: { "content-type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({ owner: scope.userId, tripId }),
        });
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
