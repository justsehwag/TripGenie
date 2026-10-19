/**
 * Shared static route manifest for the Booking Site navigation and footer.
 *
 * This is a PLAIN, framework-free module (no "use client") so both the client
 * `Global_Navigation` component and the server `Site_Footer` component can
 * import these runtime values directly. Keeping the manifest here avoids the
 * client-reference proxy that Next.js substitutes when a server component
 * imports a value export from a `"use client"` module (which would turn
 * `NAV_LINKS` into a non-array proxy and break `NAV_LINKS.find(...)` at build
 * time during page-data collection).
 *
 * Every entry's `href` corresponds to an existing App Router route from the
 * design's Routing Map, so a navigation/footer control can never point at an
 * absent route (Req 21.3 / 29.2).
 */

export interface NavLink {
  label: string;
  href: string;
}

export const NAV_LINKS: readonly NavLink[] = [
  { label: "Stays", href: "/stays" },
  { label: "Flights", href: "/flights" },
  { label: "Cars", href: "/cars" },
  { label: "Deals", href: "/deals" },
  { label: "My Trips", href: "/trips" },
  { label: "AI Travel Assistant", href: "/plan" },
] as const;

/** The account landing route the sign-in control resolves to (Req 29.4). */
export const ACCOUNT_HREF = "/account";
