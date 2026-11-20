/**
 * Client-side account session helper (account-sync, tasks 6.3).
 *
 * The server cookie is the only credential. This module never stores tokens,
 * passwords or a userId-as-owner. `tripgenie.session` holds a display-only
 * cache `{ email, name? }`. Every storage access is guarded and never throws.
 */

export const SESSION_KEY = "tripgenie.session";
export const PREFERENCES_KEY = "tripgenie.preferences.v1";
export const GUEST_HISTORY_KEY = "tripgenie.history.guest.v1";
export const MIGRATION_FLAG_KEY = "tripgenie.migrated.v2";
export const SESSION_EVENT = "tripgenie:session";

/** Cached account data cleared on sign-out. */
export const CACHED_TRIPS_KEY = "tripgenie.cache.trips.v1";
export const CACHED_PROFILE_KEY = "tripgenie.cache.profile.v1";

/** Keys that must survive sign-out and migration. */
const KEEP_KEYS: ReadonlySet<string> = new Set([PREFERENCES_KEY, GUEST_HISTORY_KEY]);

/** Old account-scoped keys (keyed by typed email) and account caches. */
const ACCOUNT_KEY_PATTERNS: readonly RegExp[] = [
  /^tripgenie\.history\./,
  /^tripgenie\.trips\./,
  /^tripgenie\.profile\./,
  /^tripgenie\.cache\./,
];

export interface SessionUser {
  email: string;
  name?: string;
}

export interface SessionState {
  signedIn: boolean;
  user?: SessionUser;
  /** True when the check failed because of a network error. */
  error?: boolean;
}

function storage(): Storage | null {
  try {
    const s = (globalThis as { localStorage?: Storage }).localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

function isAccountKey(key: string): boolean {
  if (KEEP_KEYS.has(key)) return false;
  return ACCOUNT_KEY_PATTERNS.some((re) => re.test(key));
}

function allKeys(s: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k !== null) keys.push(k);
  }
  return keys;
}

function removeAccountCaches(s: Storage): void {
  for (const k of allKeys(s)) {
    if (isAccountKey(k)) {
      try { s.removeItem(k); } catch { /* ignore */ }
    }
  }
  for (const k of [CACHED_TRIPS_KEY, CACHED_PROFILE_KEY]) {
    try { s.removeItem(k); } catch { /* ignore */ }
  }
}

/** Notify subscribers (same tab) that the session state changed. */
export function notifySession(state: SessionState): void {
  const g = globalThis as {
    dispatchEvent?: (e: Event) => boolean;
    CustomEvent?: typeof CustomEvent;
  };
  try {
    if (typeof g.dispatchEvent === "function" && typeof g.CustomEvent === "function") {
      g.dispatchEvent(new g.CustomEvent(SESSION_EVENT, { detail: state }));
    }
  } catch { /* ignore */ }
}

/** Subscribe to session changes. Returns an unsubscribe function. */
export function subscribeSession(listener: (state: SessionState) => void): () => void {
  const g = globalThis as {
    addEventListener?: (t: string, l: (e: Event) => void) => void;
    removeEventListener?: (t: string, l: (e: Event) => void) => void;
  };
  if (typeof g.addEventListener !== "function") return () => {};
  const handler = (e: Event) => listener((e as CustomEvent<SessionState>).detail);
  g.addEventListener(SESSION_EVENT, handler);
  return () => g.removeEventListener?.(SESSION_EVENT, handler);
}

function writeDisplayCache(user: SessionUser | undefined): void {
  const s = storage();
  if (!s) return;
  try {
    if (user && user.email) {
      const cache: SessionUser = { email: user.email };
      if (user.name) cache.name = user.name;
      s.setItem(SESSION_KEY, JSON.stringify(cache));
    } else {
      s.removeItem(SESSION_KEY);
    }
  } catch { /* ignore */ }
}

/** Ask the server who is signed in. Never throws. */
export async function fetchSession(): Promise<SessionState> {
  let state: SessionState;
  try {
    const res = await fetch("/api/auth/session", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!res.ok) {
      state = { signedIn: false };
    } else {
      const body = (await res.json()) as { signedIn?: boolean; user?: { email?: string; name?: string } };
      if (body && body.signedIn === true && body.user && typeof body.user.email === "string") {
        const user: SessionUser = { email: body.user.email };
        if (typeof body.user.name === "string" && body.user.name) user.name = body.user.name;
        state = { signedIn: true, user };
      } else {
        state = { signedIn: false };
      }
    }
  } catch {
    // Network failure: report the error but leave local state untouched.
    return { signedIn: false, error: true };
  }
  writeDisplayCache(state.user);
  notifySession(state);
  return state;
}

/**
 * Sign out on the server, then clear the signed-in state and cached account
 * data on this device. Preferences and guest history are kept.
 */
export async function signOut(): Promise<void> {
  try {
    await fetch("/api/auth", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "signout" }),
    });
  } catch {
    // Local state is cleared even if the server call fails.
  }
  clearLocalAccountState();
  notifySession({ signedIn: false });
}

/** Clear the display cache and cached account data; keep preferences and guest history. */
export function clearLocalAccountState(): void {
  const s = storage();
  if (!s) return;
  try { s.removeItem(SESSION_KEY); } catch { /* ignore */ }
  removeAccountCaches(s);
}

/** A 401 from any account call: drop signed-in state, keep local drafts. */
export function handleUnauthorized(): void {
  const s = storage();
  if (s) {
    try { s.removeItem(SESSION_KEY); } catch { /* ignore */ }
  }
  notifySession({ signedIn: false });
}

/**
 * One-time cleanup of old email-keyed account storage. Keeps guest history and
 * preferences. Returns true when the migration ran on this call.
 */
export function runMigrationV2(): boolean {
  const s = storage();
  if (!s) return false;
  try {
    if (s.getItem(MIGRATION_FLAG_KEY)) return false;
    removeAccountCaches(s);
    // The old session value held { userId, email }; drop userId, keep display email.
    const raw = s.getItem(SESSION_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { email?: unknown; name?: unknown };
        if (typeof parsed.email === "string" && parsed.email) {
          const cache: SessionUser = { email: parsed.email };
          if (typeof parsed.name === "string" && parsed.name) cache.name = parsed.name;
          s.setItem(SESSION_KEY, JSON.stringify(cache));
        } else {
          s.removeItem(SESSION_KEY);
        }
      } catch {
        s.removeItem(SESSION_KEY);
      }
    }
    s.setItem(MIGRATION_FLAG_KEY, "1");
    return true;
  } catch {
    return false;
  }
}
