import {
  CognitoIdentityProviderClient,
  GetTokensFromRefreshTokenCommand,
  RevokeTokenCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { awsConfig } from "../config";

/**
 * Cognito token calls. Server-side only. Tokens are never logged.
 * Refresh uses GetTokensFromRefreshToken (works with and without refresh
 * token rotation). RevokeAssociatedSessions is not in the installed SDK
 * (3.1155.0) so it is not sent.
 */

export const REVOKE_TIMEOUT_MS = 3000;
export const EXCHANGE_TIMEOUT_MS = 5000;

export interface RefreshedTokens {
  idToken: string;
  /** Present only when Cognito rotated the refresh token. */
  refreshToken?: string;
}

export interface CognitoSender {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

let defaultClient: CognitoIdentityProviderClient | null = null;

function getClient(): CognitoSender {
  if (!defaultClient) {
    defaultClient = new CognitoIdentityProviderClient({ region: awsConfig.cognito.region });
  }
  return defaultClient as unknown as CognitoSender;
}

export async function refreshTokens(
  refreshToken: string,
  deps: { client?: CognitoSender; clientId?: string } = {},
): Promise<RefreshedTokens> {
  const client = deps.client ?? getClient();
  const out = (await client.send(
    new GetTokensFromRefreshTokenCommand({
      RefreshToken: refreshToken,
      ClientId: deps.clientId ?? awsConfig.cognito.clientId,
    }),
  )) as { AuthenticationResult?: { IdToken?: string; RefreshToken?: string } };
  const idToken = out.AuthenticationResult?.IdToken;
  if (!idToken) throw new Error("refresh_failed");
  const rotated = out.AuthenticationResult?.RefreshToken;
  return rotated ? { idToken, refreshToken: rotated } : { idToken };
}

/** Revokes a refresh token. Aborts after 3 seconds. */
export async function revokeRefreshToken(
  refreshToken: string,
  deps: { client?: CognitoSender; clientId?: string; timeoutMs?: number } = {},
): Promise<void> {
  const client = deps.client ?? getClient();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), deps.timeoutMs ?? REVOKE_TIMEOUT_MS);
  try {
    await client.send(
      new RevokeTokenCommand({
        Token: refreshToken,
        ClientId: deps.clientId ?? awsConfig.cognito.clientId,
      }),
      { abortSignal: ac.signal },
    );
  } finally {
    clearTimeout(timer);
  }
}

export interface ExchangeCodeInput {
  /** Hosted UI host without scheme. */
  domain: string;
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

export interface ExchangedTokens {
  idToken: string;
  refreshToken?: string;
}

/** Authorization-code exchange for a public client (no Authorization header). */
export async function exchangeCode(
  input: ExchangeCodeInput,
  deps: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<ExchangedTokens> {
  const doFetch = deps.fetch ?? fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: input.clientId,
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), deps.timeoutMs ?? EXCHANGE_TIMEOUT_MS);
  try {
    const res = await doFetch(`https://${input.domain}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: ac.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`exchange_failed_${res.status}`);
    const json = (await res.json()) as { id_token?: unknown; refresh_token?: unknown };
    if (typeof json.id_token !== "string" || !json.id_token) throw new Error("exchange_failed");
    return typeof json.refresh_token === "string" && json.refresh_token
      ? { idToken: json.id_token, refreshToken: json.refresh_token }
      : { idToken: json.id_token };
  } finally {
    clearTimeout(timer);
  }
}
