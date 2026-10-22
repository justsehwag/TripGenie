"use client";

/**
 * Account landing / sign-in surface.
 *
 * "Continue with email" now reveals a real in-app email/password sign-in
 * form that POSTs { action: "signin" } to /api/auth (Amazon Cognito,
 * USER_PASSWORD_AUTH on the server - no secret in the browser). Social
 * providers still redirect to the hosted UI when configured. All controls
 * reuse the existing auth / surface / field / cta / notice classes.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  landingControls,
  greeting,
  persistenceTarget,
  type IdentityProviderPolicy,
  type IdentitySession,
  type Provider,
  type SignInControl,
} from "@/lib/identity";

export interface AuthLandingProps {
  policy: IdentityProviderPolicy;
  session?: IdentitySession | null;
  authError?: string;
  onContinueAsGuest?: () => void;
  onSignIn?: (provider: Provider) => void;
}

function hostedUiUrl(provider: Provider): string {
  const domain = process.env.NEXT_PUBLIC_TRIPGENIE_COGNITO_DOMAIN?.trim();
  const clientId = process.env.NEXT_PUBLIC_TRIPGENIE_COGNITO_CLIENT_ID?.trim();
  const redirectUri = process.env.NEXT_PUBLIC_TRIPGENIE_COGNITO_REDIRECT_URI?.trim();
  const idpHint: Record<Provider, string | null> = {
    email: null,
    google: "Google",
    facebook: "Facebook",
    github: "GitHub",
  };
  if (!domain || !clientId || !redirectUri) {
    const hint = idpHint[provider];
    return `#cognito-hosted-ui-not-configured${hint ? `:${hint}` : ":email"}`;
  }
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    scope: "openid email profile",
    redirect_uri: redirectUri,
  });
  const hint = idpHint[provider];
  if (hint) params.set("identity_provider", hint);
  return `${domain.replace(/\/$/, "")}/oauth2/authorize?${params.toString()}`;
}

async function postSignin(email: string, password: string) {
  const res = await fetch("/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "signin", email, password }),
  });
  return (await res.json()) as { ok: boolean; code: string; message: string };
}

export default function AuthLanding({
  policy,
  session = null,
  authError,
  onContinueAsGuest,
  onSignIn,
}: AuthLandingProps) {
  const router = useRouter();
  const controls: SignInControl[] = useMemo(
    () => landingControls(policy),
    [policy],
  );
  const heading = greeting(session);

  const [showEmail, setShowEmail] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function startSignIn(provider: Provider) {
    if (onSignIn) {
      onSignIn(provider);
      return;
    }
    if (provider === "email") {
      setShowEmail((v) => !v);
      setError("");
      setNotice("");
      return;
    }
    if (typeof window !== "undefined") {
      window.location.assign(hostedUiUrl(provider));
    }
  }

  async function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const r = await postSignin(email, password);
      if (r.ok && r.code === "SUCCESS") {
        // Persist a minimal browser-local session so the rest of the app
        // recognizes the signed-in traveler (same key My_Trips reads), then
        // route into the planner rather than back to this sign-in page.
        if (typeof window !== "undefined") {
          try {
            window.localStorage.setItem(
              "tripgenie.session",
              JSON.stringify({ userId: email.trim().toLowerCase(), email: email.trim() }),
            );
          } catch {
            // Storage unavailable is non-fatal; the redirect still proceeds.
          }
        }
        setNotice("Signed in. Taking you to the planner...");
        window.setTimeout(() => router.push("/plan"), 700);
      } else if (r.code === "CONFIRM_REQUIRED") {
        setNotice(r.message);
        window.setTimeout(() => router.push("/signup"), 1200);
      } else {
        setError(r.message || "We could not sign you in.");
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function continueAsGuest() {
    if (onContinueAsGuest) {
      onContinueAsGuest();
      return;
    }
    if (
      typeof window !== "undefined" &&
      persistenceTarget(null) === "browser-local"
    ) {
      window.location.assign("/plan");
    }
  }

  return (
    <main className="shell auth auth-glass-page">
      <div className="auth-glass-page__glow" aria-hidden="true" />

      <section className="motion-rise auth__intro">
        <p className="eyebrow">Your account</p>
        <h1 className="display">{heading}</h1>
        <p className="lead">
          Sign in to keep your trips and profile in sync across devices, or
          continue as a guest and we will keep everything on this device.
        </p>
      </section>

      <div className="auth-glass-grid">
        <section className="auth-glass motion-rise" aria-labelledby="auth-signin-heading">
          <h2 id="auth-signin-heading" className="auth__heading">
            Sign in
          </h2>

          {authError && (
            <p role="alert" className="notice notice--error auth__error">
              {authError}
            </p>
          )}
          {error && (
            <p role="alert" className="notice notice--error auth__error">{error}</p>
          )}
          {notice && <p className="notice">{notice}</p>}

          <ul className="auth__options" aria-label="Available sign-in options">
            {controls.map((control) => (
              <li key={control.provider} className="auth__option">
                <button
                  type="button"
                  className={control.provider === "email" ? "cta auth__cta" : "btn auth__cta auth__cta--social"}
                  data-provider={control.provider}
                  aria-label={control.label}
                  aria-expanded={control.provider === "email" ? showEmail : undefined}
                  onClick={() => startSignIn(control.provider)}
                >
                  {control.label}
                </button>
              </li>
            ))}
          </ul>

          {showEmail && (
            <form className="auth__options auth-email-form" onSubmit={submitEmail}>
              <label className="field">
                <span>Email</span>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                />
              </label>
              <label className="field">
                <span>Password</span>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Your password"
                  autoComplete="current-password"
                />
              </label>
              <button type="submit" className="cta auth__cta" disabled={busy} aria-busy={busy}>
                {busy ? "Signing in..." : "Sign in"}
              </button>
            </form>
          )}

          <p className="auth__note">
            We never see or store your password. Sign-in is secured by Amazon
            Cognito.
          </p>
          <p className="auth__note">
            New to TripGenie? <a className="inline-link" href="/signup">Create an account</a>.
          </p>

          <div className="auth-glass__divider"><span>or</span></div>
          <button
            type="button"
            className="btn auth-glass__guest-btn"
            onClick={continueAsGuest}
            aria-label="Continue without signing in"
          >
            Continue without signing in
          </button>
        </section>
      </div>
    </main>
  );
}
