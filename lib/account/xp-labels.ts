import type { XpEvent } from "../gamification";

/** Plain-text label for each XP event. The Record type makes a missing label a compile error. */
export const XP_EVENT_LABELS: Record<XpEvent, string> = {
  concierge_started: "Started a chat with the concierge",
  route_set: "Set your route",
  dates_set: "Set your travel dates",
  profile_completed: "Completed your travel profile",
  itinerary_generated: "Generated an itinerary",
  day_refined: "Refined a day of your itinerary",
  flight_selected: "Selected a flight",
  stay_selected: "Selected a stay",
  trip_confirmed: "Marked your trip as final",
  pdf_downloaded: "Downloaded your itinerary as a PDF",
};
