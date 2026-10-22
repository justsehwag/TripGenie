import DiscoverSights from "@/components/discover-sights";

export const metadata = { title: "Discover - TripGenie" };

/**
 * Discover route. A focused destination-discovery surface: search any city and
 * see six standout sights with live Wikipedia enrichment and curated fallback.
 * Previously this route re-rendered the entire homepage body (duplicate of /),
 * which produced repeated content; it now owns a single, purpose-built view.
 */
export default function DiscoverPage() {
  return <DiscoverSights />;
}