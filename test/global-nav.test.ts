// Feature: ui-redesign, Property: Global Navigation contract (Req 4.2/4.3/4.5/4.7).
//
// Render test for components/global-nav.tsx (ui-redesign spec, task 7.2).
//
// Option A: GlobalNav is a "use client" component, but it renders cleanly to a
// static HTML string with react-dom/server's `renderToStaticMarkup` in the
// vitest "node" environment (no jsdom, no @testing-library required). The
// component exposes an `activeHref` prop as a test override so the live
// `usePathname` hook never needs a router; we additionally mock
// `next/navigation` so `usePathname` resolves to "/" if it is ever consulted.
//
// The assertions lock in the preserved navigation contracts:
//   - the nav is built from the NAV_LINKS manifest (every href + label present)
//   - active state is driven by the current route via `activeHref`
//     (aria-current="page" + is-active on the matching link only)
//   - the account entry is gated by the Identity_Provider policy
//     (shown when >=1 provider enabled, absent when none)
//   - sign-in renders as the orange Primary_Action (site-nav__account--signin)
//   - a profile control renders for an authenticated session
//   - interactive controls are keyboard-focusable (real <a>/<button> elements,
//     no tabindex="-1"), and the mobile toggle carries aria-expanded
//
// Validates: Requirements 4.2, 4.3, 4.5, 4.7.

import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import GlobalNav, { type GlobalNavProps } from "@/components/global-nav";
import { NAV_LINKS, ACCOUNT_HREF } from "@/lib/nav-links";
import type { IdentityProviderPolicy, IdentitySession } from "@/lib/identity";

// Safety net: if `usePathname` is ever reached (e.g. activeHref omitted), it
// resolves to a stable value instead of throwing for want of a router context.
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

/** Render GlobalNav to a static HTML string in the node environment. */
function render(props: GlobalNavProps): string {
  return renderToStaticMarkup(React.createElement(GlobalNav, props));
}

const ALL_PROVIDERS: IdentityProviderPolicy = {
  enabledProviders: ["email", "google"],
};
const NO_PROVIDERS: IdentityProviderPolicy = { enabledProviders: [] };

describe("Feature: ui-redesign, Global Navigation contract", () => {
  it("builds the nav from the NAV_LINKS manifest (Req 4.2)", () => {
    const html = render({ providerPolicy: ALL_PROVIDERS, session: null });

    for (const link of NAV_LINKS) {
      // Every manifest route is reachable from a rendered control...
      expect(html, `missing href ${link.href}`).toContain(`href="${link.href}"`);
      // ...and carries its human label.
      expect(html, `missing label ${link.label}`).toContain(link.label);
    }

    // No stray controls beyond the manifest: exactly one nav anchor per
    // NAV_LINKS entry. The trailing character class excludes the `site-nav__links`
    // <ul> container (whose class ends in "links", not "link" + quote/space).
    const linkItems = html.match(/site-nav__link["\s]/g) ?? [];
    expect(linkItems).toHaveLength(NAV_LINKS.length);
  });

  it("marks the active route via the current-route prop (Req 4.3)", () => {
    const html = render({
      providerPolicy: ALL_PROVIDERS,
      session: null,
      activeHref: "/stays",
    });

    // The active indicator is present at all.
    expect(html).toContain('aria-current="page"');

    // The Stays control specifically is the active one: its anchor carries both
    // the is-active class and aria-current="page".
    const stays = html.match(
      /<a[^>]*href="\/stays"[^>]*>/,
    );
    expect(stays, "Stays anchor not found").not.toBeNull();
    const staysTag = stays![0];
    expect(staysTag).toContain("is-active");
    expect(staysTag).toContain('aria-current="page"');

    // A different route (Flights) is NOT marked active.
    const flights = html.match(/<a[^>]*href="\/flights"[^>]*>/);
    expect(flights, "Flights anchor not found").not.toBeNull();
    expect(flights![0]).not.toContain("is-active");
    expect(flights![0]).not.toContain('aria-current="page"');
  });

  it("gates the account entry on the provider policy (Req 4.5)", () => {
    // At least one provider enabled -> an account control renders.
    const enabled = render({ providerPolicy: ALL_PROVIDERS, session: null });
    expect(enabled).toContain("site-nav__account");

    // No providers enabled -> no account control at all.
    const disabled = render({ providerPolicy: NO_PROVIDERS, session: null });
    expect(disabled).not.toContain("site-nav__account");
  });

  it("renders sign-in as the orange Primary_Action when anonymous (Req 4.5/4.7)", () => {
    const html = render({ providerPolicy: ALL_PROVIDERS, session: null });

    // The sign-in control is the orange Primary_Action variant...
    expect(html).toContain("site-nav__account--signin");
    expect(html).toContain("Sign in");
    // ...and it targets the account landing route.
    expect(html).toContain(`href="${ACCOUNT_HREF}"`);
    // Anonymous state shows no profile control.
    expect(html).not.toContain("site-nav__account--profile");
  });

  it("renders a profile control for an authenticated session (Req 4.5)", () => {
    const session: IdentitySession = { userId: "u1", firstName: "Sam" };
    const html = render({ providerPolicy: ALL_PROVIDERS, session });

    expect(html).toContain("site-nav__account--profile");
    expect(html).toContain("Hi, Sam");
    // An authenticated traveler is not offered the sign-in control.
    expect(html).not.toContain("site-nav__account--signin");
  });

  it("keeps interactive controls keyboard-focusable (Req 4.7)", () => {
    const html = render({ providerPolicy: ALL_PROVIDERS, session: null });

    // The nav is composed of natively focusable elements (anchors + a button),
    // none of which opt out of the tab order via tabindex="-1".
    expect(html).toContain("<a ");
    expect(html).toContain("<button");
    expect(html).not.toContain('tabindex="-1"');
    expect(html).not.toContain('tabIndex="-1"');

    // The mobile menu toggle exposes its expanded/collapsed state for AT.
    expect(html).toContain("aria-expanded");
  });
});
