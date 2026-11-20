import { describe, expect, it, vi } from "vitest";
import { JwtExpiredError, JwtInvalidSignatureError, JwtInvalidAudienceError } from "aws-jwt-verify/error";
import { inFlightRefreshCount, resolveSession } from "../lib/auth/session";
import { cookieNames, parseSessionCookies } from "../lib/auth/session-cookie";

const SUB = "11111111-2222-3333-4444-555555555555";
const OLD_ID = "old.id.token";
const OLD_RT = "old-refresh_token";
const NEW_ID = "new.id.token";
const NEW_RT = "rotated-refresh_token";
const NOW = 1_700_000_000_000;

function req(cookie?: string) {
  return {
    url: "http://localhost:3000/api/profile",
    headers: { get: (n: string) => (n.toLowerCase() === "cookie" ? (cookie ?? null) : null) },
  };
}

function cookieHeader(id?: string, rt?: string): string {
  const n = cookieNames(false);
  const parts: string[] = [];
  if (id) parts.push(`${n.id}=${id}`);
  if (rt) parts.push(`${n.rt}=${rt}`);
  return parts.join("; ");
}

function expiredError(): Error {
  return new JwtExpiredError("expired", 0 as never);
}

describe("resolveSession", () => {
  it("returns unauthenticated with no clear cookies when there are no cookies", async () => {
    const verifyIdToken = vi.fn();
    const refresh = vi.fn();
    const r = await resolveSession(req(), { verifyIdToken, refresh, now: () => NOW, secure: false });
    expect(r).toEqual({ authenticated: false, clearCookies: [] });
    expect(verifyIdToken).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("accepts a valid ID token without setting cookies", async () => {
    const verifyIdToken = vi.fn().mockResolvedValue({ sub: SUB });
    const refresh = vi.fn();
    const r = await resolveSession(req(cookieHeader(OLD_ID, OLD_RT)), {
      verifyIdToken,
      refresh,
      now: () => NOW,
      secure: false,
    });
    expect(r.authenticated).toBe(true);
    if (r.authenticated) {
      expect(r.sub).toBe(SUB);
      expect(r.setCookies).toEqual([]);
    }
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes an expired ID token and sets cookies that parse back to the new tokens", async () => {
    const verifyIdToken = vi.fn(async (t: string) => {
      if (t === OLD_ID) throw expiredError();
      return { sub: SUB };
    });
    const refresh = vi.fn().mockResolvedValue({ idToken: NEW_ID, refreshToken: NEW_RT });
    const r = await resolveSession(req(cookieHeader(OLD_ID, OLD_RT)), {
      verifyIdToken,
      refresh,
      now: () => NOW,
      secure: false,
    });
    expect(refresh).toHaveBeenCalledWith(OLD_RT);
    expect(r.authenticated).toBe(true);
    if (r.authenticated) {
      expect(r.sub).toBe(SUB);
      const header = r.setCookies.map((c) => c.split(";")[0]).join("; ");
      expect(parseSessionCookies(header, false)).toEqual({ idToken: NEW_ID, refreshToken: NEW_RT });
    }
  });

  it("keeps the existing refresh token when the refresh does not rotate it", async () => {
    const verifyIdToken = vi.fn(async (t: string) => {
      if (t === OLD_ID) throw expiredError();
      return { sub: SUB };
    });
    const refresh = vi.fn().mockResolvedValue({ idToken: NEW_ID });
    const r = await resolveSession(req(cookieHeader(OLD_ID, OLD_RT)), {
      verifyIdToken,
      refresh,
      now: () => NOW,
      secure: false,
    });
    expect(r.authenticated).toBe(true);
    if (r.authenticated) {
      const header = r.setCookies.map((c) => c.split(";")[0]).join("; ");
      expect(parseSessionCookies(header, false)).toEqual({ idToken: NEW_ID, refreshToken: OLD_RT });
    }
  });

  it("returns unauthenticated with clear cookies when the refresh is rejected", async () => {
    const verifyIdToken = vi.fn().mockRejectedValue(expiredError());
    const refresh = vi.fn().mockRejectedValue(new Error("NotAuthorizedException"));
    const r = await resolveSession(req(cookieHeader(OLD_ID, OLD_RT)), {
      verifyIdToken,
      refresh,
      now: () => NOW,
      secure: false,
    });
    expect(r.authenticated).toBe(false);
    if (!r.authenticated) {
      expect(r.clearCookies).toHaveLength(2);
      for (const c of r.clearCookies) expect(c).toContain("Max-Age=0");
    }
  });

  it.each([
    ["bad signature", () => new JwtInvalidSignatureError("bad signature")],
    ["wrong audience", () => new JwtInvalidAudienceError("bad aud", "x" as never, "y" as never)],
  ])("never calls refresh on %s", async (_label, mk) => {
    const verifyIdToken = vi.fn().mockRejectedValue(mk());
    const refresh = vi.fn();
    const r = await resolveSession(req(cookieHeader(OLD_ID, OLD_RT)), {
      verifyIdToken,
      refresh,
      now: () => NOW,
      secure: false,
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(r.authenticated).toBe(false);
  });

  it("shares one refresh call between parallel requests and clears the in-flight map", async () => {
    const verifyIdToken = vi.fn(async (t: string) => {
      if (t === OLD_ID) throw expiredError();
      return { sub: SUB };
    });
    let release!: (v: { idToken: string; refreshToken: string }) => void;
    const refresh = vi.fn(
      () => new Promise<{ idToken: string; refreshToken: string }>((res) => (release = res)),
    );
    const deps = { verifyIdToken, refresh, now: () => NOW, secure: false };
    const p1 = resolveSession(req(cookieHeader(OLD_ID, OLD_RT)), deps);
    const p2 = resolveSession(req(cookieHeader(OLD_ID, OLD_RT)), deps);
    await vi.waitFor(() => expect(inFlightRefreshCount()).toBe(1));
    release({ idToken: NEW_ID, refreshToken: NEW_RT });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(r1.authenticated).toBe(true);
    expect(r2.authenticated).toBe(true);
    expect(inFlightRefreshCount()).toBe(0);
  });
});
