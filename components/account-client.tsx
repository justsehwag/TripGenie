"use client";

/**
 * Account surface switch. When the browser-local session (the key the sign-in
 * form writes) is present, show a signed-in PROFILE view - greeting, the
 * circular explorer avatar, quick links and sign-out - instead of sending an
 * already-signed-in traveller back to the sign-in form. When anonymous, render
 * the existing AuthLanding sign-in. This fixes "clicking My account shows the
 * login page again even though I'm signed in".
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AuthLanding from "@/components/auth-landing";
import type { IdentityProviderPolicy, IdentitySession } from "@/lib/identity";

function readSession(): IdentitySession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem("tripgenie.session");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<IdentitySession>;
    if (parsed && typeof parsed.userId === "string" && parsed.userId.trim()) {
      return {
        userId: parsed.userId.trim(),
        firstName: typeof parsed.firstName === "string" ? parsed.firstName : undefined,
        email: typeof parsed.email === "string" ? parsed.email : undefined,
      };
    }
  } catch {
    // corrupt -> anonymous
  }
  return null;
}

function ExplorerAvatar() {
  return (
    <svg width="72" height="72" viewBox="0 0 32 32" fill="none" role="img" aria-label="Your explorer avatar">
      <circle cx="16" cy="16" r="16" fill="var(--color-deep-emerald)" />
      <circle cx="16" cy="14" r="5" fill="#FFE2C2" />
      <path d="M7 12h18l-2-2c-2.2-2.2-4.6-3.2-7-3.2S10.2 7.8 8 10l-1 2z" fill="var(--color-action-orange)" />
      <rect x="12.4" y="10.5" width="7.2" height="2" rx="1" fill="#FFFFFF" opacity="0.85" />
      <path d="M8 27c0-4.4 3.6-7.5 8-7.5s8 3.1 8 7.5" fill="#FFFFFF" />
    </svg>
  );
}

export default function AccountClient({ policy }: { policy: IdentityProviderPolicy }) {
  const router = useRouter();
  const [session, setSession] = useState<IdentitySession | null | undefined>(undefined);

  useEffect(() => {
    setSession(readSession());
    function onStorage(e: StorageEvent) {
      if (e.key === "tripgenie.session" || e.key === null) setSession(readSession());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  function signOut() {
    if (typeof window !== "undefined") {
      try { window.localStorage.removeItem("tripgenie.session"); } catch {}
    }
    setSession(null);
  }

  // Still resolving (first paint) - render the sign-in so SSR/CSR agree; it is
  // swapped for the profile view immediately if a session is found.
  if (session === undefined || session === null) {
    return <AuthLanding policy={policy} />;
  }

  const name = session.firstName?.trim() || session.email?.split("@")[0] || "Explorer";

  return (
    <main className="shell auth auth-glass-page">
      <div className="auth-glass-page__glow" aria-hidden="true" />
      <section className="motion-rise auth__intro">
        <p className="eyebrow">Your account</p>
        <h1 className="display">Welcome back, {name}</h1>
      </section>

      <div className="auth-glass-grid auth-glass-grid--single">
        <section className="auth-glass motion-rise account-profile">
          <div className="account-profile__head">
            <span className="account-profile__avatar"><ExplorerAvatar /></span>
            <div>
              <p className="account-profile__name">{name}</p>
              {session.email && <p className="account-profile__email">{session.email}</p>}
            </div>
          </div>

          <ul className="account-profile__links">
            <li><a className="btn account-profile__link" href="/trips">My trips</a></li>
            <li><a className="btn account-profile__link" href="/plan">Plan a new trip</a></li>
            <li><a className="btn account-profile__link" href="/discover">Discover places</a></li>
          </ul>

          <button type="button" className="btn account-profile__signout" onClick={signOut}>
            Sign out
          </button>
          <p className="auth__note">
            Signed in, so your saved trips sync to your account.{" "}
            <button type="button" className="inline-link account-profile__switch" onClick={() => { signOut(); router.push("/account"); }}>
              Use a different account
            </button>
          </p>
        </section>
      </div>
    </main>
  );
}