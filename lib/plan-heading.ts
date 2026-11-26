/**
 * Pure heading logic for the planner header.
 *
 * On the results-only view (`/plan`), an idle planner must not claim it is
 * building a trip. "Building your trip plan…" is shown only while generating.
 */

export interface PlanHeadingInput {
  resultsOnly: boolean;
  generating: boolean;
  itineraryTitle: string | null;
}

export interface PlanHeading {
  eyebrow: string | null;
  title: string;
  showLead: boolean;
}

export function planHeading(i: PlanHeadingInput): PlanHeading {
  if (!i.resultsOnly) {
    return { eyebrow: "AI travel assistant", title: "Plan your trip, together", showLead: true };
  }
  if (i.itineraryTitle) {
    return { eyebrow: "Your itinerary", title: i.itineraryTitle, showLead: true };
  }
  if (i.generating) {
    return { eyebrow: "Your itinerary", title: "Building your trip plan…", showLead: true };
  }
  return { eyebrow: null, title: "Your plan", showLead: false };
}
