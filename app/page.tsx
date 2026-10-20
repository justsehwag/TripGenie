import ConciergeHome from "@/components/concierge-home";
import Homepage from "@/components/homepage";

/**
 * Homepage route (Req 21). `/` now leads with the AI-concierge experience: a
 * server shell that renders the client `ConciergeHome` first (conversational
 * planner + Live_Trip_Profile), then the existing `Homepage` discovery/promo
 * sections below it (popular destinations, featured exploration, AI planner
 * promo, continue-exploring). Rendering both keeps every existing homepage
 * section and route reachable and preserves the Homepage search submits while
 * making the concierge the primary lead (Req 21.2, 21.8, 21.10).
 *
 * `Homepage` is rendered with `showHero={false}` so its own inline hero +
 * tabbed trip-finder is suppressed: the concierge is the sole lead hero
 * (Req 21.2), while Homepage's discovery/promo/continue-exploring sections stay
 * below it. The suppressed tab-search paths remain reachable via the
 * Global_Navigation links to /stays, /flights, /cars.
 *
 * The Global_Navigation and Site_Footer are rendered by app/layout.tsx, so they
 * appear here too; ConciergeHome pushes to `/plan?q=...` and Homepage keeps its
 * own validated search submits to the results routes.
 */
export const metadata = { title: "TripGenie - Plan your trip with AI" };

export default function Home() {
  return (
    <>
      <ConciergeHome />
      <Homepage showHero={false} />
    </>
  );
}
