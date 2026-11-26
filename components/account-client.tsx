"use client";

/**
 * Account surface switch over a cinematic full-screen travel backdrop.
 *
 * Signed-in: a floating glass PROFILE card (greeting, explorer avatar, quick-
 * link tiles, sign-out) over the immersive AccountHero backdrop. Anonymous:
 * the AuthLanding sign-in (same backdrop) plus a plain note that guest trips
 * stay on this device.
 *
 * Identity comes from the server session (lib/client/account-session). The copy
 * about where data lives is honest (account-sync requirement 7): the account
 * claim shows only when account storage works, XP and level are always labelled
 * device-only.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AuthLanding from "@/components/auth-landing";
import { AccountHero } from "@/components/account-hero";
import { AccountRecentTrips } from "@/components/account-recent-trips";
import type { IdentityProviderPolicy } from "@/lib/identity";
import {
  fetchSession,
  signOut as signOutAccount,
  subscribeSession,
  type SessionUser,
} from "@/lib/client/account-session";
import { usePageAssistantContext } from "@/components/use-page-assistant-context";
import { useSyncStatus } from "@/lib/client/use-sync-status";
import { useAccountXp } from "@/lib/client/use-account-xp";
import { LEVEL_BANDS, XP_POINTS, levelFor, type XpEvent } from "@/lib/gamification";
import { XP_EVENT_LABELS } from "@/lib/account/xp-labels";

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

function AccountPoints({ signedIn }: { signedIn: boolean }) {
  const xp = useAccountXp(signedIn);
  const total = xp.state?.total ?? 0;
  const level = levelFor(total);
  const span = level.nextAt === null ? 0 : level.nextAt - level.min;
  const pct = level.nextAt === null || span <= 0 ? 100 : Math.max(0, Math.min(100, Math.round(((total - level.min) / span) * 100)));
  const awarded = (xp.state?.awarded ?? []).filter((e) => e in XP_POINTS);

  return (
    <section className="account-points" aria-labelledby="account-points-title">
      {signedIn && (
        <>
          <h2 id="account-points-title" className="account-points__title">Your points</h2>
          {xp.status === "loading" && (
            <p className="account-card__note" role="status">Loading your XP{"\u2026"}</p>
          )}
          {xp.status === "error" && (
            <p className="account-card__note" role="alert">
              {xp.error ?? "Couldn't load your XP. Please try again."}{" "}
              <button type="button" className="inline-link" onClick={() => xp.retry()}>Retry</button>
            </p>
          )}
          {xp.status === "ready" && xp.state && (
            <>
              <p className="account-points__total">
                <strong>{total} XP</strong> {"\u00b7"} Level {level.level}: {level.name}
              </p>
              <div
                className="account-points__bar"
                role="progressbar"
                aria-label="Progress to the next level"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
                aria-valuetext={level.nextAt === null ? "Top level reached" : `${level.toNext} XP to the next level`}
              >
                <span className="account-points__fill" style={{ width: `${pct}%` }} />
              </div>
              <p className="account-card__note">
                {level.nextAt === null ? "You have reached the top level." : `${level.toNext} XP to the next level.`}
              </p>
              {awarded.length === 0 ? (
                <p className="account-card__note">No XP earned yet. Plan a trip to start earning points.</p>
              ) : (
                <ul className="account-points__list" aria-label="XP you have earned">
                  {awarded.map((e) => (
                    <li key={e}>
                      <span>{XP_EVENT_LABELS[e]}</span>
                      <span>+{XP_POINTS[e]} XP</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
      {!signedIn && (
        <p className="account-card__note" id="account-points-title">Sign in to earn XP</p>
      )}

      <details className="account-points__how">
      <summary className="account-points__summary">How points are calculated</summary>
      <ul className="account-points__list" aria-label="Points per action">
        {(Object.keys(XP_POINTS) as XpEvent[]).map((e) => (
          <li key={e}>
            <span>{XP_EVENT_LABELS[e]}</span>
            <span>+{XP_POINTS[e]} XP</span>
          </li>
        ))}
      </ul>
      <ul className="account-points__list" aria-label="Levels">
        {LEVEL_BANDS.map((b) => (
          <li key={b.level}>
            <span>Level {b.level}: {b.name}</span>
            <span>{b.min} XP</span>
          </li>
        ))}
      </ul>
      <p className="account-card__note">Each action counts once per trip or draft.</p>
      <p className="account-card__note">XP is earned only while signed in.</p>
      </details>
    </section>
  );
}

export default function AccountClient({ policy }: { policy: IdentityProviderPolicy }) {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  // Account storage probe: a signed-in GET /api/trips returns 503 when unavailable.
  const [storage, setStorage] = useState<"checking" | "ok" | "unavailable">("checking");
  const sync = useSyncStatus();

  useEffect(() => {
    let alive = true;
    void fetchSession().then((s) => {
      if (alive && !s.error) setUser(s.signedIn && s.user ? s.user : null);
      else if (alive) setUser((prev) => (prev === undefined ? null : prev));
    });
    const unsub = subscribeSession((s) => {
      setUser(s.signedIn && s.user ? s.user : null);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  const signedInEmail = user?.email;
  useEffect(() => {
    if (!signedInEmail) {
      setStorage("checking");
      return;
    }
    let alive = true;
    fetch("/api/trips", { method: "GET", credentials: "same-origin", cache: "no-store" })
      .then((res) => {
        if (alive) setStorage(res.status === 503 ? "unavailable" : "ok");
      })
      .catch(() => {
        if (alive) setStorage("ok");
      });
    return () => {
      alive = false;
    };
  }, [signedInEmail]);

  // Site assistant context: first name and signed-in state only (no email, no tokens).
  const assistantSignedIn = !!user;
  const assistantFirstName = user?.name?.trim().split(/\s+/)[0] ?? "";
  usePageAssistantContext({
    page: "account",
    slot: "profile",
    summary: assistantSignedIn
      ? assistantFirstName
        ? `Account page. Signed in as ${assistantFirstName}.`
        : "Account page. Signed in."
      : "Account page. The traveller is not signed in.",
    data: { signedIn: assistantSignedIn, ...(assistantFirstName ? { firstName: assistantFirstName } : {}) },
  });

  async function signOut() {
    await signOutAccount();
    setUser(null);
  }

  // Still resolving (first paint) or a guest - render the sign-in so SSR/CSR
  // agree. Guests are told plainly where their data lives.
  if (user === undefined || user === null) {
    return (
      <>
        <AuthLanding policy={policy} />
        {user === null && (
          <p className="account-card__note" role="note" style={{ textAlign: "center", padding: "var(--space-4, 16px)" }}>
            You are browsing as a guest. Your trips are saved on this device only. Sign in above to save them to an account.
            Sign in to earn XP. Guests do not earn or store XP.
          </p>
        )}
        {user === null && <AccountRecentTrips signedIn={false} />}
        {user === null && <AccountPoints signedIn={false} />}
      </>
    );
  }

  const unavailable = storage === "unavailable" || sync.state === "unavailable";
  const saveFailed = !unavailable && sync.state === "failed";

  const name = user.name?.trim() || user.email.split("@")[0] || "Explorer";

  let accountNote: string;
  if (unavailable) {
    accountNote = "Account sync is unavailable right now. Your trips stay on this device until it is back.";
  } else if (saveFailed) {
    accountNote = "We could not save your latest changes to your account. Use Retry in the status message.";
  } else if (storage === "ok") {
    accountNote = "Your trips, preferences and profile are saved to your account.";
  } else {
    accountNote = "Checking your account storage\u2026";
  }

  return (
    <main className="account-stage">
      <AccountHero
        eyebrow="Your account"
        title="Your next journey awaits"
        subtitle="Plan trips with live prices and AI itineraries."
        points={[
          "Live hotel & flight prices",
          "AI day-by-day itineraries",
          unavailable ? "Account sync is unavailable right now" : "Saved to your account when you are signed in",
        ]}
      />

      <div className="account-stage__panel">
        <section className="account-card account-card--rise" aria-label="Your account">
          <p className="account-card__eyebrow">Welcome back</p>
          <div className="account-card__head">
            <span className="account-card__avatar"><ExplorerAvatar /></span>
            <div className="account-card__id">
              <p className="account-card__name">{name}</p>
              <p className="account-card__email">Signed in as {user.email}</p>
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

          <AccountRecentTrips signedIn />

          <AccountPoints signedIn />

          <button type="button" className="cta account-card__signout" onClick={() => { void signOut(); }}>
            Sign out
          </button>
          <p className="account-card__note" role="note">{accountNote}</p>
          <p className="account-card__note">
            XP and level are saved to your account.{" "}
            <button type="button" className="inline-link" onClick={() => { void signOut().then(() => router.push("/account")); }}>
              Use a different account
            </button>
          </p>
        </section>
      </div>
    </main>
  );
}
