import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { withSession } from "../lib/auth/with-session";
import type { SessionResult } from "../lib/auth/session";

const ORIGIN = "https://app.example.com";
const SET = ["__Host-tg_id=a.b.c; Path=/; HttpOnly", "__Host-tg_rt=r; Path=/; HttpOnly"];
const CLEAR = ["__Host-tg_id=; Max-Age=0; Path=/", "__Host-tg_rt=; Max-Age=0; Path=/"];

const authed = async (): Promise<SessionResult> => ({
  authenticated: true,
  sub: "sub-verified",
  email: "a@b.c",
  setCookies: SET,
});
const anon = async (): Promise<SessionResult> => ({ authenticated: false, clearCookies: CLEAR });

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

function make(
  handler: Parameters<typeof withSession>[0] = ok,
  resolve: () => Promise<SessionResult> = authed,
  extra: Parameters<typeof withSession>[1] = {},
) {
  return withSession(handler, {
    resolveSession: resolve,
    allowedOrigins: () => [ORIGIN],
    ...extra,
  });
}

function req(method: string, init: { origin?: string | null; body?: string; type?: string | null; url?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  const type = init.type === undefined ? "application/json" : init.type;
  if (type && init.body !== undefined) headers["content-type"] = type;
  return new Request(init.url ?? `${ORIGIN}/api/x`, { method, headers, body: init.body });
}

function cookiesOf(res: Response): string[] {
  return res.headers.getSetCookie();
}

describe("withSession", () => {
  it("returns 401 with generic text and clear cookies when unauthenticated", async () => {
    let called = false;
    const res = await make(() => ((called = true), ok()), anon)(req("GET"));
    expect(res.status).toBe(401);
    expect(called).toBe(false);
    const json = await res.json();
    expect(json).toEqual({ error: "Sign in required." });
    expect(cookiesOf(res)).toEqual(CLEAR);
  });

  it.each(["POST", "PUT", "DELETE"])("%s: 403 for foreign or missing Origin", async (method) => {
    const w = make();
    const body = "{}";
    for (const origin of ["https://evil.example.com", "null", null] as const) {
      const res = await w(req(method, { origin, body }));
      expect(res.status).toBe(403);
    }
    const good = await w(req(method, { body }));
    expect(good.status).toBe(200);
  });

  it("does not 403 on GET with a foreign Origin", async () => {
    const res = await make()(req("GET", { origin: "https://evil.example.com" }));
    expect(res.status).toBe(200);
  });

  it("passes the verified sub regardless of owner/userId in body and query", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), fc.string(), async (owner, userId) => {
        let seen: string | undefined;
        const w = make((ctx) => {
          seen = ctx.sub;
          return ok();
        });
        const url = `${ORIGIN}/api/x?owner=${encodeURIComponent(owner)}&userId=${encodeURIComponent(userId)}`;
        const res = await w(req("POST", { url, body: JSON.stringify({ owner, userId }) }));
        expect(res.status).toBe(200);
        expect(seen).toBe("sub-verified");
      }),
      { numRuns: 100 },
    );
  });

  it("appends refreshed cookies on success and handler error, and always sets Cache-Control", async () => {
    const okRes = await make()(req("GET"));
    expect(cookiesOf(okRes)).toEqual(SET);
    expect(okRes.headers.get("cache-control")).toBe("private, no-store");

    const errRes = await make(() => {
      throw new Error("secret-detail");
    })(req("GET"));
    expect(errRes.status).toBe(500);
    expect(cookiesOf(errRes)).toEqual(SET);
    expect(await errRes.text()).not.toContain("secret-detail");
    expect(errRes.headers.get("cache-control")).toBe("private, no-store");

    const responses = [
      await make(ok, anon)(req("GET")),
      await make()(req("POST", { origin: "https://evil.example.com", body: "{}" })),
      await make()(req("POST", { body: "{}", type: "text/plain" })),
      await make()(req("POST", { body: "{nope" })),
      await make(ok, authed, { maxBodyBytes: 4 })(req("POST", { body: '{"a":1}' })),
      await make(() => new Response("x", { status: 404 }))(req("GET")),
    ];
    expect(responses.map((r) => r.status)).toEqual([401, 403, 415, 400, 413, 404]);
    for (const r of responses) expect(r.headers.get("cache-control")).toBe("private, no-store");
  });

  it("returns 413 for oversized body (Content-Length and actual)", async () => {
    const w = make(ok, authed, { maxBodyBytes: 10 });
    const byHeader = await w(
      req("POST", { body: "{}", headers: { "content-length": "100000" } }),
    );
    expect(byHeader.status).toBe(413);
    const actual = await w(req("POST", { body: JSON.stringify({ a: "x".repeat(50) }) }));
    expect(actual.status).toBe(413);
  });

  it("returns 415 for the wrong content type and 400 for invalid JSON", async () => {
    const w = make();
    expect((await w(req("POST", { body: "{}", type: "text/plain" }))).status).toBe(415);
    expect((await w(req("POST", { body: "{not json" }))).status).toBe(400);
  });
});
