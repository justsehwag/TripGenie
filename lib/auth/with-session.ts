// SERVER-ONLY. Do not import from a "use client" module: this file pulls in the
// session resolver (Cognito verifier, token refresh, node:crypto).
//
// Route wrapper for account routes. Guards run in this order:
//   1. origin check (403)           2. content type (415) and body size (413)
//   3. resolveSession               4. 401 when not signed in
//   5. the handler (errors -> generic 500)
// Session cookies (set or clear) are appended to every response after the
// session is resolved, errors included. The verified `sub` is the only owner.

import { allowedOrigins as envAllowedOrigins } from "../account/env";
import { logSafe } from "../log";
import { isAllowedOrigin } from "./origin";
import { resolveSession, type SessionResult } from "./session";

export const DEFAULT_MAX_BODY_BYTES = 16 * 1024;

export interface SessionContext {
  sub: string;
  email?: string;
  name?: string;
  /** Parsed JSON for `application/json` bodies, raw text for `parseBody: "text"`. Undefined when no body. */
  body?: unknown;
  request: Request;
}

export type SessionHandler = (ctx: SessionContext) => Promise<Response> | Response;

export interface WithSessionOptions {
  /** Maximum request body size in bytes. Default 16 KB. */
  maxBodyBytes?: number;
  /** "json" (default) parses the body; "text" passes the raw string. */
  parseBody?: "json" | "text";
  /** Test seam. Defaults to the real `resolveSession`. */
  resolveSession?: (request: Request) => Promise<SessionResult>;
  /** Test seam. Defaults to `allowedOrigins()` from `lib/account/env`. */
  allowedOrigins?: () => readonly string[];
}

const BODY_METHODS_EXCLUDED = new Set(["GET", "HEAD"]);

function finish(res: Response, cookies: readonly string[]): Response {
  // Rebuild so headers are always mutable (e.g. Response.redirect is immutable).
  const headers = new Headers(res.headers);
  for (const c of cookies) headers.append("Set-Cookie", c);
  headers.set("Cache-Control", "private, no-store");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function errorResponse(status: number, error: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  return finish(new Response(JSON.stringify({ error }), { status, headers }), cookies);
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function withSession(
  handler: SessionHandler,
  options: WithSessionOptions = {},
): (req: Request) => Promise<Response> {
  const maxBytes =
    typeof options.maxBodyBytes === "number" && options.maxBodyBytes > 0
      ? options.maxBodyBytes
      : DEFAULT_MAX_BODY_BYTES;
  const resolve = options.resolveSession ?? ((r: Request) => resolveSession(r));
  const origins = options.allowedOrigins ?? envAllowedOrigins;

  return async function wrapped(req: Request): Promise<Response> {
    let cookies: readonly string[] = [];
    try {
      const method = String(req.method ?? "").toUpperCase();

      // 1. Origin check. Development with no configured origin allows the request URL origin.
      let allowed: readonly string[] = [];
      try {
        allowed = origins();
      } catch {
        allowed = [];
      }
      if (allowed.length === 0 && process.env.NODE_ENV !== "production") {
        try {
          allowed = [new URL(req.url).origin];
        } catch {
          allowed = [];
        }
      }
      if (!isAllowedOrigin(method, req.headers, allowed)) {
        return errorResponse(403, "Forbidden.");
      }

      // 2. Content type and body size, read the body text once.
      let body: unknown;
      if (!BODY_METHODS_EXCLUDED.has(method) && req.body !== null) {
        const contentType = (req.headers.get("content-type") ?? "").trim().toLowerCase();
        const wantsText = options.parseBody === "text";
        if (!wantsText && !contentType.startsWith("application/json")) {
          return errorResponse(415, "Unsupported content type.");
        }
        const declared = Number(req.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > maxBytes) {
          return errorResponse(413, "Request body too large.");
        }
        const text = await req.text();
        if (byteLength(text) > maxBytes) {
          return errorResponse(413, "Request body too large.");
        }
        if (text.length > 0) {
          if (wantsText) {
            body = text;
          } else {
            try {
              body = JSON.parse(text);
            } catch {
              return errorResponse(400, "Invalid request.");
            }
          }
        }
      }

      // 3. Session.
      const session = await resolve(req);
      cookies = session.authenticated ? session.setCookies : session.clearCookies;

      // 4. Sign-in required.
      if (!session.authenticated) {
        return errorResponse(401, "Sign in required.", cookies);
      }

      // 5. Handler. The verified sub is the only owner.
      try {
        const res = await handler({
          sub: session.sub,
          email: session.email,
          name: session.name,
          body,
          request: req,
        });
        return finish(res, cookies);
      } catch (err) {
        logSafe("with_session_handler_error", {
          name: err instanceof Error ? err.name : "UnknownError",
        });
        return errorResponse(500, "Something went wrong.", cookies);
      }
    } catch (err) {
      logSafe("with_session_error", { name: err instanceof Error ? err.name : "UnknownError" });
      return errorResponse(500, "Something went wrong.", cookies);
    }
  };
}
