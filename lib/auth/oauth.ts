import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * OAuth (Cognito hosted UI, authorization code + PKCE) helpers.
 * Server-side only. No I/O; pure apart from random generation and the clock.
 */

export const OAUTH_SCOPE = "openid email profile";
export const OAUTH_COOKIE_MAX_AGE_SECONDS = 600;
export const DEFAULT_RETURN_TO = "/plan";
export const RETURN_TO_MAX_LENGTH = 200;

/** Allowed future clock skew when decoding the state cookie. */
const FUTURE_SKEW_MS = 5_000;
const B64URL = /^[A-Za-z0-9_-]+$/;
const MAX_COOKIE_VALUE_LENGTH = 2048;

export interface OAuthStatePayload {
  /** state */
  state: string;
  /** PKCE code verifier */
  verifier: string;
  /** nonce */
  nonce: string;
  /** safe return path */
  returnTo: string;
  /** issuedAt, epoch milliseconds */
  issuedAt: number;
}

export interface AuthorizeUrlInput {
  /** Hosted UI host without scheme, e.g. `x.auth.us-east-1.amazoncognito.com`. */
  domain: string;
  clientId: string;
  redirectUri: string;
  identityProvider: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** 32 random bytes, base64url (43 characters). */
export function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

/** base64url(SHA-256(verifier)), the S256 code challenge. */
export function codeChallengeS256(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}

/** 16 random bytes, base64url. */
export function generateState(): string {
  return base64url(randomBytes(16));
}

/** 16 random bytes, base64url. */
export function generateNonce(): string {
  return base64url(randomBytes(16));
}

export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const url = new URL(`https://${input.domain}/oauth2/authorize`);
  const p = url.searchParams;
  p.set("response_type", "code");
  p.set("client_id", input.clientId);
  p.set("redirect_uri", input.redirectUri);
  p.set("scope", OAUTH_SCOPE);
  p.set("identity_provider", input.identityProvider);
  p.set("state", input.state);
  p.set("nonce", input.nonce);
  p.set("code_challenge", input.codeChallenge);
  p.set("code_challenge_method", "S256");
  return url.toString();
}

/** Encodes the state cookie value: base64url(JSON `{ s, v, n, r, t }`). */
export function encodeStateCookie(payload: OAuthStatePayload): string {
  const json = JSON.stringify({
    s: payload.state,
    v: payload.verifier,
    n: payload.nonce,
    r: payload.returnTo,
    t: payload.issuedAt,
  });
  return Buffer.from(json, "utf8").toString("base64url");
}

/**
 * Decodes and validates the state cookie value. Returns null on any failure:
 * bad shape or charset, wrong field types or lengths, unsafe returnTo,
 * expired (older than 600 s) or issued in the future.
 * Single use is the caller's job: expire the cookie on every callback outcome.
 */
export function decodeStateCookie(
  value: string | undefined | null,
  now: number = Date.now(),
): OAuthStatePayload | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_COOKIE_VALUE_LENGTH) return null;
  if (!B64URL.test(value)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const { s, v, n, r, t } = o;
  if (typeof s !== "string" || typeof v !== "string" || typeof n !== "string" || typeof r !== "string") return null;
  if (typeof t !== "number" || !Number.isFinite(t)) return null;
  if (!B64URL.test(s) || s.length < 16 || s.length > 128) return null;
  if (!B64URL.test(v) || v.length < 43 || v.length > 128) return null;
  if (!B64URL.test(n) || n.length < 16 || n.length > 128) return null;
  if (safeReturnTo(r) !== r) return null;
  const ageMs = now - t;
  if (ageMs < -FUTURE_SKEW_MS || ageMs > OAUTH_COOKIE_MAX_AGE_SECONDS * 1000) return null;
  return { state: s, verifier: v, nonce: n, returnTo: r, issuedAt: t };
}

/** Constant-time string comparison with a length guard. */
export function statesMatch(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Returns `input` only when it is a single-slash relative path of at most
 * 200 characters, with no `//` or `/\` prefix, no backslash, no control
 * characters and no `:` before the first `?` or `#`. Otherwise `/plan`.
 */
export function safeReturnTo(input: unknown): string {
  if (typeof input !== "string") return DEFAULT_RETURN_TO;
  if (input.length === 0 || input.length > RETURN_TO_MAX_LENGTH) return DEFAULT_RETURN_TO;
  if (input[0] !== "/") return DEFAULT_RETURN_TO;
  if (input[1] === "/" || input[1] === "\\") return DEFAULT_RETURN_TO;
  if (input.includes("\\")) return DEFAULT_RETURN_TO;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(input)) return DEFAULT_RETURN_TO;
  const cut = input.search(/[?#]/);
  const beforeQuery = cut === -1 ? input : input.slice(0, cut);
  if (beforeQuery.includes(":")) return DEFAULT_RETURN_TO;
  return input;
}
