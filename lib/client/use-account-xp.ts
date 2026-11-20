"use client";

/**
 * Account-stored XP hook (xp-account-sync, task 3.1).
 *
 * XP lives in memory only. The server (`/api/xp`) is the single authority for
 * totals; this hook never computes a total locally and never writes XP to
 * localStorage or sessionStorage. Guests make no API calls.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { emptyXp, type XpEvent, type XpState } from "@/lib/gamification";
import { handleUnauthorized } from "@/lib/client/account-session";

export type AccountXpStatus = "guest" | "loading" | "ready" | "error";

export interface AccountXp {
  status: AccountXpStatus;
  /** Last known state from the server, memory only. Null for guests or before the first response. */
  state: XpState | null;
  error?: string;
  /** Award an event for a signed-in user. No-op for guests. Never throws. */
  award(event: XpEvent, key: string): Promise<void>;
  /** Repeat the XpState request. */
  retry(): void;
}

export const XP_CLEANUP_MARKER = "tripgenie.xp-cleanup.v1";
const XP_KEY_PREFIX = "tripgenie.xp";
const LOAD_ERROR = "Couldn't load your XP. Please try again.";
const AWARD_ERROR = "Couldn't save your XP. Please try again.";

/** Build an XpState from a server response. Returns null when malformed. */
function toXpState(body: unknown): XpState | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { total?: unknown; awarded?: unknown };
  if (typeof b.total !== "number" || !Number.isFinite(b.total)) return null;
  const base = emptyXp();
  const awarded = Array.isArray(b.awarded)
    ? (b.awarded.filter((e) => typeof e === "string") as XpEvent[])
    : base.awarded;
  return { ...base, total: b.total, awarded };
}

/** Remove legacy `tripgenie.xp*` keys once per browser profile. Never throws. */
function cleanupLegacyXpStorage(): void {
  if (typeof window === "undefined") return;
  for (const getStore of [
    () => window.localStorage,
    () => window.sessionStorage,
  ]) {
    try {
      const s = getStore();
      if (!s) continue;
      if (s === window.localStorage && s.getItem(XP_CLEANUP_MARKER)) return;
      const doomed: string[] = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k !== null && k.startsWith(XP_KEY_PREFIX) && k !== XP_CLEANUP_MARKER) doomed.push(k);
      }
      for (const k of doomed) s.removeItem(k);
    } catch {
      /* storage unavailable: ignore */
    }
  }
  try {
    // Marker is non-XP data and is the only value this hook ever stores.
    window.localStorage.setItem(XP_CLEANUP_MARKER, "1");
  } catch {
    /* ignore */
  }
}

export function useAccountXp(signedIn: boolean | null): AccountXp {
  const [state, setState] = useState<XpState | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(false);
  /** Bumped on sign-in change/unmount so late responses are dropped. */
  const epoch = useRef(0);
  const signedInRef = useRef<boolean | null>(signedIn);
  signedInRef.current = signedIn;

  useEffect(() => {
    cleanupLegacyXpStorage();
  }, []);

  const load = useCallback(async (): Promise<void> => {
    const my = epoch.current;
    setLoading(true);
    try {
      const res = await fetch("/api/xp", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
      if (my !== epoch.current) return;
      if (res.status === 401) {
        setState(null);
        setError(undefined);
        setLoading(false);
        handleUnauthorized();
        return;
      }
      if (!res.ok) throw new Error("xp-get-failed");
      const next = toXpState(await res.json());
      if (my !== epoch.current) return;
      if (!next) throw new Error("xp-get-malformed");
      setState(next);
      setError(undefined);
    } catch {
      if (my !== epoch.current) return;
      setError(LOAD_ERROR);
    }
    if (my === epoch.current) setLoading(false);
  }, []);

  useEffect(() => {
    epoch.current += 1;
    if (signedIn === true) {
      void load();
    } else {
      // Guest, signed out, or session unknown: hold no XP in memory.
      setState(null);
      setError(undefined);
      setLoading(signedIn === null);
    }
    return () => {
      epoch.current += 1;
    };
  }, [signedIn, load]);

  const award = useCallback(async (event: XpEvent, key: string): Promise<void> => {
    if (signedInRef.current !== true) return;
    const my = epoch.current;
    try {
      const res = await fetch("/api/xp", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, idempotencyKey: key }),
      });
      if (my !== epoch.current) return;
      if (res.status === 401) {
        setState(null);
        setError(undefined);
        handleUnauthorized();
        return;
      }
      if (!res.ok) throw new Error("xp-post-failed");
      const next = toXpState(await res.json());
      if (my !== epoch.current) return;
      if (!next) throw new Error("xp-post-malformed");
      setState(next);
      setError(undefined);
    } catch {
      if (my !== epoch.current) return;
      setError(AWARD_ERROR);
    }
  }, []);

  const retry = useCallback((): void => {
    if (signedInRef.current !== true) return;
    void load();
  }, [load]);

  let status: AccountXpStatus;
  if (signedIn === false) status = "guest";
  else if (signedIn === null) status = "loading";
  else if (state === null && error) status = "error";
  else if (error) status = "error";
  else if (state === null || loading) status = state === null ? "loading" : "ready";
  else status = "ready";

  return { status, state, error, award, retry };
}
