import DiscoverSights from "@/components/discover-sights";

export const metadata = { title: "Discover sights - TripGenie" };

/**
 * Sights / Discover route. Surfaces six destination-restricted standout places
 * with live Wikipedia enrichment and curated fallback (TripGenie parity with
 * TripSaathi's six-sights Discover surface, FR-13 / FR-17).
 */
export default function SightsPage() {
  return <DiscoverSights />;
}