# TripGenie AI

An AI-concierge-first travel-planning app. Describe the trip you have in mind and TripGenie captures it into a live trip profile and builds a day-by-day plan.

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

## Notes

This is a demo/prototype. Travel data (flights, stays, prices) is estimated and clearly labelled - no real bookings are made and no payment is taken.
