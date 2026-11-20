import { awsConfig } from "../config";
import { allowedOrigins, isSecureOrigin, sessionMaxSeconds, validCognitoDomain } from "../account/env";
import { logSafe } from "../log";
import { exchangeCode, type ExchangedTokens, type ExchangeCodeInput } from "./cognito-tokens";
import {
  OAUTH_COOKIE_MAX_AGE_SECONDS,
  buildAuthorizeUrl,
  codeChallengeS256,
  decodeStateCookie,
  encodeStateCookie,
  generateCodeVerifier,
  generateNonce,
  generateState,
  safeReturnTo,
  statesMatch,
  type OAuthStatePayload,
} from "./oauth";
import { buildSetCookies, cookieNames } from "./session-cookie";
import { verifyIdToken, type IdTokenClaims } from "./verifier";

/**
 * Google sign-in (Cognito hosted UI, authorization code + PKCE) handlers.
 * Factories take injectable dependencies; the route files only wire defaults.
 * Nothing from the code, tokens or verifier is logged or put in a URL.
 */

export const ALLOWED_PROVIDERS = ["Google"] as const;
export const LOGIN_UNAVAILABLE_URL = "/?auth_error=google_unavailable";
export const CALLBACK_FAILED_URL = "/?auth_error=google_failed";
export const MAX_CODE_PARAM_LENGTH = 2048;

export interface LoginDeps {
  cognitoDomain: () => string | undefined;
  clientId: () => string;
  appOrigin: () => string | undefined;
  secure: () => boolean;
  now: () => number;
  generateCodeVerifier: () => string;
  generateState: () => string;
  generateNonce: () => string;
}

export interface CallbackDeps {
  cognitoDomain: () => string | undefined;
  clientId: () => string;
  appOrigin: () => string | undefined;
  secure: () => boolean;
  now: () => number;
  exchangeCode: (input: ExchangeCodeInput) => Promise<ExchangedTokens>;
  verifyIdToken: (token: string) => Promise<IdTokenClaims>;
  sessionMaxSeconds: (authTime?: number) => number;
}

export const defaultLoginDeps: LoginDeps = {
  cognitoDomain: validCognitoDomain,
  clientId: () => awsConfig.cognito.clientId,
  appOrigin: () => allowedOrigins()[0],
  secure: () => isSecureOrigin(),
  now: () => Date.now(),
  generateCodeVerifier,
  generateState,
  generateNonce,
};

export const defaultCallbackDeps: CallbackDeps = {
  cognitoDomain: validCognitoDomain,
  clientId: () => awsConfig.cognito.clientId,
  appOrigin: () => allowedOrigins()[0],
  secure: () => isSecureOrigin(),
  now: () => Date.now(),
  exchangeCode: (input) => exchangeCode(input),
  verifyIdToken: (token) => verifyIdToken(token),
  sessionMaxSeconds: (authTime) => sessionMaxSeconds(authTime),
};

function redirect(location: string, cookies: string[]): Response {
  const headers = new Headers();
  headers.set("Location", location);
  headers.set("Cache-Control", "no-store");
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

function oauthCookie(secure: boolean, value: string, maxAge: number): string {
  const parts = [
    `${cookieNames(secure).oauth}=${value}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** Set-Cookie value that expires the OAuth state cookie. */
export function expireOAuthCookie(secure: boolean): string {
  return oauthCookie(secure, "", 0);
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const piece of header.split(";")) {
    const eq = piece.indexOf("=");
    if (eq < 0) continue;
    if (piece.slice(0, eq).trim() === name) return piece.slice(eq + 1).trim();
  }
  return undefined;
}

export function createLoginHandler(overrides: Partial<LoginDeps> = {}): (request: Request) => Promise<Response> {
  const deps: LoginDeps = { ...defaultLoginDeps, ...overrides };
  return async (request: Request): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return redirect(LOGIN_UNAVAILABLE_URL, []);
    }
    const provider = url.searchParams.get("provider");
    if (!provider || !(ALLOWED_PROVIDERS as readonly string[]).includes(provider)) {
      logSafe("oauth_login_bad_provider");
      return redirect(LOGIN_UNAVAILABLE_URL, []);
    }
    const domain = deps.cognitoDomain();
    const clientId = deps.clientId();
    const origin = deps.appOrigin();
    if (!domain || !clientId || !origin) {
      logSafe("oauth_login_unavailable");
      return redirect(LOGIN_UNAVAILABLE_URL, []);
    }
    const secure = deps.secure();
    const verifier = deps.generateCodeVerifier();
    const state = deps.generateState();
    const nonce = deps.generateNonce();
    const payload: OAuthStatePayload = {
      state,
      verifier,
      nonce,
      returnTo: safeReturnTo(url.searchParams.get("returnTo")),
      issuedAt: deps.now(),
    };
    const authorize = buildAuthorizeUrl({
      domain,
      clientId,
      redirectUri: `${origin}/api/auth/callback`,
      identityProvider: provider,
      state,
      nonce,
      codeChallenge: codeChallengeS256(verifier),
    });
    return redirect(authorize, [oauthCookie(secure, encodeStateCookie(payload), OAUTH_COOKIE_MAX_AGE_SECONDS)]);
  };
}

export function createCallbackHandler(overrides: Partial<CallbackDeps> = {}): (request: Request) => Promise<Response> {
  const deps: CallbackDeps = { ...defaultCallbackDeps, ...overrides };
  return async (request: Request): Promise<Response> => {
    const secure = deps.secure();
    const expire = expireOAuthCookie(secure);
    const fail = (event: string): Response => {
      logSafe(event);
      return redirect(CALLBACK_FAILED_URL, [expire]);
    };

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return fail("oauth_callback_bad_url");
    }
    const p = url.searchParams;
    if (p.has("error")) return fail("oauth_callback_provider_error");
    const code = p.get("code");
    const state = p.get("state");
    if (!code || !state || code.length > MAX_CODE_PARAM_LENGTH || state.length > MAX_CODE_PARAM_LENGTH) {
      return fail("oauth_callback_bad_params");
    }

    const stored = decodeStateCookie(readCookie(request.headers.get("cookie"), cookieNames(secure).oauth), deps.now());
    if (!stored || !stored.verifier) return fail("oauth_callback_no_state_cookie");
    if (!statesMatch(state, stored.state)) return fail("oauth_callback_state_mismatch");

    const domain = deps.cognitoDomain();
    const clientId = deps.clientId();
    const origin = deps.appOrigin();
    if (!domain || !clientId || !origin) return fail("oauth_callback_unavailable");

    try {
      const tokens = await deps.exchangeCode({
        domain,
        clientId,
        code,
        redirectUri: `${origin}/api/auth/callback`,
        codeVerifier: stored.verifier,
      });
      if (!tokens.refreshToken) return fail("oauth_callback_no_refresh_token");
      const claims = await deps.verifyIdToken(tokens.idToken);
      if (!claims.nonce || !statesMatch(claims.nonce, stored.nonce)) return fail("oauth_callback_nonce_mismatch");
      const sessionCookies = buildSetCookies(
        { idToken: tokens.idToken, refreshToken: tokens.refreshToken },
        { secure, maxAgeSeconds: deps.sessionMaxSeconds(claims.authTime) },
      );
      return redirect(safeReturnTo(stored.returnTo), [expire, ...sessionCookies]);
    } catch {
      return fail("oauth_callback_exchange_failed");
    }
  };
}
