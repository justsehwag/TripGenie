import MyTripsClient from "@/components/my-trips-client";
import type { IdentityProviderPolicy } from "@/lib/identity";

/**
 * My Trips route (Req 27) — design section "Booking Site … → My_Trips_Page
 * (Req 27)".
 *
 * This is a thin server shell. The page binds to the account trips API at
 * `/api/trips`, which derives the owner from the server session cookie. All
 * interactivity — resolving the signed-in vs anonymous session from the server,
 * loading the account's trips (the account keeps the newest 20; the device-only
 * guest store keeps the newest 5), and the view/edit/delete/resume actions —
 * lives in the client component `MyTripsClient`, because those actions call the
 * trips endpoints from the browser.
 *
 * The Global_Navigation and Site_Footer are rendered once by `app/layout.tsx`,
 * so they appear here too (Req 27.9) — this page deliberately adds no footer.
 *
 * The enabled Identity_Provider policy is passed through so the anonymous
 * sign-in prompt is presented consistently with Requirement 1 / 29.5. It mirrors
 * the policy the layout chrome uses; a deployment enabling other providers would
 * surface them here identically.
 *
 * Requirements: 27.1, 27.2, 27.3, 27.4, 27.5, 27.6, 27.7, 27.8, 27.9.
 */

export const metadata = { title: "My Trips — Tripsaathi AI" };

// Trips are user-scoped and must never be shared or cached across callers; the
// data itself is fetched client-side from the private, no-store trips API.
export const dynamic = "force-dynamic";

/**
 * Enabled Identity_Provider policy for the sign-in prompt (Req 1 / 29.5),
 * mirroring the layout chrome. The native email sign-in is always available;
 * social providers are listed only when the deployment enables them.
 */
const PROVIDER_POLICY: IdentityProviderPolicy = {
  enabledProviders: ["email", "google"],
};

export default function TripsPage() {
  return <MyTripsClient providerPolicy={PROVIDER_POLICY} />;
}
