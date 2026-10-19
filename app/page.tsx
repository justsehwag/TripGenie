import Homepage from "@/components/homepage";

/**
 * Homepage route (Req 22). `/` is the Hopper-style booking entry point: a server
 * shell that renders the client `Homepage` (Stays/Flights/Cars tabs, destination
 * discovery, sign-in promo, AI planning prompt, popular destinations, and a
 * continue-exploring section). The Global_Navigation and Site_Footer are
 * rendered by app/layout.tsx, so they appear here too (Req 22.11).
 */
export const metadata = { title: "TripGenie - Plan, search, and book" };

export default function Home() {
  return <Homepage />;
}
