/**
 * Shared static route manifest for the Booking Site navigation and footer.
 *
 * This is a PLAIN, framework-free module (no "use client") so both the client
 * Global_Navigation component and the server Site_Footer component can import
 * these runtime values directly.
 *
 * Every entry's href corresponds to an existing App Router route, so a
 * navigation/footer control can never point at an absent route (Req 21.3 / 29.2).
 */

export interface NavLink {
  label: string;
  href: string;
}

export const NAV_LINKS: readonly NavLink[] = [
  { label: "AI Travel Assistant", href: "/plan" },
  { label: "Your Plan", href: "/itinerary" },
  { label: "Discover", href: "/discover" },
  { label: "Flights", href: "/flights" },
  { label: "Stays", href: "/stays" },
  { label: "My Trips", href: "/trips" },
] as const;

/** The account landing route the sign-in control resolves to (Req 29.4). */
export const ACCOUNT_HREF = "/account";

