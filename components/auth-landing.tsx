"use client";

/**
 * Account landing (Group B / Task 29.1) - design section "1. Identity (Cognito OIDC)".
 *
 * Renders the TripGenie account landing wired to the pure identity core in
 * `lib/identity.ts`. The provider list is NEVER hardcoded here: the controls
 * come from `landingControls(policy)`, so a provider absent from the enabled
 * policy is omitted entirely (Req 1.1 / 1.7).
 *
 * Boundary preserved from the design: this component holds no password, no
 * OAuth secret, and implements no OAuth callback (Req 1.3 / 1.4). Amazon
 * Cognito owns the entire credential exchange. Activating a control simply
 * redirects the browser to the Cognito hosted UI (Req 1.2). A guest may
 * continue without signing in, which keeps trip data in browser-local storage
 * only (Req 1.5, surfaced via `persistenceTarget`). An authenticated visitor
 * is greeted by first name when available, else a generic no-name greeting
 * (Req 1.8 / 1.9, via `greeting`). A failed/cancelled/timed-out sign-in returns
 * here with an error while browser-local drafts are preserved (Req 1.10, via
 * `postAuth`).
 *
 * Requirements: 1.1, 1.2, 1.5, 1.7, 1.8, 1.9, 1.10.
 */

import { useMemo } from "react";
import {
  landingControls,
  greeting,
  persistenceTarget,
  type IdentityProviderPolicy,
  type IdentitySession,
  type Provider,
  type SignInControl,
} from "@/lib/identity";
import { illustration } from "@/lib/illustrations";

export interface AuthLandingProps {
  /** Enabled-provider policy; its order/contents decide which controls render. */
  policy: IdentityProviderPolicy;
  /** Current session if the browser already has one (drives the greeting). */
  session?: IdentitySession | null;
  /**
   * Non-success return from a prior redirect (failure/cancel/timeout). When
   * present, the landing shows the preserved error from `postAuth` (Req 1.10).
   */
  authError?: string;
  /**
   * Continue without signing in (Req 1.5). The anonymous workspace keeps data
   * in browser-local storage only - `persistenceTarget(null)` is
   * `"browser-local"`. Defaults to navigating to the Planning_Workspace.
   */
  onContinueAsGuest?: () => void;
  /**
   * Optional override for initiating the hosted-UI redirect, injected by tests
   * so no real navigation happens. Defaults to a `window.location` assignment.
   */
  onSignIn?: (provider: Provider) => void;
}

/**
 * Build the Cognito hosted-UI authorize URL for a provider.
 *
 * The public PKCE client id, hosted domain, and redirect URI are read from
 * build-time public env (`NEXT_PUBLIC_*`) - these are NOT secrets (a hosted-UI
 * PKCE client carries no client secret; the redirect is a public callback URL
 * Cognito itself owns). No OAuth secret ever lives in this component.
 *
 * When the deployment has not yet wired a Cognito domain, we fall back to a
 * clearly-labelled placeholder authorize path so the control is still operable
 * and testable offline. The application does NOT implement the callback at that
 * path - Cognito handles the exchange and returns to the configured redirect URI
 * (Req 1.3 / 1.4).
 */
function hostedUiUrl(provider: Provider): string {
  const domain = process.env.NEXT_PUBLIC_TRIPGENIE_COGNITO_DOMAIN?.trim();
  const clientId = process.env.NEXT_PUBLIC_TRIPGENIE_COGNITO_CLIENT_ID?.trim();
  const redirectUri = process.env.NEXT_PUBLIC_TRIPGENIE_COGNITO_REDIRECT_URI?.trim();

  // Map a landing control to the Cognito identity_provider hint. "email" uses
  // the hosted UI's native Cognito sign-in; social providers pass through.
  const idpHint: Record<Provider, string | null> = {
    email: null,
    google: "Google",
    facebook: "Facebook",
    github: "GitHub",
  };

  // No configured domain yet: a commented placeholder target. Cognito, once
  // configured, owns the real exchange; the app never processes this callback.
  if (!domain || !clientId || !redirectUri) {
    const hint = idpHint[provider];
    return `#cognito-hosted-ui-not-configured${hint ? `:${hint}` : ":email"}`;
  }

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code", // authorization-code + PKCE; no secret in the app
    scope: "openid email profile",
    redirect_uri: redirectUri,
  });
  const hint = idpHint[provider];
  if (hint) params.set("identity_provider", hint);

  return `${domain.replace(/\/$/, "")}/oauth2/authorize?${params.toString()}`;
}

export default function AuthLanding({
  policy,
  session = null,
  authError,
  onContinueAsGuest,
  onSignIn,
}: AuthLandingProps) {
  // Controls derive entirely from the policy - disabled providers are absent.
  const controls: SignInControl[] = useMemo(
    () => landingControls(policy),
    [policy],
  );

  // Greeting selects first-name vs. generic no-name text (Req 1.8 / 1.9).
  const heading = greeting(session);

  function startSignIn(provider: Provider) {
    if (onSignIn) {
      onSignIn(provider);
      return;
    }
    // Redirect the browser to the Cognito hosted UI (Req 1.2). This is the
    // entire app-side responsibility - Cognito owns the credential exchange.
    if (typeof window !== "undefined") {
      window.location.assign(hostedUiUrl(provider));
    }
  }

  function continueAsGuest() {
    if (onContinueAsGuest) {
      onContinueAsGuest();
      return;
    }
    // Anonymous access: trip data stays in browser-local storage only (Req 1.5).
    // persistenceTarget(null) === "browser-local" documents that boundary.
    if (typeof window !== "undefined" && persistenceTarget(null) === "browser-local") {
      window.location.assign("/plan");
    }
  }

  // Restrained illustration accent for the identity surface (aria-hidden; the
  // alt text lives in the registry but the mark here is purely decorative).
  const suitcase = illustration("suitcase");

  return (
    <main className="shell auth">
      <section className="motion-rise auth__intro">
        <p className="eyebrow">Your account</p>
        <h1 className="display">{heading}</h1>
        <p className="lead">
          Sign in to keep your trips and profile in sync across devices, or
          continue as a guest and we will keep everything on this device.
        </p>
      </section>

      <div className="grid-2">
        {/* White surface: sign-in controls stay fully legible, never glass. */}
        <section className="surface" aria-labelledby="auth-signin-heading">
          <h2 id="auth-signin-heading" className="auth__heading">
            Sign in
          </h2>

          {authError && (
            <p role="alert" className="notice notice--error auth__error">
              {authError}
            </p>
          )}

          {/* Exactly one control per enabled provider; omitted when disabled. */}
          <ul className="auth__options" aria-label="Available sign-in options">
            {controls.map((control) => (
              <li key={control.provider} className="auth__option">
                {/* Submit control is the orange Primary_Action (Req 14.2). */}
                <button
                  type="button"
                  className="cta auth__cta"
                  data-provider={control.provider}
                  aria-label={control.label}
                  onClick={() => startSignIn(control.provider)}
                >
                  {control.label}
                </button>
              </li>
            ))}
          </ul>

          <p className="auth__note">
            We never see or store your password. Sign-in is handled by our
            secure hosted account service.
          </p>
        </section>

        {/* White surface: the guest/anonymous path (secondary, non-orange). */}
        <aside className="card motion-rise auth__guest" aria-labelledby="auth-guest-heading">
          <img
            className="illustration auth__art"
            src={suitcase.src}
            width={suitcase.width}
            height={suitcase.height}
            alt=""
            aria-hidden="true"
          />
          <h2 id="auth-guest-heading" className="auth__heading">
            Just exploring?
          </h2>
          <p>
            Continue without an account. Your trip stays on this device until
            you choose to sign in - nothing is lost.
          </p>
          {/* Secondary action — neutral .btn so the orange Primary_Action is
              reserved for sign-in (Req 14.2). */}
          <button
            type="button"
            className="btn"
            onClick={continueAsGuest}
            aria-label="Continue without signing in"
          >
            Continue without signing in
          </button>
        </aside>
      </div>
    </main>
  );
}
