import type { ReactNode } from "react";
import { DM_Serif_Display, Inter } from "next/font/google";
import "./globals.css";
import GlobalNav from "@/components/global-nav";
import SiteFooter from "@/components/site-footer";
import type { IdentityProviderPolicy, IdentitySession } from "@/lib/identity";

/**
 * Serif DISPLAY face (headings) and sans BODY face (everything else) loaded via
 * next/font so there is no layout shift and a graceful system fallback while the
 * webfont loads (Req 3.1, 3.6). DM Serif Display ships weight 400 only.
 *
 * Each face exposes its OWN CSS variable (`--font-display-face` /
 * `--font-body-face`) — deliberately NOT the token custom properties
 * `--font-display` / `--font-body`. The token values in app/globals.css
 * reference these face variables with the TYPOGRAPHY_FACES fallback stack
 * appended, and lib/design-system.ts TYPOGRAPHY_FACES.*.fallback mirrors the
 * identical string, so the loaded faces apply while the task-4 token↔CSS
 * bijection stays intact.
 */
const dmSerifDisplay = DM_Serif_Display({
  subsets: ["latin"],
  weight: "400",
  display: "swap",
  variable: "--font-display-face",
  fallback: ["Georgia", "Times New Roman", "serif"],
});

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
  variable: "--font-body-face",
  fallback: ["system-ui", "-apple-system", "Segoe UI", "sans-serif"],
});

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
    <html lang="en" className={`${dmSerifDisplay.variable} ${inter.variable}`}>
      <body>
        <GlobalNav providerPolicy={PROVIDER_POLICY} session={SESSION} />
        {children}
        <SiteFooter providerPolicy={PROVIDER_POLICY} session={SESSION} />
      </body>
    </html>
  );
}
