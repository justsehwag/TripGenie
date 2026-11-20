/**
 * Client-side preferences sync (account-sync task 6.7, requirements 6.1-6.5).
 *
 * Local storage is always written first. For a signed-in user the values are
 * then sent to /api/preferences with optimistic versioning. A failure keeps
 * the values in storage and reports Sync_Status "failed" with a retry control.
 */

import { handleUnauthorized } from "./account-session";
import { setSyncFailed, setSyncSaved, setSyncSaving, setSyncUnavailable } from "./use-sync-status";
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  normalizePreferences,
  savePreferences,
  type TravelPreferences,
} from "../preferences";

export const PREFERENCES_VERSION_KEY = "tripgenie.preferences.version.v1";

export type PushResult =
  | { ok: true; version: number }
  | { ok: false; reason: "unauthorized" | "unavailable" | "failed" | "conflict" };

export type PullResult =
  | { kind: "applied"; preferences: TravelPreferences; version: number }
  | { kind: "uploaded"; version: number }
  | { kind: "unchanged" }
  | { kind: "unauthorized" }
  | { kind: "failed"; reason: "unavailable" | "failed" };

export function getStoredVersion(): number {
  try {
    const raw = window.localStorage.getItem(PREFERENCES_VERSION_KEY);
    const n = raw === null ? 0 : Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function setStoredVersion(version: number): void {
  try {
    window.localStorage.setItem(PREFERENCES_VERSION_KEY, String(version));
  } catch {
    /* storage unavailable: the version is re-read from the server next time */
  }
}

function sameAsDefault(prefs: TravelPreferences): boolean {
  return JSON.stringify(normalizePreferences(prefs)) === JSON.stringify(DEFAULT_PREFERENCES);
}

async function putOnce(
  prefs: TravelPreferences,
  expectedVersion: number,
): Promise<{ status: number; version?: number; currentVersion?: number }> {
  const res = await fetch("/api/preferences", {
    method: "PUT",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ preferences: normalizePreferences(prefs), expectedVersion }),
  });
  let body: { version?: unknown; currentVersion?: unknown } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* empty or non-JSON body */
  }
  return {
    status: res.status,
    version: typeof body.version === "number" ? body.version : undefined,
    currentVersion: typeof body.currentVersion === "number" ? body.currentVersion : undefined,
  };
}

/**
 * PUT the preferences. On 409 retries once with the server's `currentVersion`
 * (last write wins). Never throws and does not touch Sync_Status.
 */
export async function putPreferences(
  prefs: TravelPreferences,
  expectedVersion: number = getStoredVersion(),
  retryOnConflict = true,
): Promise<PushResult> {
  try {
    let r = await putOnce(prefs, expectedVersion);
    if (r.status === 409 && !retryOnConflict) return { ok: false, reason: "conflict" };
    if (r.status === 409 && r.currentVersion !== undefined) {
      r = await putOnce(prefs, r.currentVersion);
    }
    if (r.status === 200 && r.version !== undefined) {
      setStoredVersion(r.version);
      return { ok: true, version: r.version };
    }
    if (r.status === 401) return { ok: false, reason: "unauthorized" };
    if (r.status === 503) return { ok: false, reason: "unavailable" };
    return { ok: false, reason: "failed" };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** Save locally first, then sync. Reports Sync_Status and offers a retry on failure. */
export async function saveAndSyncPreferences(prefs: TravelPreferences): Promise<PushResult> {
  setSyncSaving();
  const result = await putPreferences(prefs);
  if (result.ok) {
    setSyncSaved();
  } else if (result.reason === "unauthorized") {
    handleUnauthorized();
    setSyncUnavailable("Sign in to sync. Your preferences are saved on this device.");
  } else if (result.reason === "unavailable") {
    // 503: account storage is down; values stay local with a retry control.
    setSyncFailed(() => {
      void saveAndSyncPreferences(prefs);
    }, "Sync is unavailable right now. Your preferences are saved on this device.");
  } else {
    setSyncFailed(() => {
      void saveAndSyncPreferences(prefs);
    }, "Could not sync. Your preferences are saved on this device.");
  }
  return result;
}

/**
 * On session start: apply the server preferences in place of local ones, or
 * upload the local ones once (expectedVersion 0) when the server has none.
 */
export async function pullPreferences(allowRepull = true): Promise<PullResult> {
  try {
    const res = await fetch("/api/preferences", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
    if (res.status === 401) {
      handleUnauthorized();
      return { kind: "unauthorized" };
    }
    if (res.status === 503) return { kind: "failed", reason: "unavailable" };
    if (!res.ok) return { kind: "failed", reason: "failed" };

    const body = (await res.json()) as { preferences?: unknown; version?: unknown };
    const version = typeof body.version === "number" ? body.version : 0;

    if (version > 0 && body.preferences && typeof body.preferences === "object") {
      const preferences = normalizePreferences(body.preferences);
      savePreferences(preferences);
      setStoredVersion(version);
      return { kind: "applied", preferences, version };
    }

    const local = loadPreferences();
    if (sameAsDefault(local)) {
      setStoredVersion(0);
      return { kind: "unchanged" };
    }

    setSyncSaving();
    const pushed = await putPreferences(local, 0, false);
    if (pushed.ok) {
      setSyncSaved();
      return { kind: "uploaded", version: pushed.version };
    }
    if (pushed.reason === "conflict" && allowRepull) {
      // Another device uploaded first: adopt its values instead of overwriting.
      return pullPreferences(false);
    }
    if (pushed.reason === "unauthorized") {
      handleUnauthorized();
      return { kind: "unauthorized" };
    }
    setSyncFailed(() => {
      void saveAndSyncPreferences(local);
    }, "Could not sync. Your preferences are saved on this device.");
    return { kind: "failed", reason: pushed.reason === "unavailable" ? "unavailable" : "failed" };
  } catch {
    return { kind: "failed", reason: "failed" };
  }
}
