"use client";

/**
 * Account surface switch over a cinematic full-screen travel backdrop.
 *
 * Signed-in: a floating glass PROFILE card (greeting, explorer avatar, quick-
 * link tiles, sign-out) over the immersive AccountHero backdrop. Anonymous:
 * the redesigned AuthLanding sign-in (same backdrop).
 *
 * Behavior is unchanged: readSession/the session switch, signOut, the
 * "use a different account" flow, the My trips / Plan / Discover hrefs, and the
 * SSR-safe "undefined|null -> AuthLanding" fallback are all preserved.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AuthLanding from "@/components/auth-landing";
import { AccountHero } from "@/components/account-hero";
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

function TileIcon({ kind }: { kind: "trips" | "plan" | "discover" }) {
  const d =
    kind === "trips"
      ? "M4 7h16M4 12h16M4 17h10"
      : kind === "plan"
        ? "M12 5v14M5 12h14"
        : "M12 21s7-6.5 7-11a7 7 0 10-14 0c0 4.5 7 11 7 11z";
  return (
    <svg className="account-tile__icon" viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      {kind === "discover" && <circle cx="12" cy="10" r="2.4" stroke="currentColor" strokeWidth="1.8" />}
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
    <main className="account-stage">
      <AccountHero
        eyebrow="Your account"
        title="Your next journey awaits"
        subtitle="Every trip you plan stays synced and ready wherever you go."
        points={["Live hotel & flight prices", "AI day-by-day itineraries", "Synced across your devices"]}
      />

      <div className="account-stage__panel">
        <section className="account-card account-card--rise" aria-label="Your account">
          <p className="account-card__eyebrow">Welcome back</p>
          <div className="account-card__head">
            <span className="account-card__avatar"><ExplorerAvatar /></span>
            <div className="account-card__id">
              <p className="account-card__name">{name}</p>
              {session.email && <p className="account-card__email">{session.email}</p>}
            </div>
          </div>

          <ul className="account-tiles">
            <li>
              <a className="account-tile" href="/trips">
                <span className="account-tile__badge"><TileIcon kind="trips" /></span>
                <span className="account-tile__text">
                  <span className="account-tile__title">My trips</span>
                  <span className="account-tile__sub">Saved plans &amp; bookings</span>
                </span>
                <span className="account-tile__chevron" aria-hidden="true">{"\u2192"}</span>
              </a>
            </li>
            <li>
              <a className="account-tile" href="/plan">
                <span className="account-tile__badge"><TileIcon kind="plan" /></span>
                <span className="account-tile__text">
                  <span className="account-tile__title">Plan a new trip</span>
                  <span className="account-tile__sub">Let the AI assistant draft it</span>
                </span>
                <span className="account-tile__chevron" aria-hidden="true">{"\u2192"}</span>
              </a>
            </li>
            <li>
              <a className="account-tile" href="/discover">
                <span className="account-tile__badge"><TileIcon kind="discover" /></span>
                <span className="account-tile__text">
                  <span className="account-tile__title">Discover places</span>
                  <span className="account-tile__sub">Find your next destination</span>
                </span>
                <span className="account-tile__chevron" aria-hidden="true">{"\u2192"}</span>
              </a>
            </li>
          </ul>

          <button type="button" className="cta account-card__signout" onClick={signOut}>
            Sign out
          </button>
          <p className="account-card__note">
            Signed in, so your saved trips sync to your account.{" "}
            <button type="button" className="inline-link" onClick={() => { signOut(); router.push("/account"); }}>
              Use a different account
            </button>
          </p>
        </section>
      </div>
    </main>
  );
}