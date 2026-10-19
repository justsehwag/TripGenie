/**
 * Identity (Cognito OIDC) core - design section 1.
 * Landing controls from the enabled-provider policy; greeting selection;
 * anonymous access with browser-local persistence.
 * Requirements: 1.1-1.10, 13.1.
 */

export type Provider = "email" | "google" | "facebook" | "github";

export interface IdentityProviderPolicy {
  enabledProviders: Provider[];
}

export interface SignInControl { provider: Provider; label: string }

const LABELS: Record<Provider, string> = {
  email: "Continue with email",
  google: "Continue with Google",
  facebook: "Continue with Facebook",
  github: "Continue with GitHub",
};

const ORDER: Provider[] = ["email", "google", "facebook", "github"];

/**
 * One sign-in control per enabled provider, in a stable order; disabled
 * providers are omitted entirely (Req 1.1/1.7).
 */
export function landingControls(policy: IdentityProviderPolicy): SignInControl[] {
  const enabled = new Set(policy.enabledProviders);
  return ORDER.filter((p) => enabled.has(p)).map((p) => ({ provider: p, label: LABELS[p] }));
}

export interface IdentitySession {
  userId: string;
  firstName?: string;
  email?: string;
}

/** Greet by first name when present, else a generic no-name greeting (Req 1.8/1.9). */
export function greeting(session: IdentitySession | null): string {
  const first = session?.firstName?.trim();
  return first ? `Welcome back, ${first}.` : "Welcome to TripGenie.";
}

export type PersistenceTarget = "dynamodb" | "browser-local";

/**
 * An authenticated session persists to DynamoDB; an anonymous visitor's trip
 * data stays in browser-local storage only (Req 1.5/13.1).
 */
export function persistenceTarget(session: IdentitySession | null): PersistenceTarget {
  return session && session.userId ? "dynamodb" : "browser-local";
}

export type AuthOutcome = "success" | "failed" | "cancelled" | "timeout";

/** On any non-success outcome, return to landing and preserve browser-local drafts (Req 1.10). */
export function postAuth(outcome: AuthOutcome): { landing: boolean; error?: string; preserveDrafts: boolean } {
  if (outcome === "success") return { landing: false, preserveDrafts: true };
  return {
    landing: true,
    error: "Sign-in did not complete. Please try again.",
    preserveDrafts: true,
  };
}
