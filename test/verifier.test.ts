import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { JwtExpiredError, JwtInvalidClaimError, JwtInvalidSignatureError } from "aws-jwt-verify/error";
import { getVerifier, resetVerifierForTests, verifyIdToken } from "@/lib/auth/verifier";

const REGION = "us-east-1";
const POOL = "us-east-1_TestPool1";
const CLIENT = "test-client-id";
const KID = "test-kid-1";
const SUB = "11111111-2222-3333-4444-555555555555";
const OVERRIDES = { userPoolId: POOL, clientId: CLIENT, region: REGION };

const b64u = (v: Buffer | string) => Buffer.from(v).toString("base64url");

const good = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

function issuer(pool = POOL) {
  return `https://cognito-idp.${REGION}.amazonaws.com/${pool}`;
}

function claims(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: SUB,
    aud: CLIENT,
    iss: issuer(),
    token_use: "id",
    iat: now - 10,
    auth_time: now - 10,
    exp: now + 3600,
    email: "a@example.com",
    name: "Alex",
    nonce: "n-1",
    ...extra,
  };
}

function makeToken(
  payload: Record<string, unknown>,
  opts: { key?: KeyObject; header?: Record<string, unknown> } = {},
): string {
  const header = opts.header ?? { alg: "RS256", kid: KID, typ: "JWT" };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  if (header.alg === "none") return `${input}.`;
  const sig = sign("RSA-SHA256", Buffer.from(input), opts.key ?? good.privateKey);
  return `${input}.${b64u(sig)}`;
}

let created: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

beforeEach(() => {
  resetVerifierForTests();
  created = null;
  const realCreate = CognitoJwtVerifier.create.bind(CognitoJwtVerifier);
  vi.spyOn(CognitoJwtVerifier, "create").mockImplementation(((props: never, extra?: never) => {
    const v = realCreate(props, extra);
    const jwk = { ...(good.publicKey.export({ format: "jwk" }) as object), kid: KID, alg: "RS256", use: "sig" };
    v.cacheJwks({ keys: [jwk] } as never);
    created = v as never;
    return v;
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetVerifierForTests();
});

describe("verifyIdToken", () => {
  it("accepts a valid token and returns sub and optional claims", async () => {
    const out = await verifyIdToken(makeToken(claims()), OVERRIDES);
    expect(out.sub).toBe(SUB);
    expect(out.email).toBe("a@example.com");
    expect(out.name).toBe("Alex");
    expect(out.nonce).toBe("n-1");
    expect(typeof out.authTime).toBe("number");
    expect(created).not.toBeNull();
  });

  it("rejects a bad signature", async () => {
    const t = makeToken(claims(), { key: other.privateKey });
    await expect(verifyIdToken(t, OVERRIDES)).rejects.toBeInstanceOf(JwtInvalidSignatureError);
  });

  it("rejects an expired token", async () => {
    const t = makeToken(claims({ exp: Math.floor(Date.now() / 1000) - 3600 }));
    await expect(verifyIdToken(t, OVERRIDES)).rejects.toBeInstanceOf(JwtExpiredError);
  });

  it("rejects a wrong audience", async () => {
    const t = makeToken(claims({ aud: "someone-else" }));
    await expect(verifyIdToken(t, OVERRIDES)).rejects.toThrow(/Client ID/);
  });

  it("rejects a wrong issuer / pool", async () => {
    const t = makeToken(claims({ iss: issuer("us-east-1_OtherPool") }));
    await expect(verifyIdToken(t, OVERRIDES)).rejects.toThrow(/issuer/i);
  });

  it("rejects an access token (wrong token_use)", async () => {
    const t = makeToken(claims({ token_use: "access" }));
    await expect(verifyIdToken(t, OVERRIDES)).rejects.toBeInstanceOf(JwtInvalidClaimError);
  });

  it("rejects alg none", async () => {
    const t = makeToken(claims(), { header: { alg: "none", kid: KID, typ: "JWT" } });
    await expect(verifyIdToken(t, OVERRIDES)).rejects.toThrow();
  });

  it("rejects malformed strings", async () => {
    for (const t of ["", "not-a-jwt", "a.b", "a.b.c", "....."]) {
      await expect(verifyIdToken(t, OVERRIDES)).rejects.toThrow();
    }
  });

  it("rejects a non-UUID sub with invalid_sub", async () => {
    for (const sub of ["not-a-uuid", "../../etc/passwd", "1234"]) {
      await expect(verifyIdToken(makeToken(claims({ sub })), OVERRIDES)).rejects.toThrow("invalid_sub");
    }
  });
});

describe("getVerifier configuration", () => {
  it("fails closed when the pool prefix and region differ", async () => {
    const bad = { userPoolId: "eu-west-1_TestPool1", clientId: CLIENT, region: REGION };
    expect(() => getVerifier(bad)).toThrow("auth_unavailable");
    await expect(verifyIdToken(makeToken(claims()), bad)).rejects.toThrow("auth_unavailable");
  });

  it("fails closed when the pool id has no underscore", () => {
    expect(() => getVerifier({ userPoolId: "nopool", clientId: CLIENT, region: REGION })).toThrow("auth_unavailable");
  });
});
