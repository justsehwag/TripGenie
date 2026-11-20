// SERVER-ONLY. Factory for the /api/auth and /api/auth/session handlers so tests
// can inject fakes (Next route files cannot export arbitrary names).
import { allowedOrigins, isSecureOrigin, sessionMaxSeconds, validCognitoDomain } from "../account/env";
import { awsConfig } from "../config";
import {
  cognitoStatus,
  confirmSignUp,
  resendCode,
  signIn,
  signUp,
  type AuthResult,
} from "../cognito-auth";
import { logSafe } from "../log";
import { revokeRefreshToken } from "./cognito-tokens";
import { isAllowedOrigin } from "./origin";
import { resolveSession, type SessionRequest, type SessionResult } from "./session";
import {
  buildClearCookies,
  buildSetCookies,
  parseSessionCookies,
  SessionCookieTooLargeError,
} from "./session-cookie";
import { verifyIdToken, type IdTokenClaims } from "./verifier";

export interface AuthHandlerDeps {
  signUp(email: string, password: string, name?: string): Promise<AuthResult>;
  confirmSignUp(email: string, code: string): Promise<AuthResult>;
  resendCode(email: string): Promise<AuthResult>;
  signIn(email: string, password: string): Promise<AuthResult>;
  verifyIdToken(token: string): Promise<IdTokenClaims>;
  revokeRefreshToken(refreshToken: string): Promise<void>;
  resolveSession(request: SessionRequest): Promise<SessionResult>;
  cognitoStatus(): { configured: boolean; reason?: string };
  allowedOrigins(): string[];
  isSecureOrigin(requestUrl?: string): boolean;
  sessionMaxSeconds(authTime?: number): number;
  googleSignIn(): boolean;
}

const defaultDeps: AuthHandlerDeps = {
  signUp,
  confirmSignUp,
  resendCode,
  signIn,
  verifyIdToken: (t) => verifyIdToken(t),
  revokeRefreshToken: (t) => revokeRefreshToken(t),
  resolveSession: (r) => resolveSession(r),
  cognitoStatus,
  allowedOrigins,
  isSecureOrigin,
  sessionMaxSeconds: (a) => sessionMaxSeconds(a),
  googleSignIn: () => Boolean(validCognitoDomain() && awsConfig.cognito.clientId),
};

type Body = { action?: string; email?: string; password?: string; name?: string; code?: string };

const CACHE = "private, no-store";

function json(body: unknown, status: number, cookies: string[] = []): Response {
  const headers = new Headers({ "Cache-Control": CACHE });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return Response.json(body, { status, headers });
}

function err(message: string, status = 400): Response {
  return json({ ok: false, code: "ERROR", message }, status);
}

function originOk(request: Request, deps: AuthHandlerDeps): boolean {
  let allowed = deps.allowedOrigins();
  if (allowed.length === 0) {
    // Development without TRIPGENIE_APP_ORIGIN: the request URL origin is allowed.
    try {
      allowed = [new URL(request.url).origin];
    } catch {
      allowed = [];
    }
  }
  return isAllowedOrigin(request.method, request.headers, allowed);
}

export function createAuthHandlers(overrides: Partial<AuthHandlerDeps> = {}) {
  const deps: AuthHandlerDeps = { ...defaultDeps, ...overrides };

  async function GET(): Promise<Response> {
    return json({ ...deps.cognitoStatus(), googleSignIn: deps.googleSignIn() }, 200);
  }

  async function POST(request: Request): Promise<Response> {
    let body: Body;
    try {
      body = (await request.json()) as Body;
    } catch {
      return err("Invalid request body.");
    }
    if (!body || typeof body !== "object") return err("Invalid request body.");
    const action = body.action;
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const code = String(body.code ?? "").trim();

    try {
      switch (action) {
        case "signup": {
          if (!email || !password) return err("Email and password are required.");
          return json(await deps.signUp(email, password, body.name), 200);
        }
        case "confirm": {
          if (!email || !code) return err("Email and code are required.");
          return json(await deps.confirmSignUp(email, code), 200);
        }
        case "resend": {
          if (!email) return err("Email is required.");
          return json(await deps.resendCode(email), 200);
        }
        case "signin": {
          if (!originOk(request, deps)) return json({ ok: false, code: "ERROR", message: "Request not allowed.", error: "Request not allowed." }, 403);
          if (!email || !password) return err("Email and password are required.");
          const result = await deps.signIn(email, password);
          const { tokens, ...rest } = result;
          if (!result.ok || result.code !== "SUCCESS") return json(rest, 200);
          if (!tokens?.idToken || !tokens.refreshToken) {
            return json({ ok: false, code: "ERROR", message: "Could not sign in. Please try again." }, 200);
          }
          try {
            const claims = await deps.verifyIdToken(tokens.idToken);
            const cookies = buildSetCookies(
              { idToken: tokens.idToken, refreshToken: tokens.refreshToken },
              { secure: deps.isSecureOrigin(request.url), maxAgeSeconds: deps.sessionMaxSeconds(claims.authTime) },
            );
            return json({ ...rest, user: { email: claims.email ?? email, name: claims.name ?? "" } }, 200, cookies);
          } catch (e) {
            if (e instanceof SessionCookieTooLargeError) logSafe("auth_cookie_too_large", { bytes: e.bytes });
            else logSafe("auth_signin_session_failed");
            return json({ ok: false, code: "ERROR", message: "Could not sign in. Please try again." }, 200);
          }
        }
        case "signout": {
          if (!originOk(request, deps)) return json({ ok: false, error: "Request not allowed." }, 403);
          const secure = deps.isSecureOrigin(request.url);
          const { refreshToken } = parseSessionCookies(request.headers.get("cookie"), secure);
          if (refreshToken) {
            try {
              await deps.revokeRefreshToken(refreshToken);
            } catch {
              logSafe("auth_revoke_failed");
            }
          }
          return json({ ok: true }, 200, buildClearCookies(secure));
        }
        default:
          return err("Unknown action. Expected signup|confirm|resend|signin|signout.");
      }
    } catch {
      return json({ ok: false, code: "ERROR", message: "Authentication service error. Please try again." }, 200);
    }
  }

  async function sessionGET(request: Request): Promise<Response> {
    try {
      const s = await deps.resolveSession(request);
      if (s.authenticated) {
        return json({ signedIn: true, user: { email: s.email ?? "", name: s.name ?? "" } }, 200, s.setCookies);
      }
      return json({ signedIn: false }, 200, s.clearCookies);
    } catch {
      return json({ signedIn: false }, 200);
    }
  }

  return { GET, POST, sessionGET };
}
