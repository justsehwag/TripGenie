/**
 * TripGenie real-time chat shared contracts.
 *
 * Shared, framework-free TYPES ONLY for the streaming chat feature. This module
 * is imported by BOTH server code (`app/api/ai/chat/route.ts`, `lib/chat-prompt.ts`)
 * and client code (`components/use-chat-stream.ts` and the surfaces that call it),
 * so it MUST stay free of any runtime server-only imports (no bedrock, serpapi, or
 * config). Only type-only imports from the domain contracts are used here.
 *
 * `TripContext`, `Provenance`, `Itinerary`, and `TripDay` are reused verbatim from
 * `lib/types.ts` (no change to that module) so the route and prompt builder share a
 * single definition without introducing a client -> server dependency.
 *
 * Design: Components §1, Data Models (`lib/chat-types.ts`).
 * Requirements: 6.3, 2.1, 2.2.
 */

import type { Itinerary, Provenance, TripContext, TripDay } from "@/lib/types";

/* ---------------------------------------------------------------------------
 * GroundingSummary — a non-secret, bounded mirror of data already visible in
 * the UI (stays, flights, places, current itinerary). Every field is optional;
 * each stay/flight carries its `Provenance` so the assistant can label estimates
 * honestly. Nothing here is server-only or secret.
 * ------------------------------------------------------------------------- */
export interface GroundingSummary {
  /** Representative stays mirrored from the Live-prices section. */
  stays?: {
    name: string;
    ratePerNight: number;
    provenance: Provenance;
  }[];
  /** Representative flight offers mirrored from the Live-prices section. */
  flights?: {
    label: string;
    farePerPerson: number;
    stops: number;
    provenance: Provenance;
  }[];
  /** Place names (and optional category) mirrored from the itinerary/discovery. */
  places?: {
    name: string;
    category?: string;
  }[];
  /** A bounded summary of the current itinerary (day titles + totals). */
  itinerary?: {
    title: string;
    dayCount: number;
    totalCost: number;
    days: {
      day: number;
      title: string;
      total: number;
    }[];
  };
}

/* ---------------------------------------------------------------------------
 * ChatRequestBody — the request payload POSTed to `app/api/ai/chat/route.ts`.
 * Traveller text travels as DATA inside `messages[]`, never concatenated into
 * the server-assembled system prompt. `surface` distinguishes the `/plan`
 * concierge from the `/trip` planner.
 * ------------------------------------------------------------------------- */
export interface ChatRequestBody {
  messages: {
    role: "user" | "assistant";
    text: string;
  }[];
  context: TripContext;
  grounding?: GroundingSummary;
  surface: "concierge" | "trip";
}

/* Re-export the reused domain contracts so downstream chat modules can import a
 * single surface. These are type-only re-exports (no runtime cost). */
export type { Itinerary, Provenance, TripContext, TripDay };
