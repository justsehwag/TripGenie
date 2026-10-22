import type { ReactNode } from "react";
import "./globals.css";
import GlobalNav from "@/components/global-nav";
import SiteFooter from "@/components/site-footer";
import { TripContextProvider } from "@/components/trip-context";
import type { IdentityProviderPolicy, IdentitySession } from "@/lib/identity";

/**
 * Font faces are supplied as CSS variables pointing at robust system fallback
 * stacks (no network webfont fetch), so the app renders reliably offline/in
 * restricted networks. The token values in app/globals.css reference
 * --font-display-face / --font-body-face, and lib/design-system.ts mirrors the
 * identical fallback strings, so the task-4 token<->CSS bijection stays intact.
 */
const FONT_FACE_VARS = {
  "--font-display-face": "Georgia, 'Times New Roman', serif",
  "--font-body-face": "system-ui, -apple-system, 'Segoe UI', sans-serif",
} as React.CSSProperties;

export const metadata = {
  title: "TripGenie",
  description: "AWS-native agentic travel-planning concierge.",
};

const PROVIDER_POLICY: IdentityProviderPolicy = {
  enabledProviders: ["email", "google"],
};

const SESSION: IdentitySession | null = null;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" style={FONT_FACE_VARS}>
      <body>
        <GlobalNav providerPolicy={PROVIDER_POLICY} session={SESSION} />
        <TripContextProvider>{children}</TripContextProvider>
        <SiteFooter providerPolicy={PROVIDER_POLICY} session={SESSION} />
      </body>
    </html>
  );
}

