"use client";

/**
 * Account landing / sign-in surface - two-panel split.
 * Left: full-bleed landscape AccountHero backdrop (tagline + feature bullets).
 * Right: clean white sign-in card with provider brand icons.
 *
 * Behavior is UNCHANGED: "Continue with email" toggles the in-app email/password
 * form that POSTs { action: "signin" } to /api/auth (Amazon Cognito, server-side);
 * Google navigates to /api/auth/login (shown only when the server reports
 * googleSignIn); "continue without signing in" proceeds as a guest; a
 * successful sign-in relies on the server cookie, refreshes the session via
 * fetchSession and routes to `afterSignInPath` (default "/", Discover). The
 * default guest button (no `onContinueAsGuest`) still goes to /plan.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { fetchSession, notifySession } from "@/lib/client/account-session";
import { useAuthErrorMessage } from "@/components/auth-error-notice";
import { WelcomeHeroBackdrop } from "@/components/welcome-hero-backdrop";
import {
  landingControls,
  greeting,
  persistenceTarget,
  type IdentityProviderPolicy,
  type IdentitySession,
  type Provider,
  type SignInControl,
} from "@/lib/identity";
/* --- Icons (inline, currentColor unless specified) --- */
function GoogleGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.61l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
    </svg>
  );
}
function MailIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2"/>
      <path d="m3 7 9 6 9-6"/>
    </svg>
  );
}
function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="5" y="11" width="14" height="9" rx="2"/>
      <path d="M8 11V7a4 4 0 0 1 8 0v4"/>
    </svg>
  );
}
function controlIcon(p: Provider) {
  if (p === "google") return <GoogleGlyph />;
  if (p === "email") return <MailIcon />;
  return null;
}

export interface AuthLandingProps {
  policy: IdentityProviderPolicy;
  session?: IdentitySession | null;
  authError?: string;
  onContinueAsGuest?: () => void;
  onSignIn?: (provider: Provider) => void;
  /** Where to go after a successful sign-in. Default "/" (Discover). */
  afterSignInPath?: string;
  heading?: string;
  subheading?: string;
  footerNote?: ReactNode;
}

async function postSignin(email: string, password: string) {
  const res = await fetch("/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "signin", email, password }),
  });
  return (await res.json()) as {
    ok: boolean;
    code: string;
    message: string;
    user?: { email?: string; name?: string };
  };
}

export default function AuthLanding({
  policy,
  session = null,
  authError,
  onContinueAsGuest,
  onSignIn,
  afterSignInPath = "/",
  heading: headingText = "Welcome back",
  subheading = "Sign in to continue planning your next trip.",
  footerNote,
}: AuthLandingProps) {
  const googleLoginUrl = `/api/auth/login?provider=Google&returnTo=${encodeURIComponent(afterSignInPath)}`;
  const router = useRouter();
  const [googleSignIn, setGoogleSignIn] = useState(false);
  const queryAuthError = useAuthErrorMessage();
  const controls: SignInControl[] = useMemo(
    () =>
      landingControls(policy).filter(
        (c) => c.provider === "email" || (c.provider === "google" && googleSignIn),
      ),
    [policy, googleSignIn],
  );
  const heading = greeting(session);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth", { method: "GET", credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { googleSignIn?: boolean } | null) => {
        if (!cancelled) setGoogleSignIn(Boolean(d && d.googleSignIn === true));
      })
      .catch(() => {
        if (!cancelled) setGoogleSignIn(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
    if (provider === "google" && typeof window !== "undefined") {
      window.location.assign(googleLoginUrl);
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
        // The server set the httpOnly cookie; ask it who we are (this also
        // refreshes the display-only cache and notifies subscribers).
        const state = await fetchSession();
        if (!state.signedIn && r.user && typeof r.user.email === "string") {
          notifySession({ signedIn: true, user: { email: r.user.email, name: r.user.name } });
        }
        setPassword("");
        setNotice(
          afterSignInPath === "/"
            ? "Signed in. Taking you to Discover..."
            : afterSignInPath === "/plan"
              ? "Signed in. Taking you to the planner..."
              : "Signed in. Taking you back...",
        );
        window.setTimeout(() => router.push(afterSignInPath), 700);
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
    if (typeof window !== "undefined" && persistenceTarget(null) === "browser-local") {
      window.location.assign("/plan");
    }
  }

  return (
    <main className="auth-split auth-split--scenic">
      {/* Backdrop: full-bleed landscape hero behind the sign-in card */}
      <WelcomeHeroBackdrop
        eyebrow="Tripsaathi AI"
        title="Plan smarter. Travel better."
        subtitle="Your trips, priced live and planned by AI - all in one place."
        points={[
          "Live hotel & flight prices",
          "AI day-by-day itineraries",
          "Sign in to save your trips to your account and see them on any device",
        ]}
      />

      {/* Right: sign-in form */}
      <section className="auth-split__form" aria-labelledby="auth-signin-heading">
        <div className="auth-panel">
          <p className="auth-panel__eyebrow">{heading}</p>
          <h2 id="auth-signin-heading" className="auth-panel__title">{headingText}</h2>
          <p className="auth-panel__sub">{subheading}</p>

          {(authError || queryAuthError) && (
            <p role="alert" className="notice notice--error auth-panel__error">{authError || queryAuthError}</p>
          )}
          {error && (
            <p role="alert" className="notice notice--error auth-panel__error">{error}</p>
          )}
          {notice && <p className="notice auth-panel__notice">{notice}</p>}

          <ul className="auth-panel__options" aria-label="Available sign-in options">
            {controls.map((control) => (
              <li key={control.provider}>
                <button
                  type="button"
                  className={control.provider === "email" ? "auth-btn auth-btn--primary" : "auth-btn auth-btn--social"}
                  data-provider={control.provider}
                  aria-label={control.label}
                  aria-expanded={control.provider === "email" ? showEmail : undefined}
                  onClick={() => startSignIn(control.provider)}
                >
                  <span className="auth-btn__icon">{controlIcon(control.provider)}</span>
                  <span>{control.label}</span>
                </button>
              </li>
            ))}
          </ul>

          {showEmail && (
            <form className="auth-panel__form" onSubmit={submitEmail}>
              <label className="field">
                <span>Email</span>
                <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
              </label>
              <label className="field">
                <span>Password</span>
                <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password" autoComplete="current-password" />
              </label>
              <button type="submit" className="auth-btn auth-btn--primary" disabled={busy} aria-busy={busy}>
                {busy ? "Signing in..." : "Sign in"}
              </button>
            </form>
          )}

          {footerNote}

          <div className="auth-panel__divider"><span>or</span></div>
          <button
            type="button"
            className="auth-btn auth-btn--ghost"
            onClick={continueAsGuest}
            aria-label="Continue without signing in"
          >
            Continue without signing in
          </button>

          <p className="auth-panel__trust"><LockIcon /> <span>We never see or store your password. Secured by Amazon Cognito.</span></p>
          <p className="auth-panel__signup">New to Tripsaathi AI? <a className="inline-link" href="/signup">Create an account</a>.</p>
        </div>
      </section>
    </main>
  );
}
