import { describe, it, expect, vi } from "vitest";
import { createAuthHandlers, type AuthHandlerDeps } from "@/lib/auth/auth-handler";

const APP = "https://app.example.com";
const ID_TOKEN = "fakeIdHeader.fakeIdPayloadSECRET1.fakeIdSig";
const ACCESS_TOKEN = "fakeAccessHeader.fakeAccessPayloadSECRET2.fakeAccessSig";
const REFRESH_TOKEN = "fakeRefreshTokenSECRET3";
const SUB = "sub-123-abc";

const ok = {
  ok: true,
  code: "SUCCESS" as const,
  message: "Signed in.",
  tokens: { idToken: ID_TOKEN, accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN, expiresIn: 3600 },
};

function deps(over: Partial<AuthHandlerDeps> = {}): Partial<AuthHandlerDeps> {
  return {
    signIn: vi.fn(async () => ok),
    verifyIdToken: vi.fn(async () => ({ sub: SUB, email: "a@b.com", name: "Ann", authTime: 1 })),
    revokeRefreshToken: vi.fn(async () => undefined),
    cognitoStatus: () => ({ configured: true }),
    allowedOrigins: () => [APP],
    isSecureOrigin: () => true,
    sessionMaxSeconds: () => 3600,
    googleSignIn: () => false,
    ...over,
  };
}

function post(body: unknown, headers: Record<string, string> = { origin: APP }): Request {
  return new Request(`${APP}/api/auth`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function setCookies(res: Response): string[] {
  return res.headers.getSetCookie();
}

describe("POST /api/auth signin", () => {
  it("sets both hardened __Host- cookies in secure mode", async () => {
    const { POST } = createAuthHandlers(deps());
    const res = await POST(post({ action: "signin", email: "A@b.com", password: "pw" }));
    expect(res.status).toBe(200);
    const cookies = setCookies(res);
    expect(cookies).toHaveLength(2);
    const id = cookies.find((c) => c.startsWith("__Host-tg_id="))!;
    const rt = cookies.find((c) => c.startsWith("__Host-tg_rt="))!;
    expect(id).toBeTruthy();
    expect(rt).toBeTruthy();
    for (const c of [id, rt]) {
      expect(c).toContain("HttpOnly");
      expect(c).toContain("Secure");
      expect(c).toContain("SameSite=Lax");
      expect(c).toContain("Path=/");
      expect(c).not.toMatch(/Domain=/i);
    }
    expect(id).toContain(ID_TOKEN);
    expect(rt).toContain(REFRESH_TOKEN);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("never puts any token in the body or a tokens field", async () => {
    const { POST } = createAuthHandlers(deps());
    const res = await POST(post({ action: "signin", email: "a@b.com", password: "pw" }));
    const raw = await res.text();
    for (const t of [ID_TOKEN, ACCESS_TOKEN, REFRESH_TOKEN, "SECRET1", "SECRET2", "SECRET3"]) {
      expect(raw).not.toContain(t);
    }
    const parsed = JSON.parse(raw);
    expect(parsed).not.toHaveProperty("tokens");
    expect(parsed.ok).toBe(true);
    expect(parsed.user).toEqual({ email: "a@b.com", name: "Ann" });
  });

  it("sets no cookie when Cognito is not configured", async () => {
    const { POST } = createAuthHandlers(
      deps({
        cognitoStatus: () => ({ configured: false, reason: "no" }),
        signIn: vi.fn(async () => ({ ok: false, code: "NOT_CONFIGURED" as const, message: "Cognito is not configured." })),
      }),
    );
    const res = await POST(post({ action: "signin", email: "a@b.com", password: "pw" }));
    expect(setCookies(res)).toHaveLength(0);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("sets no cookie on failed sign-in", async () => {
    const { POST } = createAuthHandlers(
      deps({ signIn: vi.fn(async () => ({ ok: false, code: "ERROR" as const, message: "Incorrect email or password." })) }),
    );
    const res = await POST(post({ action: "signin", email: "a@b.com", password: "bad" }));
    expect(setCookies(res)).toHaveLength(0);
  });
});

describe("POST /api/auth signout", () => {
  const cookieHeader = `__Host-tg_id=${ID_TOKEN}; __Host-tg_rt=${REFRESH_TOKEN}`;

  it("expires both cookies and revokes the refresh token", async () => {
    const revoke = vi.fn(async () => undefined);
    const { POST } = createAuthHandlers(deps({ revokeRefreshToken: revoke }));
    const res = await POST(post({ action: "signout" }, { origin: APP, cookie: cookieHeader }));
    expect(res.status).toBe(200);
    expect(revoke).toHaveBeenCalledWith(REFRESH_TOKEN);
    const cookies = setCookies(res);
    expect(cookies).toHaveLength(2);
    for (const name of ["__Host-tg_id", "__Host-tg_rt"]) {
      const c = cookies.find((x) => x.startsWith(`${name}=`))!;
      expect(c).toBeTruthy();
      expect(c).toContain("Max-Age=0");
      expect(c).toContain("HttpOnly");
      expect(c).toContain("Secure");
      expect(c).toContain("Path=/");
    }
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("still succeeds and clears cookies when revoke fails", async () => {
    const { POST } = createAuthHandlers(
      deps({ revokeRefreshToken: vi.fn(async () => { throw new Error("boom"); }) }),
    );
    const res = await POST(post({ action: "signout" }, { origin: APP, cookie: cookieHeader }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(setCookies(res).every((c) => c.includes("Max-Age=0"))).toBe(true);
    expect(setCookies(res)).toHaveLength(2);
  });

  it("returns 403 for a foreign Origin and does not revoke", async () => {
    const revoke = vi.fn(async () => undefined);
    const { POST } = createAuthHandlers(deps({ revokeRefreshToken: revoke }));
    const res = await POST(post({ action: "signout" }, { origin: "https://evil.example.net", cookie: cookieHeader }));
    expect(res.status).toBe(403);
    expect(revoke).not.toHaveBeenCalled();
    expect(setCookies(res)).toHaveLength(0);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("GET /api/auth/session", () => {
  it("returns no sub and no tokens when signed in", async () => {
    const { sessionGET } = createAuthHandlers(
      deps({
        resolveSession: vi.fn(async () => ({
          authenticated: true as const,
          sub: SUB,
          email: "a@b.com",
          name: "Ann",
          setCookies: [],
        })),
      }),
    );
    const res = await sessionGET(new Request(`${APP}/api/auth/session`));
    const raw = await res.text();
    expect(raw).not.toContain(SUB);
    expect(raw).not.toMatch(/sub|token/i);
    expect(JSON.parse(raw)).toEqual({ signedIn: true, user: { email: "a@b.com", name: "Ann" } });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("returns {signedIn:false} when signed out", async () => {
    const { sessionGET } = createAuthHandlers(
      deps({ resolveSession: vi.fn(async () => ({ authenticated: false as const, clearCookies: [] })) }),
    );
    const res = await sessionGET(new Request(`${APP}/api/auth/session`));
    expect(await res.json()).toEqual({ signedIn: false });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("returns {signedIn:false} when resolveSession throws", async () => {
    const { sessionGET } = createAuthHandlers(
      deps({ resolveSession: vi.fn(async () => { throw new Error("x"); }) }),
    );
    const res = await sessionGET(new Request(`${APP}/api/auth/session`));
    expect(await res.json()).toEqual({ signedIn: false });
  });
});
