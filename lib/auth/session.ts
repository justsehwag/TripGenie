// SERVER-ONLY. Do not import from a "use client" module: this file pulls in the
// Cognito verifier, the token refresh client and node:crypto.
//
// resolveSession: turns the request's session cookies into an owner (or not),
// refreshing an expired ID token at most once per refresh token per instance.
// Never throws. Never logs tokens.
import { createHash } from "node:crypto";
import { JwtExpiredError } from "aws-jwt-verify/error";
import { isSecureOrigin, sessionMaxSeconds } from "../account/env";
import { logSafe } from "../log";
import { refreshTokens } from "./cognito-tokens";
import { buildClearCookies, buildSetCookies, parseSessionCookies } from "./session-cookie";
import { verifyIdToken, type IdTokenClaims } from "./verifier";

export type SessionResult =
  | { authenticated: true; sub: string; email?: string; name?: string; setCookies: string[] }
  | { authenticated: false; clearCookies: string[] };

export interface SessionDeps {
  verifyIdToken(token: string): Promise<IdTokenClaims>;
  refresh(refreshToken: string): Promise<{ idToken: string; refreshToken?: string }>;
  /** Current time in epoch milliseconds. */
  now(): number;
  /** Whether cookies use the Secure attribute and __Host- names. */
  secure: boolean;
}

/** Minimal request shape (a Fetch `Request` or `NextRequest` satisfies it). */
export interface SessionRequest {
  url?: string;
  headers: { get(name: string): string | null };
}

const inFlight = new Map<string, Promise<{ idToken: string; refreshToken?: string }>>();

/** Number of refreshes currently in flight (tests). */
export function inFlightRefreshCount(): number {
  return inFlight.size;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function singleFlightRefresh(
  refreshToken: string,
  refresh: SessionDeps["refresh"],
): Promise<{ idToken: string; refreshToken?: string }> {
  const key = hashToken(refreshToken);
  const existing = inFlight.get(key);
  if (existing) return existing;
  let promise: Promise<{ idToken: string; refreshToken?: string }>;
  try {
    promise = Promise.resolve(refresh(refreshToken));
  } catch (err) {
    promise = Promise.reject(err);
  }
  const tracked = promise.finally(() => {
    if (inFlight.get(key) === tracked) inFlight.delete(key);
  });
  inFlight.set(key, tracked);
  return tracked;
}

function isExpired(err: unknown): boolean {
  if (err instanceof JwtExpiredError) return true;
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "JwtExpiredError";
}

function authed(claims: IdTokenClaims, setCookies: string[]): SessionResult {
  const out: SessionResult = { authenticated: true, sub: claims.sub, setCookies };
  if (claims.email !== undefined) out.email = claims.email;
  if (claims.name !== undefined) out.name = claims.name;
  return out;
}

function defaultDeps(request: SessionRequest): SessionDeps {
  return {
    verifyIdToken: (t) => verifyIdToken(t),
    refresh: (rt) => refreshTokens(rt),
    now: () => Date.now(),
    secure: isSecureOrigin(request.url),
  };
}

export async function resolveSession(
  request: SessionRequest,
  deps?: Partial<SessionDeps>,
): Promise<SessionResult> {
  const d: SessionDeps = { ...defaultDeps(request), ...(deps ?? {}) };
  const clear = (): SessionResult => {
    let clearCookies: string[] = [];
    try {
      clearCookies = buildClearCookies(d.secure);
    } catch {
      clearCookies = [];
    }
    return { authenticated: false, clearCookies };
  };

  try {
    const { idToken, refreshToken } = parseSessionCookies(request.headers.get("cookie"), d.secure);
    if (!idToken && !refreshToken) return { authenticated: false, clearCookies: [] };

    let needRefresh = false;
    if (idToken) {
      try {
        return authed(await d.verifyIdToken(idToken), []);
      } catch (err) {
        // Only expiry may trigger a Cognito call; forged tokens never do.
        if (!isExpired(err)) return clear();
        needRefresh = true;
      }
    } else {
      needRefresh = true;
    }

    if (!needRefresh || !refreshToken) return clear();

    try {
      const refreshed = await singleFlightRefresh(refreshToken, d.refresh);
      const claims = await d.verifyIdToken(refreshed.idToken);
      const setCookies = buildSetCookies(
        { idToken: refreshed.idToken, refreshToken: refreshed.refreshToken ?? refreshToken },
        { secure: d.secure, maxAgeSeconds: sessionMaxSeconds(claims.authTime, d.now()) },
      );
      return authed(claims, setCookies);
    } catch {
      logSafe("auth_session_refresh_failed");
      return clear();
    }
  } catch {
    return clear();
  }
}
