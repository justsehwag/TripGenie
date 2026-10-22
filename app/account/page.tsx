import AccountClient from "@/components/account-client";
import type { IdentityProviderPolicy } from "@/lib/identity";

export const metadata = { title: "Account - TripGenie" };

/**
 * Account / sign-in route. AccountClient switches on the browser-local session:
 * a signed-in traveller sees a profile view (not the sign-in form again), while
 * an anonymous visitor sees the AuthLanding sign-in. Shows ONLY the account
 * surface - no profile/utility panels stacked below.
 */
const PROVIDER_POLICY: IdentityProviderPolicy = {
  enabledProviders: ["email", "google"],
};

export default function AccountPage() {
  return <AccountClient policy={PROVIDER_POLICY} />;
}