"use client";

/**
 * First-visit welcome gate for `/` only.
 *
 * Server render keeps the children (Discover) in the HTML inside a `hidden`
 * div with a loading status. On mount it reads the seen flag, asks the server
 * who is signed in and applies `decideWelcome`. A signed-in session event
 * (for example email sign-in, which does not remount the gate) also marks the
 * flag and reveals the children. Showing the welcome page does not set the
 * flag; choosing guest mode or signing in does.
 */

import { useEffect, useState, type ReactNode } from "react";
import AuthLanding from "@/components/auth-landing";
import { fetchSession, subscribeSession } from "@/lib/client/account-session";
import type { IdentityProviderPolicy } from "@/lib/identity";
import { WELCOME_CHROME_ATTR, hidesChrome } from "@/lib/welcome-chrome";
import {
  GUEST_LIMIT_LINES,
  decideWelcome,
  markWelcomeSeen,
  readWelcomeSeen,
} from "@/lib/welcome-gate";

const PROVIDER_POLICY: IdentityProviderPolicy = {
  enabledProviders: ["email", "google"],
};

type View = "pending" | "welcome" | "app";

export function WelcomeGate({ children }: { children: ReactNode }) {
  const [view, setView] = useState<View>("pending");

  // Hide global chrome only while pending/welcome; cleared on app and unmount.
  useEffect(() => {
    const root = document.documentElement;
    if (hidesChrome(view)) root.setAttribute(WELCOME_CHROME_ATTR, "1");
    else root.removeAttribute(WELCOME_CHROME_ATTR);
    return () => root.removeAttribute(WELCOME_CHROME_ATTR);
  }, [view]);

  useEffect(() => {
    let cancelled = false;
    const { seen, storageOk } = readWelcomeSeen();

    const apply = (session: "signed-in" | "guest" | "error") => {
      if (cancelled) return;
      const d = decideWelcome({ seen, storageOk, session });
      if (d.markSeen) markWelcomeSeen();
      setView(d.view);
    };

    if (!storageOk || seen) {
      setView("app");
      return () => {
        cancelled = true;
      };
    }

    const unsubscribe = subscribeSession((s) => {
      if (cancelled || !s.signedIn) return;
      apply("signed-in");
    });

    fetchSession()
      .then((s) => apply(s.signedIn ? "signed-in" : "guest"))
      .catch(() => apply("error"));

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  function continueAsGuest() {
    markWelcomeSeen();
    setView("app");
  }

  if (view === "welcome") {
    return (
      <AuthLanding
        policy={PROVIDER_POLICY}
        afterSignInPath="/"
        heading="Welcome to Tripsaathi AI"
        subheading="Sign in to save trips to your account, or continue as a guest."
        onContinueAsGuest={continueAsGuest}
        footerNote={
          <ul className="welcome-note" aria-label="Guest limits">
            {GUEST_LIMIT_LINES.map((line) => (
              <li key={line} className="welcome-note__item">
                {line}
              </li>
            ))}
          </ul>
        }
      />
    );
  }

  if (view === "app") return <>{children}</>;

  return (
    <>
      <div hidden>{children}</div>
      <p role="status">Loading…</p>
    </>
  );
}

export default WelcomeGate;
