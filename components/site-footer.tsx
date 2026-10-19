/**
 * Site_Footer (Group C / Task 32.1) - design section
 * "Booking Site (Hopper-style Multi-page Experience) -> Site_Footer (Req 29)".
 *
 * Rendered once in the root `app/layout.tsx` so it appears on every Booking_Site
 * page (Req 29.1). It presents grouped informational link sections and the
 * TripGenie brand identity (Req 29.1); every link resolves to an existing route
 * (built from the same static route manifest the navigation uses) or an explicit
 * external resource, so no link is a dead end (Req 29.2).
 *
 * It carries the provenance disclosure stating offers are estimated and take no
 * payment and issue no valid ticket, room, or rental (Req 29.3, consistent with
 * Req 4.11). Its sign-in control routes anonymous travelers to the account
 * landing page `/account` (Req 29.4), presented consistently with the enabled
 * Identity_Provider policy (Req 29.5) - omitted entirely when no provider is
 * enabled. The footer uses the editorial palette/typography tokens from
 * `app/globals.css`, distinct from the TripSaathi interface (Req 29.6).
 *
 * This is a presentational (server) component - no client interactivity is
 * required, so it is deliberately not a client component.
 *
 * Requirements: 29.1, 29.2, 29.3, 29.4, 29.5, 29.6.
 */

import Link from "next/link";
import {
  landingControls,
  type IdentityProviderPolicy,
  type IdentitySession,
} from "@/lib/identity";
import { NAV_LINKS, ACCOUNT_HREF, type NavLink } from "@/lib/nav-links";

export interface FooterSection {
  heading: string;
  links: NavLink[];
}

/**
 * Grouped informational link sections (Req 29.1). Every `href` targets an
 * existing route from the shared manifest (`NAV_LINKS` / `ACCOUNT_HREF`) so no
 * footer link is dead (Req 29.2).
 */
function byLabel(label: string): NavLink {
  const found = NAV_LINKS.find((l) => l.label === label);
  // The manifest is static and these labels are known-present; fall back to the
  // Homepage rather than ever emitting an absent target.
  return found ?? { label, href: "/" };
}

export const FOOTER_SECTIONS: readonly FooterSection[] = [
  {
    heading: "Book",
    links: [byLabel("Stays"), byLabel("Flights"), byLabel("Cars")],
  },
  {
    heading: "Explore",
    links: [byLabel("Deals"), byLabel("AI Travel Assistant")],
  },
  {
    heading: "Your trips",
    links: [byLabel("My Trips"), { label: "Account", href: ACCOUNT_HREF }],
  },
] as const;

/** The estimated / no-payment provenance disclosure text (Req 29.3, 4.11). */
export const PROVENANCE_DISCLOSURE =
  "Offers shown on TripGenie are estimated. We take no payment and issue no valid ticket, room, or rental.";

export interface SiteFooterProps {
  /** Enabled-provider policy, reused from Req 1; drives the account control (Req 29.5). */
  providerPolicy: IdentityProviderPolicy;
  /** Current session, if any. Anonymous -> sign-in control; authenticated -> account control (Req 29.4). */
  session?: IdentitySession | null;
}

export default function SiteFooter({
  providerPolicy,
  session = null,
}: SiteFooterProps) {
  // The account entry is presented only when the policy enables a provider (Req 29.5).
  const accountEnabled = landingControls(providerPolicy).length > 0;
  const authed = Boolean(session?.userId);

  return (
    <footer className="site-footer">
      <div className="shell site-footer__inner">
        <div className="site-footer__brand">
          <p className="site-footer__wordmark">TripGenie</p>
          <p className="site-footer__tagline">
            An AWS-native agentic travel-planning concierge.
          </p>

          {accountEnabled && (
            <Link
              href={ACCOUNT_HREF}
              className="site-footer__account"
            >
              {authed
                ? session?.firstName
                  ? `Manage ${session.firstName}'s account`
                  : "Manage your account"
                : "Sign in"}
            </Link>
          )}
        </div>

        <nav className="site-footer__sections" aria-label="Footer">
          {FOOTER_SECTIONS.map((section) => (
            <section key={section.heading} className="site-footer__section">
              <h2 className="site-footer__heading">{section.heading}</h2>
              <ul className="site-footer__links">
                {section.links.map((link) => (
                  <li key={link.href + link.label}>
                    <Link href={link.href} className="site-footer__link">
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </nav>
      </div>

      <div className="shell site-footer__disclosure">
        <p role="note">{PROVENANCE_DISCLOSURE}</p>
      </div>
    </footer>
  );
}
