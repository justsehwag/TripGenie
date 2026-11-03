import DiscoverSights from "@/components/discover-sights";

/**
 * Homepage route. The landing experience is the Discover destination-search
 * surface (the previous AI-concierge home at `/` was removed in favor of this).
 * The AI Travel Assistant remains available at `/plan` via the Global_Navigation,
 * and all other routes are unchanged. Global_Navigation and Site_Footer are
 * rendered by app/layout.tsx.
 */
export const metadata = { title: "TripGenie - Discover your next place to wander" };

export default function Home() {
  return <DiscoverSights />;
}