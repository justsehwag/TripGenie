import { CognitoJwtVerifier } from "aws-jwt-verify";
import { awsConfig } from "../config";
import { logSafe } from "../log";

/**
 * Cognito ID-token verification. Server-side only (never import from client
 * components). Verification errors from aws-jwt-verify (for example
 * `JwtExpiredError` from `aws-jwt-verify/error`) propagate to the caller.
 */

export interface IdTokenClaims {
  sub: string;
  email?: string;
  name?: string;
  /** auth_time claim, epoch seconds. */
  authTime?: number;
  /** nonce claim, used by the OAuth callback. */
  nonce?: string;
}

export interface IdTokenVerifier {
  verify(token: string): Promise<Record<string, unknown>>;
}

export interface VerifierOverrides {
  verifier?: IdTokenVerifier;
  userPoolId?: string;
  clientId?: string;
  region?: string;
}

const SUB_PATTERN = /^[0-9a-f-]{36}$/;

let singleton: IdTokenVerifier | null = null;

/** Clears the cached verifier (tests). */
export function resetVerifierForTests(): void {
  singleton = null;
}

/**
 * Returns the verifier. Built once from `awsConfig.cognito`. An injected
 * verifier is returned as-is and is not cached. Throws a generic error
 * (and logs one generic line) when the pool ID prefix differs from the
 * configured region or the configuration is incomplete.
 */
export function getVerifier(overrides?: VerifierOverrides): IdTokenVerifier {
  if (overrides?.verifier) return overrides.verifier;
  const custom = Boolean(overrides && (overrides.userPoolId || overrides.clientId || overrides.region));
  if (!custom && singleton) return singleton;

  const userPoolId = overrides?.userPoolId ?? awsConfig.cognito.userPoolId;
  const clientId = overrides?.clientId ?? awsConfig.cognito.clientId;
  const region = overrides?.region ?? awsConfig.cognito.region;

  const prefix = userPoolId.split("_")[0];
  if (!userPoolId || !clientId || !region || !userPoolId.includes("_") || prefix !== region) {
    logSafe("auth_verifier_config_invalid");
    throw new Error("auth_unavailable");
  }

  const created = CognitoJwtVerifier.create({ userPoolId, tokenUse: "id", clientId });
  const wrapped: IdTokenVerifier = {
    verify: async (token) => (await created.verify(token)) as unknown as Record<string, unknown>,
  };
  if (!custom) singleton = wrapped;
  return wrapped;
}

/** Verifies an ID token and returns the claims the app uses. */
export async function verifyIdToken(
  token: string,
  overrides?: VerifierOverrides,
): Promise<IdTokenClaims> {
  const payload = await getVerifier(overrides).verify(token);
  const sub = payload.sub;
  if (typeof sub !== "string" || !SUB_PATTERN.test(sub)) {
    throw new Error("invalid_sub");
  }
  const out: IdTokenClaims = { sub };
  if (typeof payload.email === "string") out.email = payload.email;
  if (typeof payload.name === "string") out.name = payload.name;
  if (typeof payload.auth_time === "number") out.authTime = payload.auth_time;
  if (typeof payload.nonce === "string") out.nonce = payload.nonce;
  return out;
}
