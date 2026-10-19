import AuthLanding from "@/components/auth-landing";
import type { IdentityProviderPolicy } from "@/lib/identity";

export const metadata = { title: "Account - TripGenie" };

/**
 * Account landing route (Req 1). The Global_Navigation and Site_Footer sign-in
 * controls route here (Req 29.4), so their targets resolve to an existing route
 * and are never dead links (Req 21.3 / 29.2). The page mounts the already-built
 * `AuthLanding` (Task 29.1), which derives its controls entirely from the
 * enabled Identity_Provider policy (Req 1.1 / 1.7 / 29.5).
 */
const PROVIDER_POLICY: IdentityProviderPolicy = {
  enabledProviders: ["email", "google"],
};

export default function AccountPage() {
  return <AuthLanding policy={PROVIDER_POLICY} />;
}
