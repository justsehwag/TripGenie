"use client";

/**
 * Global_Navigation (Group C / Task 32.1) - design section
 * "Booking Site (Hopper-style Multi-page Experience) -> Global_Navigation (Req 21)".
 *
 * Renders once in the root `app/layout.tsx` so it appears on every Booking_Site
 * page (Req 21.1). A logo links to the Homepage `/`; navigation controls cover
 * Discover, Flights, Stays, My Trips, and the AI Travel Assistant (which
 * targets the Planning_Workspace `/plan`, Req 21.5). Every control is built from
 * the shared static route manifest in `@/lib/nav-links`, so no control ever
 * targets an absent route (Req 21.3). The active page is indicated from the current route via
 * `usePathname` and `aria-current="page"` (Req 21.7).
 *
 * A sign-in control shows when the traveler is anonymous and a profile control
 * shows when authenticated (Req 21.4 / Task 29.2); the sign-in control routes to
 * the account landing page `/account` (Req 29.4). The account-entry control is
 * presented consistently with the enabled Identity_Provider policy (Req 29.5) -
 * it is only shown when at least one provider is enabled.
 *
 * Below 768px the full control row collapses to a compact menu toggle that
 * expands/collapses the controls and collapses again on selection or dismissal
 * (Req 21.6); the toggle carries `aria-expanded`. Controls are keyboard-reachable
 * with a visible focus indicator via the editorial focus-ring token (Req 21.8).
 *
 * Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 21.8, 29.2, 29.4, 29.5.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  landingControls,
  type IdentityProviderPolicy,
  type IdentitySession,
} from "@/lib/identity";
import { NAV_LINKS, ACCOUNT_HREF } from "@/lib/nav-links";

export interface GlobalNavProps {
  /** Enabled-provider policy, reused from Req 1; drives whether an account control shows (Req 29.5). */
  providerPolicy: IdentityProviderPolicy;
  /** Current session, if any. Anonymous -> sign-in control; authenticated -> profile control (Req 21.4). */
  session?: IdentitySession | null;
  /**
   * Optional override of the active route (defaults to the live `usePathname`).
   * Injected by tests so active-state can be asserted without a router.
   */
  activeHref?: string;
}

/** True iff `current` is `href` or a nested child of it (so detail pages stay active). */
function isActive(href: string, current: string): boolean {
  if (href === "/") return current === "/";
  return current === href || current.startsWith(href + "/");
}

export default function GlobalNav({
  providerPolicy,
  session = null,
  activeHref,
}: GlobalNavProps) {
  const pathname = usePathname();
  const current = activeHref ?? pathname ?? "/";

  // Mobile compact menu state (Req 21.6). Collapsed by default.
  const [menuOpen, setMenuOpen] = useState(false);

  // Collapse the compact menu whenever the route changes (selection/dismissal).
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  // The account entry is only presented when the provider policy enables at
  // least one provider (Req 29.5) - otherwise there is no sign-in path to offer.
  const accountEnabled = landingControls(providerPolicy).length > 0;
  const authed = Boolean(session?.userId);

  return (
    <header className="site-nav">
      <nav className="site-nav__bar shell" aria-label="Primary">
        <Link href="/" className="site-nav__logo" aria-label="TripGenie home">
          {/*
            Logo treatment (Req 4.1 / 17.6): a small inline SVG mark — a globe
            circle in the primary green with a journey arc / paper-plane accent
            in deep emerald and a single orange action spark — paired with the
            "TripGenie" wordmark. The mark is decorative (aria-hidden); the
            wordmark + the link's aria-label convey the name. Colors reference
            the Design_System token custom properties directly (no CSS added
            here), so a token change propagates to the mark.
          */}
          <svg
            className="site-nav__mark"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            focusable="false"
          >
            {/* Globe body */}
            <circle cx="12" cy="12" r="9" stroke="var(--color-primary-green)" strokeWidth="1.8" />
            {/* Meridian suggesting travel around the globe */}
            <path
              d="M12 3c3 2.4 3 15.6 0 18M12 3c-3 2.4-3 15.6 0 18M3.4 9h17.2M3.4 15h17.2"
              stroke="var(--color-primary-green)"
              strokeWidth="1.2"
              strokeLinecap="round"
              opacity="0.55"
            />
            {/* Paper-plane / journey mark in deep emerald */}
            <path
              d="M7 13.2l9.4-4.4-3 9.2-2.1-3.1-4.3-1.7z"
              fill="var(--color-deep-emerald)"
            />
            {/* Orange action spark accent */}
            <circle cx="17.6" cy="6.6" r="2" fill="var(--color-action-orange)" />
          </svg>
          <span className="site-nav__wordmark">TripGenie</span>
        </Link>

        {/* Compact menu toggle, shown only below 768px via CSS (Req 21.6). */}
        <button
          type="button"
          className="site-nav__toggle"
          aria-expanded={menuOpen}
          aria-controls="site-nav-controls"
          aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span aria-hidden="true">{menuOpen ? "\u2715" : "\u2630"}</span>
        </button>

        <div
          id="site-nav-controls"
          className={`site-nav__controls${menuOpen ? " is-open" : ""}`}
        >
          <ul className="site-nav__links">
            {NAV_LINKS.map((link) => {
              const active = isActive(link.href, current);
              return (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className={`site-nav__link${active ? " is-active" : ""}`}
                    aria-current={active ? "page" : undefined}
                    onClick={() => setMenuOpen(false)}
                  >
                    {link.label}
                  </Link>
                </li>
              );
            })}
          </ul>

          {accountEnabled &&
            (authed ? (
              <Link
                href={ACCOUNT_HREF}
                className="site-nav__account site-nav__account--profile"
                aria-current={isActive(ACCOUNT_HREF, current) ? "page" : undefined}
                onClick={() => setMenuOpen(false)}
              >
                <span aria-hidden="true">{"\u25CF"}</span>
                {session?.firstName ? `Hi, ${session.firstName}` : "My account"}
              </Link>
            ) : (
              <Link
                href={ACCOUNT_HREF}
                className="site-nav__account site-nav__account--signin"
                onClick={() => setMenuOpen(false)}
              >
                Sign in
              </Link>
            ))}
        </div>
      </nav>
    </header>
  );
}
