import { describe, expect, it, vi } from "vitest";
import {
  CALLBACK_FAILED_URL,
  LOGIN_UNAVAILABLE_URL,
  createCallbackHandler,
  createLoginHandler,
} from "../lib/auth/oauth-handlers";
import { encodeStateCookie } from "../lib/auth/oauth";

const ORIGIN = "https://app.example.com";
const NOW = 1_700_000_000_000;
const STATE = "state-aaaaaaaaaaaaaaaa";
const NONCE = "nonce-bbbbbbbbbbbbbbbb";
const VERIFIER = "v".repeat(43);
const ID_TOKEN = "idhead.idbody.idsig";
const REFRESH = "refresh-token-secret";

const baseDeps = {
  cognitoDomain: () => "auth.example.com" as string | undefined,
  clientId: () => "client123",
  appOrigin: () => ORIGIN as string | undefined,
  secure: () => true,
  now: () => NOW,
};

function login(url: string, overrides: Parameters<typeof createLoginHandler>[0] = {}) {
  return createLoginHandler({
    ...baseDeps,
    generateCodeVerifier: () => VERIFIER,
    generateState: () => STATE,
    generateNonce: () => NONCE,
    ...overrides,
  })(new Request(url));
}

function stateCookie(over: Record<string, unknown> = {}): string {
  const payload = { state: STATE, verifier: VERIFIER, nonce: NONCE, returnTo: "/trips", issuedAt: NOW, ...over };
  return `__Host-tg_oauth=${encodeStateCookie(payload as never)}`;
}

function callback(
  query: string,
  cookie: string | undefined,
  overrides: Parameters<typeof createCallbackHandler>[0] = {},
) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return createCallbackHandler({
    ...baseDeps,
    exchangeCode: async () => ({ idToken: ID_TOKEN, refreshToken: REFRESH }),
    verifyIdToken: async () => ({ sub: "u1", nonce: NONCE }),
    sessionMaxSeconds: () => 3600,
    ...overrides,
  })(new Request(`${ORIGIN}/api/auth/callback?${query}`, { headers }));
}

function expectRejected(res: Response) {
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(CALLBACK_FAILED_URL);
  const cookies = res.headers.getSetCookie();
  expect(cookies.some((c) => /^__Host-tg_(id|rt)=/.test(c) && !/Max-Age=0/.test(c))).toBe(false);
  const oauth = cookies.filter((c) => c.startsWith("__Host-tg_oauth="));
  expect(oauth).toHaveLength(1);
  expect(oauth[0]).toContain("Max-Age=0");
}

describe("login handler", () => {
  it("sets the state cookie and redirects with PKCE S256, state and nonce", async () => {
    const res = await login(`${ORIGIN}/api/auth/login?provider=Google&returnTo=/trips`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.host).toBe("auth.example.com");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("code_challenge")).toBeTruthy();
    expect(loc.searchParams.get("state")).toBe(STATE);
    expect(loc.searchParams.get("nonce")).toBe(NONCE);
    expect(loc.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback`);
    expect(res.headers.get("location")).not.toContain(VERIFIER);
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^__Host-tg_oauth=/);
    expect(cookies[0]).toContain("HttpOnly");
    expect(cookies[0]).toContain("Secure");
    expect(cookies[0]).toContain("SameSite=Lax");
  });

  it("redirects with a generic error when COGNITO_DOMAIN is unset", async () => {
    const res = await login(`${ORIGIN}/api/auth/login?provider=Google`, { cognitoDomain: () => undefined });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(LOGIN_UNAVAILABLE_URL);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it("redirects with a generic error when the provider is not allowed or missing", async () => {
    for (const q of ["provider=Facebook", "provider=google", "", "provider=Google%0d%0aX:1"]) {
      const res = await login(`${ORIGIN}/api/auth/login?${q}`);
      expect(res.headers.get("location")).toBe(LOGIN_UNAVAILABLE_URL);
      expect(res.headers.getSetCookie()).toHaveLength(0);
    }
  });
});

describe("callback handler", () => {
  it("rejects a mismatched state", async () => {
    const exchange = vi.fn();
    expectRejected(await callback("code=abc&state=wrong-state-aaaaaaaa", stateCookie(), { exchangeCode: exchange }));
    expect(exchange).not.toHaveBeenCalled();
  });

  it("rejects a missing state cookie", async () => {
    expectRejected(await callback(`code=abc&state=${STATE}`, undefined));
  });

  it("rejects a cookie without a verifier", async () => {
    expectRejected(await callback(`code=abc&state=${STATE}`, stateCookie({ verifier: undefined })));
    expectRejected(await callback(`code=abc&state=${STATE}`, "__Host-tg_oauth=not-a-valid-cookie"));
  });

  it("rejects an error query parameter", async () => {
    const exchange = vi.fn();
    expectRejected(
      await callback(`error=access_denied&state=${STATE}`, stateCookie(), { exchangeCode: exchange }),
    );
    expect(exchange).not.toHaveBeenCalled();
  });

  it("rejects a nonce mismatch", async () => {
    expectRejected(
      await callback(`code=abc&state=${STATE}`, stateCookie(), {
        verifyIdToken: async () => ({ sub: "u1", nonce: "other-nonce-cccccccc" }),
      }),
    );
  });

  it("rejects a failed token exchange", async () => {
    expectRejected(
      await callback(`code=abc&state=${STATE}`, stateCookie(), {
        exchangeCode: async () => {
          throw new Error("boom");
        },
      }),
    );
  });

  it("sets session cookies on success and redirects to a safe path with no code or token in the URL", async () => {
    const exchange = vi.fn(async () => ({ idToken: ID_TOKEN, refreshToken: REFRESH }));
    const res = await callback(`code=authcode123&state=${STATE}`, stateCookie({ returnTo: "/trips" }), {
      exchangeCode: exchange,
    });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location")!;
    expect(loc).toBe("/trips");
    for (const secret of ["authcode123", ID_TOKEN, REFRESH, VERIFIER]) expect(loc).not.toContain(secret);
    expect(exchange).toHaveBeenCalledWith(expect.objectContaining({ code: "authcode123", codeVerifier: VERIFIER }));
    const cookies = res.headers.getSetCookie();
    expect(cookies.find((c) => c.startsWith(`__Host-tg_id=${ID_TOKEN}`))).toContain("HttpOnly");
    expect(cookies.find((c) => c.startsWith(`__Host-tg_rt=${REFRESH}`))).toContain("Max-Age=3600");
    expect(cookies.find((c) => c.startsWith("__Host-tg_oauth="))).toContain("Max-Age=0");
  });

  it("falls back to /plan for an absolute URL or //host returnTo", async () => {
    for (const returnTo of ["https://evil.example/x", "//evil.example/x"]) {
      const start = await login(`${ORIGIN}/api/auth/login?provider=Google&returnTo=${encodeURIComponent(returnTo)}`);
      const pair = start.headers.getSetCookie()[0].split(";")[0];
      const res = await callback(`code=abc&state=${STATE}`, pair);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/plan");
      expect(res.headers.getSetCookie().some((c) => c.startsWith(`__Host-tg_id=${ID_TOKEN}`))).toBe(true);
    }
  });

  it("never follows an unsafe returnTo planted in the state cookie", async () => {
    const res = await callback(`code=abc&state=${STATE}`, stateCookie({ returnTo: "//evil.example/x" }));
    expect(res.headers.get("location")).not.toContain("evil");
  });
});
