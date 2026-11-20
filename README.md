# Tripsaathi AI

An AI-concierge-first travel-planning app. Describe the trip you have in mind and Tripsaathi AI captures it into a live trip profile and builds a day-by-day plan.

Built with Next.js (App Router), React, and TypeScript, on a minimalist, illustration-led design system: white canvas, emerald/mint greens, and a single warm orange for primary actions.

## Features

- AI Travel Assistant: a two-pane conversational planner with a live "Your new trip" profile (route, dates, flights and class, who is joining, food and dietary, trip vibe, special needs), served at both / and /plan.
- Discover, Flights, Stays, and My Trips routes with a shared slim nav and light footer.
- Centralized design tokens mirrored 1:1 into CSS custom properties, enforced by a token-consistency test.
- Local SVG illustration library under public/illustrations.
- Provenance-honest: estimated/demo data is always labelled; no invented live availability or confirmed bookings.
- Responsive and accessible: single-column on mobile, 44px touch targets, reduced-motion-safe transitions.

## Getting started

Install dependencies and start the local server from this folder:

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

## Scripts

- `dev` - start the dev server (http://localhost:3000)
- `build` - production build
- `start` - serve the production build
- `typecheck` - type-check with tsc --noEmit
- `test` - run the Vitest suite
- `lint` - lint with next lint

## Project structure

```
app/          App Router routes (/, /plan, /flights, /stays, /trips, /account, ...) and globals.css
components/    UI components (concierge-home, global-nav, site-footer, offer cards, ...)
lib/          Framework-free core: design-system, route/date intake, pricing, itinerary, illustrations
public/       Static assets including the SVG illustration library
test/         Vitest suites (design-system, token consistency, responsive, nav, provenance)
```

## Itinerary grounding (SearXNG)

Itinerary generation can optionally be grounded with web search results from a self-hosted SearXNG instance. It is off by default. Set these variables (placeholders shown; never commit real values):

```
SEARXNG_BASE_URL=https://searxng.example.invalid
SEARXNG_SECRET_HEADER_NAME=<header-name>
SEARXNG_SECRET_HEADER_VALUE=<header-secret>
TRIPGENIE_SEARXNG_ENABLED=true
```

- `SEARXNG_BASE_URL` - must be https with no credentials (no user:password@). Redirects are refused, so use the canonical URL.
- `SEARXNG_SECRET_HEADER_NAME` / `SEARXNG_SECRET_HEADER_VALUE` - header sent with every request; both must be set or no header is sent.
- `TRIPGENIE_SEARXNG_ENABLED` - off unless the value is `true` or `1`. When off, or when search fails, itineraries are generated exactly as before.

These are server-only (no `NEXT_PUBLIC_` prefix). On Amplify, variables are inlined at build time, so changing the flag (or any value) needs a redeploy. On a self-hosted runtime a restart is enough.

See [docs/searxng/README.md](docs/searxng/README.md) for the deployment reference.

## Web-grounded pricing

Activity prices in the itinerary can optionally be backed by web evidence from the same self-hosted SearXNG instance. It is off by default. Placeholder values only; never commit real values:

```
SEARXNG_BASE_URL=https://search.example.com
TRIPGENIE_WEB_PRICING_ENABLED=true
```

- `TRIPGENIE_WEB_PRICING_ENABLED` - off unless the value is `true` or `1`. When off, or when search fails, prices come from the AI estimate or the category estimate exactly as before.
- Needs `SEARXNG_BASE_URL` (and the header settings above) to be configured. It is independent of `TRIPGENIE_SEARXNG_ENABLED`, so either feature can be on without the other.
- Runs only in `/api/activity-prices`, with at most 10 queries inside an 8 s budget.
- Entry fees are cached for 7 days and other prices for 24 h.
- Prices found this way are labelled "Web price" with the source host and the time checked. They are estimates, never shown as confirmed or bookable. A bus or train fare line, when shown, is informational and never added to totals.
- Server-only (no `NEXT_PUBLIC_` prefix). On Amplify, variables are inlined at build time, so changing the flag needs a redeploy.

## Notes

This is a demo/prototype. Travel data (flights, stays, prices) is estimated and clearly labelled - no real bookings are made and no payment is taken.
