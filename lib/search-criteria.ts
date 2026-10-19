/**
 * Search_Criteria serializer/parser (pure) — design section
 * "Booking Site ▸ Search_Criteria Encoding (Req 28.1)".
 *
 * `SearchCriteria` is a discriminated union over the three booking categories
 * (stays/flights/cars), serialized to and parsed from URL query parameters.
 * Results pages are server components that read `searchParams`, so opening or
 * refreshing a results URL reproduces the identical search (Req 28.1, 23.4,
 * 24.6, 25.6).
 *
 * This module is framework-free: no Next.js or React imports. `serializeCriteria`
 * and `parseCriteria` are a pure, total round-trip pair — `parseCriteria` always
 * returns typed criteria, applying sensible defaults to missing/unknown params,
 * so `parseCriteria(category, serializeCriteria(c))` deep-equals `c` for every
 * valid `c` (round-trip, Property 54).
 *
 * The shared per-category validators (`validateStays`/`validateFlights`/
 * `validateCars`) are intentionally NOT defined here — they are task 31.2 and
 * live in the clearly-separated section at the bottom of this file.
 *
 * Requirements: 28.1, 23.4, 24.6, 25.6.
 */

// ---------------------------------------------------------------------------
// Types — the Search_Criteria discriminated union (design contract)
// ---------------------------------------------------------------------------

export type Category = "stays" | "flights" | "cars";

export interface StaysCriteria {
  category: "stays";
  destination: string;
  checkIn: string; // ISO date
  checkOut: string; // ISO date, strictly after checkIn (Req 23.3)
  guests: number;
  rooms: number;
}

export type FlightTripType = "round-trip" | "one-way";

export interface FlightsCriteria {
  category: "flights";
  tripType: FlightTripType; // Req 24.1
  origin: string;
  destination: string;
  departDate: string; // ISO date
  returnDate?: string; // present iff round-trip (Req 24.2)
  travellers: number;
  cabin: string;
}

export interface CarsCriteria {
  category: "cars";
  pickupLocation: string;
  dropoffLocation?: string; // present iff differs from pickup (Req 25.2)
  pickupDate: string;
  pickupTime: string;
  returnDate: string;
  returnTime: string;
  driverAge: number; // >= 18 (Req 25.5)
}

export type SearchCriteria = StaysCriteria | FlightsCriteria | CarsCriteria;

// ---------------------------------------------------------------------------
// Typed defaults — parsing is total; missing/unknown params fall back here.
// ---------------------------------------------------------------------------

/** Default integer cabin/count values keep parsing deterministic and total. */
const DEFAULT_GUESTS = 1;
const DEFAULT_ROOMS = 1;
const DEFAULT_TRAVELLERS = 1;
const DEFAULT_DRIVER_AGE = 18;
const DEFAULT_CABIN = "economy";

/** Parse a query param as a non-negative integer, falling back to `fallback`. */
function intOr(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Read a string param, trimming nothing (round-trip must preserve the value). */
function strOr(raw: string | null, fallback: string): string {
  return raw === null ? fallback : raw;
}

// ---------------------------------------------------------------------------
// serializeCriteria — SearchCriteria -> URLSearchParams query string
// ---------------------------------------------------------------------------

/**
 * Pure, total serializer: criteria -> URL query string.
 *
 * Parameter insertion order is fixed per category so the output is deterministic
 * and stable (the same criteria always produce byte-identical query strings).
 * Optional fields are emitted only when present, mirroring the union's
 * field-presence rules (flights `returnDate` iff round-trip; cars
 * `dropoffLocation` iff it differs from pickup).
 *
 * The leading `category` param lets a caller recover the discriminant, but
 * `parseCriteria` also takes the category explicitly (the route owns it).
 */
export function serializeCriteria(c: SearchCriteria): string {
  const p = new URLSearchParams();
  p.set("category", c.category);

  switch (c.category) {
    case "stays":
      p.set("destination", c.destination);
      p.set("checkIn", c.checkIn);
      p.set("checkOut", c.checkOut);
      p.set("guests", String(c.guests));
      p.set("rooms", String(c.rooms));
      break;
    case "flights":
      p.set("tripType", c.tripType);
      p.set("origin", c.origin);
      p.set("destination", c.destination);
      p.set("departDate", c.departDate);
      if (c.returnDate !== undefined) p.set("returnDate", c.returnDate);
      p.set("travellers", String(c.travellers));
      p.set("cabin", c.cabin);
      break;
    case "cars":
      p.set("pickupLocation", c.pickupLocation);
      if (c.dropoffLocation !== undefined) p.set("dropoffLocation", c.dropoffLocation);
      p.set("pickupDate", c.pickupDate);
      p.set("pickupTime", c.pickupTime);
      p.set("returnDate", c.returnDate);
      p.set("returnTime", c.returnTime);
      p.set("driverAge", String(c.driverAge));
      break;
  }

  return p.toString();
}

// ---------------------------------------------------------------------------
// parseCriteria — (category, query string) -> SearchCriteria
// ---------------------------------------------------------------------------

/**
 * Pure, total parser: (category, query string) -> typed criteria.
 *
 * Totality: every category always yields a fully-typed `SearchCriteria`. Missing
 * or unknown params fall back to the typed defaults above, so the result is
 * well-formed even for an empty query string. The explicit `category` argument
 * (supplied by the route) is authoritative and overrides any `category` param.
 *
 * Round-trip (Property 54): for any valid `c`, parsing its serialization
 * reconstructs an equal value — including the optional-field presence rules.
 * Flights only carry `returnDate` when round-trip; cars only carry
 * `dropoffLocation` when the param is present, matching serialization.
 *
 * Validation (required-field / ordering / driver-age rules) is deliberately
 * out of scope here — see the task 31.2 section below. Parsing never rejects.
 */
export function parseCriteria(category: Category, qs: string): SearchCriteria {
  const p = new URLSearchParams(qs);

  switch (category) {
    case "stays":
      return {
        category: "stays",
        destination: strOr(p.get("destination"), ""),
        checkIn: strOr(p.get("checkIn"), ""),
        checkOut: strOr(p.get("checkOut"), ""),
        guests: intOr(p.get("guests"), DEFAULT_GUESTS),
        rooms: intOr(p.get("rooms"), DEFAULT_ROOMS),
      };

    case "flights": {
      const tripType: FlightTripType =
        p.get("tripType") === "one-way" ? "one-way" : "round-trip";
      const criteria: FlightsCriteria = {
        category: "flights",
        tripType,
        origin: strOr(p.get("origin"), ""),
        destination: strOr(p.get("destination"), ""),
        departDate: strOr(p.get("departDate"), ""),
        travellers: intOr(p.get("travellers"), DEFAULT_TRAVELLERS),
        cabin: strOr(p.get("cabin"), DEFAULT_CABIN),
      };
      // `returnDate` is present iff round-trip (Req 24.2). A one-way serialization
      // omits it, so the parse omits it too — keeping the round-trip exact.
      if (tripType === "round-trip") {
        criteria.returnDate = strOr(p.get("returnDate"), "");
      }
      return criteria;
    }

    case "cars": {
      const criteria: CarsCriteria = {
        category: "cars",
        pickupLocation: strOr(p.get("pickupLocation"), ""),
        pickupDate: strOr(p.get("pickupDate"), ""),
        pickupTime: strOr(p.get("pickupTime"), ""),
        returnDate: strOr(p.get("returnDate"), ""),
        returnTime: strOr(p.get("returnTime"), ""),
        driverAge: intOr(p.get("driverAge"), DEFAULT_DRIVER_AGE),
      };
      // `dropoffLocation` is present iff it differs from pickup (Req 25.2); the
      // serializer only emits the param in that case, so mirror its presence.
      if (p.has("dropoffLocation")) {
        criteria.dropoffLocation = strOr(p.get("dropoffLocation"), "");
      }
      return criteria;
    }
  }
}

// ===========================================================================
// Task 31.2 — Shared per-category validators (validateStays / validateFlights /
// validateCars). Intentionally NOT implemented in task 31.1. Implemented as a
// separate task in this same file.
// ===========================================================================

/**
 * A per-category validator maps the (possibly partial) form field values to a
 * field → message map. An EMPTY map means the input is valid; any entry is a
 * field-level rejection with a human-readable message. The map is keyed by the
 * criteria field name so both the client form and the server results page can
 * render the message against the right input (design "Form Validation").
 *
 * Validators take `Partial<C>` because a form in progress may omit fields, and
 * both callers (client submit handler, server page guard) run the identical
 * pure check. They are deterministic and total: the same fields always produce
 * the same map, and no input throws.
 */
export type Validator<C> = (fields: Partial<C>) => Record<string, string>;

/**
 * A string field counts as "missing" when it is absent, `undefined`, or blank
 * once trimmed. Forms submit empty inputs as `""`, so blank must reject exactly
 * like an omitted field (Req 23.2 / 24.4 / 25.3).
 */
function isBlank(v: string | undefined): boolean {
  return v === undefined || v.trim() === "";
}

/**
 * A numeric field counts as "missing" when it is absent or not a finite number.
 * `NaN`/`Infinity` (e.g. a non-numeric form entry coerced to a number) reject
 * as missing rather than silently passing an ordering/age comparison.
 */
function isMissingNumber(v: number | undefined): boolean {
  return v === undefined || !Number.isFinite(v);
}

/** Minimum permitted car-rental driver age (Req 25.5). */
const MIN_DRIVER_AGE = 18;

// ---------------------------------------------------------------------------
// validateStays — required fields + check-out strictly after check-in
// ---------------------------------------------------------------------------

/**
 * Stays rejection rules (Req 23.2 / 23.3, Property 55):
 * - `destination`, `checkIn`, `checkOut` required (non-blank).
 * - `guests`, `rooms` required (present, finite).
 * - `checkOut` must be strictly AFTER `checkIn`; on-or-before rejects.
 *
 * Dates are ISO (`YYYY-MM-DD`) strings produced by the form, so lexicographic
 * `<=` is a correct chronological comparison. The ordering check only runs when
 * both dates are present, so a missing date reports only the missing-field
 * error (not a spurious ordering error).
 */
export const validateStays: Validator<StaysCriteria> = (fields) => {
  const errors: Record<string, string> = {};

  if (isBlank(fields.destination)) errors.destination = "Destination is required.";
  if (isBlank(fields.checkIn)) errors.checkIn = "Check-in date is required.";
  if (isBlank(fields.checkOut)) errors.checkOut = "Check-out date is required.";
  if (isMissingNumber(fields.guests)) errors.guests = "Guest count is required.";
  if (isMissingNumber(fields.rooms)) errors.rooms = "Room count is required.";

  if (
    !isBlank(fields.checkIn) &&
    !isBlank(fields.checkOut) &&
    (fields.checkOut as string) <= (fields.checkIn as string)
  ) {
    errors.checkOut = "Check-out date must be after the check-in date.";
  }

  return errors;
};

// ---------------------------------------------------------------------------
// validateFlights — required fields + round-trip return on/after departure
// ---------------------------------------------------------------------------

/**
 * Flights rejection rules (Req 24.4 / 24.5, Property 55):
 * - `origin`, `destination`, `departDate`, `cabin` required (non-blank);
 *   `travellers` required (present, finite); `tripType` required.
 * - WHERE `tripType === "round-trip"`: `returnDate` required and must be ON OR
 *   AFTER `departDate` (earlier rejects; equal is allowed — same-day return).
 * - A one-way trip carries no `returnDate`, so it is neither required nor
 *   ordering-checked.
 *
 * ISO date strings compare lexicographically; the ordering check only runs when
 * both dates are present.
 */
export const validateFlights: Validator<FlightsCriteria> = (fields) => {
  const errors: Record<string, string> = {};

  if (isBlank(fields.tripType)) errors.tripType = "Trip type is required.";
  if (isBlank(fields.origin)) errors.origin = "Origin is required.";
  if (isBlank(fields.destination)) errors.destination = "Destination is required.";
  if (isBlank(fields.departDate)) errors.departDate = "Departure date is required.";
  if (isMissingNumber(fields.travellers)) errors.travellers = "Traveler count is required.";
  if (isBlank(fields.cabin)) errors.cabin = "Cabin class is required.";

  if (fields.tripType === "round-trip") {
    if (isBlank(fields.returnDate)) {
      errors.returnDate = "Return date is required for a round-trip.";
    } else if (
      !isBlank(fields.departDate) &&
      (fields.returnDate as string) < (fields.departDate as string)
    ) {
      errors.returnDate = "Return date must be on or after the departure date.";
    }
  }

  return errors;
};

// ---------------------------------------------------------------------------
// validateCars — required fields + return after pickup + driver age >= 18
// ---------------------------------------------------------------------------

/**
 * Cars rejection rules (Req 25.3 / 25.4 / 25.5, Property 55):
 * - `pickupLocation`, `pickupDate`, `pickupTime`, `returnDate`, `returnTime`
 *   required (non-blank); `driverAge` required (present, finite).
 * - The return instant (`returnDate` + `returnTime`) must be strictly AFTER the
 *   pickup instant (`pickupDate` + `pickupTime`); on-or-before rejects.
 * - `driverAge` must be at least 18.
 *
 * Date and time are ISO (`YYYY-MM-DD` / `HH:MM`), so concatenating them into a
 * single `YYYY-MM-DDTHH:MM` key makes lexicographic comparison chronological.
 * The ordering check only runs when all four date/time parts are present.
 */
export const validateCars: Validator<CarsCriteria> = (fields) => {
  const errors: Record<string, string> = {};

  if (isBlank(fields.pickupLocation)) errors.pickupLocation = "Pickup location is required.";
  if (isBlank(fields.pickupDate)) errors.pickupDate = "Pickup date is required.";
  if (isBlank(fields.pickupTime)) errors.pickupTime = "Pickup time is required.";
  if (isBlank(fields.returnDate)) errors.returnDate = "Return date is required.";
  if (isBlank(fields.returnTime)) errors.returnTime = "Return time is required.";
  if (isMissingNumber(fields.driverAge)) errors.driverAge = "Driver age is required.";

  if (
    !isBlank(fields.pickupDate) &&
    !isBlank(fields.pickupTime) &&
    !isBlank(fields.returnDate) &&
    !isBlank(fields.returnTime)
  ) {
    const pickup = `${fields.pickupDate as string}T${fields.pickupTime as string}`;
    const ret = `${fields.returnDate as string}T${fields.returnTime as string}`;
    if (ret <= pickup) {
      errors.returnDate = "Return must be after the pickup.";
    }
  }

  if (!isMissingNumber(fields.driverAge) && (fields.driverAge as number) < MIN_DRIVER_AGE) {
    errors.driverAge = `Driver age must be at least ${MIN_DRIVER_AGE}.`;
  }

  return errors;
};
