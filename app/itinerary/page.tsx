import Planner from "@/components/planner";

/**
 * Itinerary results page (/itinerary). The dedicated, meaningful destination for
 * a finished trip plan: the planner renders in results-only mode here, auto-
 * generating from the Shared_Trip_Context and showing ONLY the day-by-day plan
 * (no input composer). The /trip input page redirects here once a plan is ready,
 * so the plan opens on its own page instead of in-line on the same page.
 */
export const metadata = { title: "Your itinerary - TripGenie" };

export default function ItineraryPage() {
  return <Planner resultsOnly />;
}