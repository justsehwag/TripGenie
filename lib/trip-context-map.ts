/**
 * Shared_Trip_Context ⇄ Search_Criteria pure mappers (realtime-ai-integration
 * spec, task 4.1 — design section "Shared_Trip_Context → pure mappers").
 *
 * These helpers project the canonical `TripContext` (`lib/types.ts`) onto the
 * per-category `SearchCriteria` discriminated union (`lib/search-criteria.ts`)
 * and fold a parsed criteria back into shared-context fields. They are pure and
 * framework-free: no React/Next imports, no runtime dependency, no I/O.
 *
 * Two invariants are binding (and property-tested in `test/trip-context-map.ts`):
 *
 *   1. Round-trip (Req 4.2/4.3/4.5): for any context + hints and any category,
 *      `parseCriteria(cat, serializeCriteria(toXCriteria(ctx, hints)))`
 *      deep-equals `toXCriteria(ctx, hints)`. To guarantee this, every value a
 *      `toXCriteria` emits MUST be exactly what `parseCriteria` reconstructs —
 *      so absent fields use the SAME documented defaults/empties `parseCriteria`
 *      applies (`""` for strings; 1 for guests/rooms/travellers; 18 for driver
 *      age; `"economy"` cabin; `"round-trip"` trip type) and optional fields
 *      honor the union's presence rules.
 *
 *   2. No fabrication (Req 4.6): a shared-context field the traveler did not
 *      supply maps to the documented default/empty value — never an invented
 *      one. Dates come ONLY from the caller-supplied `DateHints`; an absent hint
 *      becomes `""` (the same value `parseCriteria` yields for a missing date).
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6.
 */

import type { TripContext } from "./types";
import type {
  SearchCriteria,
  StaysCriteria,
  FlightsCriteria,
  CarsCriteria,
} from "./search-criteria";

// ---------------------------------------------------------------------------
// Documented defaults — kept byte-identical to `lib/search-criteria.ts`.
//
// Those constants are module-private there, so they are mirrored here. If the
// parser's defaults ever change, these MUST change in lockstep — the round-trip
// property test is the tripwire that proves they still agree.
// ---------------------------------------------------------------------------

const DEFAULT_GUESTS = 1;
const DEFAULT_ROOMS = 1;
const DEFAULT_TRAVELLERS = 1;
const DEFAULT_DRIVER_AGE = 18;
const DEFAULT_CABIN = "economy";
const DEFAULT_TRIP_TYPE = "round-trip" as const;

/** Empty string — the value `parseCriteria` yields for any missing string param. */
const EMPTY = "";

// ---------------------------------------------------------------------------
// DateHints — ISO date/time strings the CALLER supplies.
//
// The mapper never invents a date/time; it only forwards hints. An absent hint
// collapses to `""` so the emitted criteria match a missing-param parse exactly.
// ---------------------------------------------------------------------------

export interface DateHints {
  /** Stays check-in (ISO date `YYYY-MM-DD`). */
  checkIn?: string;
  /** Stays check-out (ISO date `YYYY-MM-DD`). */
  checkOut?: string;
  /** Flights departure (ISO date `YYYY-MM-DD`). */
  departDate?: string;
  /** Flights return (ISO date); only honored for a round-trip. */
  returnDate?: string;
  /** Cars pickup date (ISO date `YYYY-MM-DD`). */
  pickupDate?: string;
  /** Cars pickup time (ISO time `HH:MM`). */
  pickupTime?: string;
  /** Cars return time (ISO time `HH:MM`). */
  returnTime?: string;
}

// ---------------------------------------------------------------------------
// Travellers collapse — `{ adults, children }` → a single positive integer.
// ---------------------------------------------------------------------------

/**
 * Collapse `TripContext.travellers` to one integer `adults + children`, clamped
 * to a minimum of 1. An absent `travellers` block (traveler gave no count) uses
 * the documented default of 1 — never an invented party size. Deterministic:
 * the same context always yields the same integer.
 */
function collapseTravellers(context: TripContext): number {
  const party = context.travellers;
  if (!party) return DEFAULT_TRAVELLERS;
  const adults = Number.isFinite(party.adults) ? party.adults : 0;
  const children = Number.isFinite(party.children) ? party.children : 0;
  const total = Math.trunc(adults) + Math.trunc(children);
  return total >= 1 ? total : DEFAULT_TRAVELLERS;
}

/** Forward a date/time hint, or the empty default when the caller omitted it. */
function hintOr(value: string | undefined): string {
  return value === undefined ? EMPTY : value;
}

/** Map a shared-context destination/origin string to its criteria value. */
function placeOr(value: string | undefined): string {
  return value === undefined ? EMPTY : value;
}

// ---------------------------------------------------------------------------
// toStaysCriteria — TripContext (+ hints) → StaysCriteria
// ---------------------------------------------------------------------------

/**
 * `destination` ← `context.destination` (else `""`); dates ← hints (else `""`);
 * `guests` ← collapsed travellers (min 1); `rooms` ← default 1 (no shared-context
 * field maps to rooms, so it stays the documented default — never invented).
 */
export function toStaysCriteria(context: TripContext, hints: DateHints = {}): StaysCriteria {
  return {
    category: "stays",
    destination: placeOr(context.destination),
    checkIn: hintOr(hints.checkIn),
    checkOut: hintOr(hints.checkOut),
    guests: collapseTravellers(context),
    rooms: DEFAULT_ROOMS,
  };
}

// ---------------------------------------------------------------------------
// toFlightsCriteria — TripContext (+ hints) → FlightsCriteria
// ---------------------------------------------------------------------------

/**
 * `origin`/`destination` ← context (else `""`); `departDate` ← hint (else `""`);
 * `travellers` ← collapsed travellers (min 1); `cabin` ← default `"economy"`;
 * `tripType` ← default `"round-trip"` (no shared-context field maps to trip type).
 *
 * Presence rule (mirrors the union + `parseCriteria`): `returnDate` is set ONLY
 * for a round-trip. `parseCriteria` always materializes `returnDate` for a
 * round-trip (defaulting a missing param to `""`), so the mapper sets it to the
 * hint value or `""` — keeping the round-trip exact. A one-way trip omits it.
 */
export function toFlightsCriteria(context: TripContext, hints: DateHints = {}): FlightsCriteria {
  const criteria: FlightsCriteria = {
    category: "flights",
    tripType: DEFAULT_TRIP_TYPE,
    origin: placeOr(context.origin),
    destination: placeOr(context.destination),
    departDate: hintOr(hints.departDate),
    travellers: collapseTravellers(context),
    cabin: DEFAULT_CABIN,
  };
  // Default trip type is round-trip, so `returnDate` is always present here and
  // mirrors what `parseCriteria` reconstructs for a round-trip serialization.
  if (criteria.tripType === "round-trip") {
    criteria.returnDate = hintOr(hints.returnDate);
  }
  return criteria;
}

// ---------------------------------------------------------------------------
// toCarsCriteria — TripContext (+ hints) → CarsCriteria
// ---------------------------------------------------------------------------

/**
 * `pickupLocation` ← `context.destination` (else `""`); date/time fields ← hints
 * (else `""`); `driverAge` ← default 18 (no shared-context field maps to it).
 *
 * Presence rule: `dropoffLocation` is set ONLY when meaningfully different from
 * the pickup. The shared context carries no distinct drop-off, so it is omitted
 * entirely — matching `parseCriteria`, which only materializes the field when
 * the param is present. Omitting (not defaulting) keeps both the round-trip and
 * the no-fabrication invariants intact.
 */
export function toCarsCriteria(context: TripContext, hints: DateHints = {}): CarsCriteria {
  return {
    category: "cars",
    pickupLocation: placeOr(context.destination),
    pickupDate: hintOr(hints.pickupDate),
    pickupTime: hintOr(hints.pickupTime),
    returnDate: hintOr(hints.returnDate),
    returnTime: hintOr(hints.returnTime),
    driverAge: DEFAULT_DRIVER_AGE,
    // `dropoffLocation` intentionally omitted — no distinct drop-off in context.
  };
}

// ---------------------------------------------------------------------------
// fromCriteria — SearchCriteria → Partial<TripContext> (edit carry-back)
// ---------------------------------------------------------------------------

/**
 * Fold a parsed `SearchCriteria` back into the shared-context fields it can
 * meaningfully populate, so an edit made on a booking page flows back into the
 * single Shared_Trip_Context. Only fields with a genuine shared-context mapping
 * are returned; a blank criteria string yields no corresponding context field
 * (no fabrication of empty values into the context).
 *
 * - stays/flights/cars `destination`/`pickupLocation` → `context.destination`
 * - flights `origin` → `context.origin`
 *
 * Non-blank check: `parseCriteria` fills missing params with `""`; an empty
 * string is "not supplied", so it is dropped rather than written back as a
 * blank destination/origin.
 */
export function fromCriteria(c: SearchCriteria): Partial<TripContext> {
  const out: Partial<TripContext> = {};

  switch (c.category) {
    case "stays": {
      if (c.destination.trim() !== "") out.destination = c.destination;
      break;
    }
    case "flights": {
      if (c.origin.trim() !== "") out.origin = c.origin;
      if (c.destination.trim() !== "") out.destination = c.destination;
      break;
    }
    case "cars": {
      if (c.pickupLocation.trim() !== "") out.destination = c.pickupLocation;
      break;
    }
  }

  return out;
}
