import type { ReactNode } from "react";
import "./globals.css";
import GlobalNav from "@/components/global-nav";
import SiteFooter from "@/components/site-footer";
import type { IdentityProviderPolicy, IdentitySession } from "@/lib/identity";

export const metadata = {
  title: "TripGenie",
  description: "AWS-native agentic travel-planning concierge.",
};

/**
 * Enabled Identity_Provider policy for the Booking_Site chrome (Req 1 / 29.5).
 * The hosted-UI's native email sign-in is always available; social providers
 * are added here only when the deployment enables them. The navigation and
 * footer render the account entry only while this policy enables a provider.
 */
const PROVIDER_POLICY: IdentityProviderPolicy = {
  enabledProviders: ["email", "google"],
};

/**
 * The root layout renders Global_Navigation above {children} and Site_Footer
 * below it exactly once, so both appear on every Booking_Site page
 * (Req 21.1, 29.1). The session is resolved client-side from browser-local
 * identity in later tasks; at the layout level it starts anonymous (null),
 * which drives the sign-in control (Req 21.4 / 29.4).
 */
const SESSION: IdentitySession | null = null;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <GlobalNav providerPolicy={PROVIDER_POLICY} session={SESSION} />
        {children}
        <SiteFooter providerPolicy={PROVIDER_POLICY} session={SESSION} />
      </body>
    </html>
  );
}
