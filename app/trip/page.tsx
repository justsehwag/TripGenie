import Planner from "@/components/planner";

/**
 * Trip plan route (/trip): renders the day-by-day itinerary generated from the
 * Shared_Trip_Context the concierge captured. The concierge redirects here once
 * the trip profile is complete.
 */
export const metadata = { title: "Your trip plan - TripGenie" };

export default function TripPage() {
  return <Planner />;
}

