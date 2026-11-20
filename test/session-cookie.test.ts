import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_COOKIE_VALUE_CHARS,
  SessionCookieTooLargeError,
  buildClearCookies,
  buildSetCookies,
  cookieNames,
  parseSessionCookies,
} from "../lib/auth/session-cookie";
import { sessionMaxSeconds } from "../lib/account/env";

const tokens = { idToken: "aaa.bbb.ccc", refreshToken: "rrr-sss_ttt" };

function attrs(setCookie: string): string[] {
  return setCookie.split(";").map((s) => s.trim());
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("session cookie flags", () => {
  it("sets HttpOnly, Secure, SameSite=Lax, Path=/ and __Host- names in secure mode, with no Domain", () => {
    const cookies = buildSetCookies(tokens, { secure: true, maxAgeSeconds: 1000 });
    expect(cookies).toHaveLength(2);
    const names = cookieNames(true);
    expect(names.id.startsWith("__Host-")).toBe(true);
    expect(names.rt.startsWith("__Host-")).toBe(true);
    expect(cookies[0].startsWith(`${names.id}=aaa.bbb.ccc;`)).toBe(true);
    expect(cookies[1].startsWith(`${names.rt}=rrr-sss_ttt;`)).toBe(true);
    for (const c of cookies) {
      const a = attrs(c);
      expect(a).toContain("HttpOnly");
      expect(a).toContain("Secure");
      expect(a).toContain("SameSite=Lax");
      expect(a).toContain("Path=/");
      expect(a.some((x) => /^domain=/i.test(x))).toBe(false);
    }
  });

  it("uses plain names and omits Secure in development mode", () => {
    const names = cookieNames(false);
    expect(names.id).not.toMatch(/^__Host-/);
    expect(names.rt).not.toMatch(/^__Host-/);
    const cookies = buildSetCookies(tokens, { secure: false, maxAgeSeconds: 1000 });
    for (const c of cookies) {
      const a = attrs(c);
      expect(a).not.toContain("Secure");
      expect(a).toContain("HttpOnly");
      expect(a).toContain("SameSite=Lax");
      expect(a).toContain("Path=/");
      expect(a.some((x) => /^domain=/i.test(x))).toBe(false);
    }
  });

  it("clear cookies have Max-Age=0 and keep the flags", () => {
    for (const secure of [true, false]) {
      const cleared = buildClearCookies(secure);
      expect(cleared).toHaveLength(2);
      for (const c of cleared) {
        const a = attrs(c);
        expect(a).toContain("Max-Age=0");
        expect(a).toContain("HttpOnly");
        expect(a).toContain("Path=/");
        expect(a.includes("Secure")).toBe(secure);
      }
    }
  });
});

describe("Max-Age", () => {
  const maxAgeOf = (c: string) => Number(/Max-Age=(-?\d+)/.exec(c)![1]);

  it("floors the input and is never negative", () => {
    const opts = (maxAgeSeconds: number) => ({ secure: true, maxAgeSeconds });
    expect(maxAgeOf(buildSetCookies(tokens, opts(123.9))[0])).toBe(123);
    expect(maxAgeOf(buildSetCookies(tokens, opts(0.4))[0])).toBe(0);
    expect(maxAgeOf(buildSetCookies(tokens, opts(-50))[0])).toBe(0);
    expect(maxAgeOf(buildSetCookies(tokens, opts(Number.NaN))[0])).toBe(0);
    expect(maxAgeOf(buildSetCookies(tokens, opts(Number.POSITIVE_INFINITY))[0])).toBe(0);
  });

  it("never exceeds the configured maximum when built with sessionMaxSeconds()", () => {
    vi.stubEnv("TRIPGENIE_SESSION_MAX_DAYS", "7");
    const max = 7 * 86400;
    expect(sessionMaxSeconds()).toBe(max);
    const nowMs = Date.now();
    const authTimes = [undefined, nowMs / 1000, nowMs / 1000 - 3600.5, nowMs / 1000 - 10 * 86400];
    for (const authTime of authTimes) {
      const seconds = sessionMaxSeconds(authTime, nowMs);
      for (const c of buildSetCookies(tokens, { secure: true, maxAgeSeconds: seconds })) {
        const m = maxAgeOf(c);
        expect(m).toBeGreaterThanOrEqual(0);
        expect(m).toBeLessThanOrEqual(max);
      }
    }
    expect(sessionMaxSeconds(nowMs / 1000 - 10 * 86400, nowMs)).toBe(0);
  });
});

describe("oversized tokens", () => {
  it("throws SessionCookieTooLargeError for an oversized ID token or refresh token", () => {
    const big = "a".repeat(4000);
    const opts = { secure: true, maxAgeSeconds: 100 };
    expect(() => buildSetCookies({ idToken: big, refreshToken: "r" }, opts)).toThrow(SessionCookieTooLargeError);
    expect(() => buildSetCookies({ idToken: "i", refreshToken: big }, opts)).toThrow(SessionCookieTooLargeError);
  });
});

describe("parseSessionCookies", () => {
  it("round-trips built cookies", () => {
    const header = buildSetCookies(tokens, { secure: true, maxAgeSeconds: 10 })
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(parseSessionCookies(header, true)).toEqual(tokens);
  });

  it("does not throw on malformed headers and ignores invalid values", () => {
    const n = cookieNames(false);
    const headers: Array<string | null | undefined> = [
      undefined,
      null,
      "",
      ";;;===;",
      "garbage",
      `${n.id}`,
      `${n.id}=`,
      `${n.id}=bad value with spaces; ${n.rt}=<script>`,
      `${n.id}=%E0%A4%A; ${n.rt}=ok.value`,
      `${n.id}=ünïcode`,
    ];
    for (const h of headers) {
      expect(() => parseSessionCookies(h, false)).not.toThrow();
    }
    expect(parseSessionCookies(`${n.id}=bad value; ${n.rt}=<x>`, false)).toEqual({});
    expect(parseSessionCookies(`${n.id}=%E0%A4%A; ${n.rt}=ok.value`, false)).toEqual({ refreshToken: "ok.value" });
  });

  it("ignores oversized values without throwing", () => {
    const n = cookieNames(false);
    const huge = "a".repeat(MAX_COOKIE_VALUE_CHARS + 1);
    const header = `${n.id}=${huge}; ${n.rt}=fine`;
    expect(() => parseSessionCookies(header, false)).not.toThrow();
    expect(parseSessionCookies(header, false)).toEqual({ refreshToken: "fine" });
    expect(() => parseSessionCookies("x=" + "b".repeat(200000), true)).not.toThrow();
    expect(parseSessionCookies(`${n.id}=${"a".repeat(MAX_COOKIE_VALUE_CHARS)}`, false).idToken).toHaveLength(
      MAX_COOKIE_VALUE_CHARS,
    );
  });

  it("only reads cookies for the matching mode's names", () => {
    const header = `${cookieNames(false).id}=abc`;
    expect(parseSessionCookies(header, true)).toEqual({});
  });
});
