// Server-only Amazon Cognito auth helpers (sign-up, email confirm, sign-in).
// SERVER-ONLY: never import from a "use client" module. The Cognito client is
// built lazily so this module stays importable without env/SDK side effects.
import { awsConfig } from "./config";

export interface AuthConfigStatus { configured: boolean; reason?: string; }

export function cognitoStatus(): AuthConfigStatus {
  const { userPoolId, clientId } = awsConfig.cognito;
  if (!userPoolId || !clientId) {
    return { configured: false, reason: "Cognito is not configured (set COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID)." };
  }
  return { configured: true };
}

export interface AuthResult {
  ok: boolean;
  /** Machine code: SUCCESS | CONFIRM_REQUIRED | ERROR | NOT_CONFIGURED. */
  code: "SUCCESS" | "CONFIRM_REQUIRED" | "ERROR" | "NOT_CONFIGURED";
  message: string;
  /** Present on a successful sign-in. */
  tokens?: { idToken?: string; accessToken?: string; refreshToken?: string; expiresIn?: number };
}

/** Lazily build the Cognito client (dynamic import; no top-level SDK load). */
async function client() {
  const { CognitoIdentityProviderClient } = await import("@aws-sdk/client-cognito-identity-provider");
  return new CognitoIdentityProviderClient({ region: awsConfig.cognito.region });
}

/** Map a Cognito SDK error to a safe, user-facing message. */
function friendly(name: string, fallback: string): string {
  switch (name) {
    case "UsernameExistsException": return "An account with this email already exists. Try signing in.";
    case "InvalidPasswordException": return "Password does not meet the requirements (8+ chars, upper, lower, number).";
    case "CodeMismatchException": return "That confirmation code is incorrect. Please check and try again.";
    case "ExpiredCodeException": return "That confirmation code has expired. Request a new one.";
    case "UserNotConfirmedException": return "Please confirm your email first - check your inbox for the code.";
    case "NotAuthorizedException": return "Incorrect email or password.";
    case "UserNotFoundException": return "Incorrect email or password.";
    case "LimitExceededException": return "Too many attempts. Please wait a moment and try again.";
    default: return fallback;
  }
}


/** Register a new user (email + password + optional name). Sends a verify code. */
export async function signUp(email: string, password: string, name?: string): Promise<AuthResult> {
  const status = cognitoStatus();
  if (!status.configured) return { ok: false, code: "NOT_CONFIGURED", message: status.reason! };
  try {
    const { SignUpCommand } = await import("@aws-sdk/client-cognito-identity-provider");
    const attrs = [{ Name: "email", Value: email }];
    if (name && name.trim()) attrs.push({ Name: "name", Value: name.trim() });
    const c = await client();
    await c.send(new SignUpCommand({ ClientId: awsConfig.cognito.clientId, Username: email, Password: password, UserAttributes: attrs }));
    return { ok: true, code: "CONFIRM_REQUIRED", message: "Account created. Check your email for a 6-digit confirmation code." };
  } catch (e: unknown) {
    const name2 = (e as { name?: string })?.name ?? "";
    return { ok: false, code: "ERROR", message: friendly(name2, "Could not create the account. Please try again.") };
  }
}

/** Confirm a sign-up with the emailed code. */
export async function confirmSignUp(email: string, code: string): Promise<AuthResult> {
  const status = cognitoStatus();
  if (!status.configured) return { ok: false, code: "NOT_CONFIGURED", message: status.reason! };
  try {
    const { ConfirmSignUpCommand } = await import("@aws-sdk/client-cognito-identity-provider");
    const c = await client();
    await c.send(new ConfirmSignUpCommand({ ClientId: awsConfig.cognito.clientId, Username: email, ConfirmationCode: code }));
    return { ok: true, code: "SUCCESS", message: "Email confirmed. You can now sign in." };
  } catch (e: unknown) {
    const name2 = (e as { name?: string })?.name ?? "";
    return { ok: false, code: "ERROR", message: friendly(name2, "Could not confirm the code. Please try again.") };
  }
}

/** Resend the confirmation code to an unconfirmed user. */
export async function resendCode(email: string): Promise<AuthResult> {
  const status = cognitoStatus();
  if (!status.configured) return { ok: false, code: "NOT_CONFIGURED", message: status.reason! };
  try {
    const { ResendConfirmationCodeCommand } = await import("@aws-sdk/client-cognito-identity-provider");
    const c = await client();
    await c.send(new ResendConfirmationCodeCommand({ ClientId: awsConfig.cognito.clientId, Username: email }));
    return { ok: true, code: "CONFIRM_REQUIRED", message: "A new confirmation code has been sent to your email." };
  } catch (e: unknown) {
    const name2 = (e as { name?: string })?.name ?? "";
    return { ok: false, code: "ERROR", message: friendly(name2, "Could not resend the code. Please try again.") };
  }
}

/** Sign in with email + password (USER_PASSWORD_AUTH). Returns tokens on success. */
export async function signIn(email: string, password: string): Promise<AuthResult> {
  const status = cognitoStatus();
  if (!status.configured) return { ok: false, code: "NOT_CONFIGURED", message: status.reason! };
  try {
    const { InitiateAuthCommand } = await import("@aws-sdk/client-cognito-identity-provider");
    const c = await client();
    const res = await c.send(new InitiateAuthCommand({ ClientId: awsConfig.cognito.clientId, AuthFlow: "USER_PASSWORD_AUTH", AuthParameters: { USERNAME: email, PASSWORD: password } }));
    const r = res.AuthenticationResult;
    return { ok: true, code: "SUCCESS", message: "Signed in.", tokens: { idToken: r?.IdToken, accessToken: r?.AccessToken, refreshToken: r?.RefreshToken, expiresIn: r?.ExpiresIn } };
  } catch (e: unknown) {
    const name2 = (e as { name?: string })?.name ?? "";
    return { ok: false, code: "ERROR", message: friendly(name2, "Could not sign in. Please try again.") };
  }
}

