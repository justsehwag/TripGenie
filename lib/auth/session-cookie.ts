/**
 * Session cookie helpers (pure, no I/O). Two HttpOnly cookies carry the ID token
 * and the refresh token. In secure mode the names use the `__Host-` prefix, which
 * requires Secure, Path=/ and no Domain attribute.
 */

export interface SessionTokens {
  idToken: string;
  refreshToken: string;
}

export interface CookieOptions {
  secure: boolean;
  /** Cookie lifetime in seconds. Callers pass the configured session maximum. */
  maxAgeSeconds: number;
}

/** Largest allowed single Set-Cookie header value, in bytes. */
export const MAX_SET_COOKIE_BYTES = 3800;
/** Largest accepted cookie value length when parsing, in characters. */
export const MAX_COOKIE_VALUE_CHARS = 4096;

const JWT_CHARS = /^[A-Za-z0-9._-]+$/;

export class SessionCookieTooLargeError extends Error {
  readonly bytes: number;
  constructor(bytes: number) {
    super("Session cookie is too large.");
    this.name = "SessionCookieTooLargeError";
    this.bytes = bytes;
  }
}

export function cookieNames(secure: boolean): { id: string; rt: string; oauth: string } {
  const p = secure ? "__Host-" : "";
  return { id: `${p}tg_id`, rt: `${p}tg_rt`, oauth: `${p}tg_oauth` };
}

function safeMaxAge(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.max(0, Math.floor(seconds));
}

function serialize(name: string, value: string, secure: boolean, maxAge: number): string {
  const parts = [`${name}=${value}`, "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${maxAge}`];
  if (secure) parts.push("Secure");
  const out = parts.join("; ");
  const bytes = Buffer.byteLength(out, "utf8");
  if (bytes > MAX_SET_COOKIE_BYTES) throw new SessionCookieTooLargeError(bytes);
  return out;
}

/** Returns two Set-Cookie header values (ID token, refresh token). Throws SessionCookieTooLargeError. */
export function buildSetCookies(t: SessionTokens, o: CookieOptions): string[] {
  const names = cookieNames(o.secure);
  const maxAge = safeMaxAge(o.maxAgeSeconds);
  if (!JWT_CHARS.test(t.idToken) || !JWT_CHARS.test(t.refreshToken)) {
    throw new Error("Token contains characters that cannot be stored in a cookie.");
  }
  return [
    serialize(names.id, t.idToken, o.secure, maxAge),
    serialize(names.rt, t.refreshToken, o.secure, maxAge),
  ];
}

/** Set-Cookie values that expire both session cookies. */
export function buildClearCookies(secure: boolean): string[] {
  const names = cookieNames(secure);
  return [serialize(names.id, "", secure, 0), serialize(names.rt, "", secure, 0)];
}

/** Never throws. Ignores values outside JWT characters or longer than 4096 characters. */
export function parseSessionCookies(
  header: string | null | undefined,
  secure: boolean,
): { idToken?: string; refreshToken?: string } {
  const result: { idToken?: string; refreshToken?: string } = {};
  try {
    if (typeof header !== "string" || header.length === 0) return result;
    const names = cookieNames(secure);
    for (const piece of header.split(";")) {
      const eq = piece.indexOf("=");
      if (eq < 0) continue;
      const name = piece.slice(0, eq).trim();
      if (name !== names.id && name !== names.rt) continue;
      const value = piece.slice(eq + 1).trim();
      if (value.length === 0 || value.length > MAX_COOKIE_VALUE_CHARS || !JWT_CHARS.test(value)) continue;
      if (name === names.id) {
        if (result.idToken === undefined) result.idToken = value;
      } else if (result.refreshToken === undefined) {
        result.refreshToken = value;
      }
    }
  } catch {
    return {};
  }
  return result;
}
