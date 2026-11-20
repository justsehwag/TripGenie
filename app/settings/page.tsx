import SettingsClient from "@/components/settings-client";

export const metadata = { title: "Settings - Tripsaathi AI" };

/**
 * Settings route. A select-only preferences form (country + travel fields),
 * saved browser-local so it works for guests and signed-in travellers alike.
 */
export default function SettingsPage() {
  return <SettingsClient />;
}
