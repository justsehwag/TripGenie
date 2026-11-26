/**
 * Site assistant tools: per-page allow-lists, action validators and the
 * Bedrock Converse tool specs. Pure (no network, no React); used by the
 * server loop and safe to import from the client for re-validation.
 *
 * Every Action_Proposal is built only from validated parameters. Model text
 * never reaches `summary` or `fields`. Validation reuses the search-form
 * validators (`validateFlights`/`validateStays`) and the view constants of
 * `lib/results-view.ts`, so the assistant cannot produce a search the page
 * would reject.
 */
import {
  validateFlights,
  validateStays,
  type FlightsCriteria,
  type StaysCriteria,
} from "../search-criteria";
import { FLIGHTS_SORTS, MIN_RATINGS, STAYS_SORTS, STOP_BANDS } from "../results-view";
import type { ToolSpec } from "../assistant/bedrock-tools";
import type { ActionProposal, PageId } from "./types";

export type { ToolSpec };

export const TOOL_ALLOW_LISTS: Record<PageId, string[]> = {
  discover: ["searchPlace", "openPlace", "goTo"],
  flights: ["setSearch", "setSort", "setFilter", "goTo"],
  stays: ["setSearch", "setSort", "setFilter", "goTo"],
  cars: ["goTo"],
  trips: ["goTo"],
  account: ["goTo"],
  deals: ["goTo"],
  general: ["goTo"],
  // The itinerary keeps its own tools (lib/assistant/tools.ts via /api/assistant).
  itinerary: [],
};

export const GOTO_ROUTES = [
  "/",
  "/discover",
  "/flights",
  "/stays",
  "/cars",
  "/deals",
  "/trips",
  "/account",
  "/itinerary",
  "/plan",
  "/trip",
] as const;

export type ActionValidationResult =
  | { ok: true; proposal: ActionProposal }
  | { ok: false; error: string };

export interface ValidateOptions {
  /** Proposal id; generated when omitted. */
  id?: string;
  /** Clock for the "not in the past" checks; defaults to now. */
  now?: Date;
}

const MAX_STRING = 100;
const MAX_PRICE = 10_000_000;
const MIN_GROUP = 1;
const MAX_GROUP = 9;

/* ------------------------------ helpers ------------------------------ */

type Fail = { ok: false; error: string };
type Checked<T> = { ok: true; value: T } | Fail;

const fail = (error: string): Fail => ({ ok: false, error });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** Returns an error when `input` is not an object or has a name outside `allowed`. */
function checkKeys(input: unknown, allowed: readonly string[]): Checked<Record<string, unknown>> {
  if (!isRecord(input)) return fail("input: must be an object");
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) return fail(`${key}: unknown parameter`);
  }
  return { ok: true, value: input };
}

function str(obj: Record<string, unknown>, key: string, required: boolean): Checked<string | undefined> {
  if (!hasOwn(obj, key) || obj[key] === undefined || obj[key] === null) {
    return required ? fail(`${key}: required`) : { ok: true, value: undefined };
  }
  const v = obj[key];
  if (typeof v !== "string") return fail(`${key}: must be a string`);
  const t = v.trim();
  if (t.length === 0) return required ? fail(`${key}: required`) : { ok: true, value: undefined };
  if (t.length > MAX_STRING) return fail(`${key}: must be at most ${MAX_STRING} characters`);
  return { ok: true, value: t };
}

function isoDate(obj: Record<string, unknown>, key: string, required: boolean): Checked<string | undefined> {
  const s = str(obj, key, required);
  if (!s.ok || s.value === undefined) return s;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.value);
  if (!m) return fail(`${key}: must be a date as YYYY-MM-DD`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (
    d.getUTCFullYear() !== Number(m[1]) ||
    d.getUTCMonth() !== Number(m[2]) - 1 ||
    d.getUTCDate() !== Number(m[3])
  ) {
    return fail(`${key}: not a real calendar date`);
  }
  return s;
}

/** Integer 1..9 (travellers, guests); `fallback` applies when absent. */
function groupSize(obj: Record<string, unknown>, key: string, fallback: number): Checked<number> {
  if (!hasOwn(obj, key) || obj[key] === undefined || obj[key] === null) return { ok: true, value: fallback };
  const v = obj[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < MIN_GROUP || v > MAX_GROUP) {
    return fail(`${key}: must be a whole number from ${MIN_GROUP} to ${MAX_GROUP}`);
  }
  return { ok: true, value: v };
}

function maxPrice(obj: Record<string, unknown>): Checked<number | undefined> {
  if (!hasOwn(obj, "maxPrice") || obj.maxPrice === undefined || obj.maxPrice === null) {
    return { ok: true, value: undefined };
  }
  const v = obj.maxPrice;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > MAX_PRICE) {
    return fail(`maxPrice: must be a number above 0 and at most ${MAX_PRICE}`);
  }
  return { ok: true, value: v };
}

/** Today's date in IST as YYYY-MM-DD. */
export function todayInIst(now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const out = `${get("year")}-${get("month")}-${get("day")}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(out)) return out;
  } catch {
    // fall through to the fixed-offset computation
  }
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

function formatInr(n: number): string {
  return `\u20B9${Math.round(n).toLocaleString("en-IN")}`;
}

let idCounter = 0;
function nextId(): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `sa-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function proposal(
  page: PageId,
  tool: string,
  params: Record<string, unknown>,
  summary: string,
  fields: ActionProposal["fields"],
  opts?: ValidateOptions,
): ActionValidationResult {
  return {
    ok: true,
    proposal: { id: opts?.id ?? nextId(), page, tool, params, summary, fields },
  };
}

function firstError(errors: Record<string, string>): string {
  const key = Object.keys(errors)[0];
  return key === undefined ? "invalid" : `${key}: ${errors[key]}`;
}

/* ------------------------------ validators ------------------------------ */

function validateSetSearchFlights(page: PageId, input: unknown, opts?: ValidateOptions): ActionValidationResult {
  const k = checkKeys(input, ["origin", "destination", "departDate", "returnDate", "travellers"]);
  if (!k.ok) return k;
  const o = k.value;
  const origin = str(o, "origin", true);
  if (!origin.ok) return origin;
  const destination = str(o, "destination", true);
  if (!destination.ok) return destination;
  const departDate = isoDate(o, "departDate", true);
  if (!departDate.ok) return departDate;
  const returnDate = isoDate(o, "returnDate", false);
  if (!returnDate.ok) return returnDate;
  const travellers = groupSize(o, "travellers", 1);
  if (!travellers.ok) return travellers;

  const criteria: Partial<FlightsCriteria> = {
    tripType: returnDate.value === undefined ? "one-way" : "round-trip",
    origin: origin.value,
    destination: destination.value,
    departDate: departDate.value,
    travellers: travellers.value,
    cabin: "economy",
  };
  if (returnDate.value !== undefined) criteria.returnDate = returnDate.value;
  const errors = validateFlights(criteria);
  if (Object.keys(errors).length > 0) return fail(firstError(errors));
  if ((departDate.value as string) < todayInIst(opts?.now)) {
    return fail("departDate: must not be earlier than today");
  }

  const params: Record<string, unknown> = {
    origin: origin.value,
    destination: destination.value,
    departDate: departDate.value,
    travellers: travellers.value,
  };
  if (returnDate.value !== undefined) params.returnDate = returnDate.value;

  const fields: ActionProposal["fields"] = [
    { label: "From", after: origin.value as string },
    { label: "To", after: destination.value as string },
    { label: "Depart", after: departDate.value as string },
  ];
  if (returnDate.value !== undefined) fields.push({ label: "Return", after: returnDate.value });
  fields.push({ label: "Travellers", after: String(travellers.value) });

  const when = returnDate.value === undefined ? departDate.value : `${departDate.value} to ${returnDate.value}`;
  return proposal(
    page,
    "setSearch",
    params,
    `Search flights from ${origin.value} to ${destination.value}, ${when}, ${travellers.value} traveller${travellers.value === 1 ? "" : "s"}.`,
    fields,
    opts,
  );
}

function validateSetSearchStays(page: PageId, input: unknown, opts?: ValidateOptions): ActionValidationResult {
  const k = checkKeys(input, ["destination", "checkIn", "checkOut", "guests"]);
  if (!k.ok) return k;
  const o = k.value;
  const destination = str(o, "destination", true);
  if (!destination.ok) return destination;
  const checkIn = isoDate(o, "checkIn", true);
  if (!checkIn.ok) return checkIn;
  const checkOut = isoDate(o, "checkOut", true);
  if (!checkOut.ok) return checkOut;
  const guests = groupSize(o, "guests", 1);
  if (!guests.ok) return guests;

  const criteria: Partial<StaysCriteria> = {
    destination: destination.value,
    checkIn: checkIn.value,
    checkOut: checkOut.value,
    guests: guests.value,
    rooms: 1,
  };
  const errors = validateStays(criteria);
  if (Object.keys(errors).length > 0) return fail(firstError(errors));
  if ((checkIn.value as string) < todayInIst(opts?.now)) {
    return fail("checkIn: must not be earlier than today");
  }

  return proposal(
    page,
    "setSearch",
    {
      destination: destination.value,
      checkIn: checkIn.value,
      checkOut: checkOut.value,
      guests: guests.value,
    },
    `Search stays in ${destination.value}, ${checkIn.value} to ${checkOut.value}, ${guests.value} guest${guests.value === 1 ? "" : "s"}.`,
    [
      { label: "Destination", after: destination.value as string },
      { label: "Check-in", after: checkIn.value as string },
      { label: "Check-out", after: checkOut.value as string },
      { label: "Guests", after: String(guests.value) },
    ],
    opts,
  );
}

const STOP_LABEL: Record<string, string> = { "0": "Non-stop", "1": "1 stop", "2": "2+ stops" };

function parseStops(raw: unknown): Checked<number[]> {
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0 || list.length > STOP_BANDS.length) return fail("stops: give 1 to 3 values from 0, 1, 2");
  const seen = new Set<number>();
  for (const v of list) {
    if (typeof v !== "number" || !Number.isInteger(v) || !(STOP_BANDS as readonly string[]).includes(String(v))) {
      return fail("stops: values must be 0, 1 or 2");
    }
    seen.add(v);
  }
  return { ok: true, value: Array.from(seen).sort((a, b) => a - b) };
}

function validateSetFilter(page: PageId, input: unknown, opts?: ValidateOptions): ActionValidationResult {
  if (page === "flights") {
    const k = checkKeys(input, ["stops", "maxPrice"]);
    if (!k.ok) return k;
    const o = k.value;
    const price = maxPrice(o);
    if (!price.ok) return price;
    const hasStops = hasOwn(o, "stops") && o.stops !== undefined && o.stops !== null;
    const stops = hasStops ? parseStops(o.stops) : undefined;
    if (stops && !stops.ok) return stops;
    if (!stops && price.value === undefined) return fail("input: give stops or maxPrice");

    const params: Record<string, unknown> = {};
    const fields: ActionProposal["fields"] = [];
    const parts: string[] = [];
    if (stops && stops.ok) {
      params.stops = stops.value;
      const label = stops.value.map((s) => STOP_LABEL[String(s)]).join(", ");
      fields.push({ label: "Stops", after: label });
      parts.push(label);
    }
    if (price.value !== undefined) {
      params.maxPrice = price.value;
      fields.push({ label: "Max price per person", after: formatInr(price.value) });
      parts.push(`up to ${formatInr(price.value)}`);
    }
    return proposal(page, "setFilter", params, `Filter flights: ${parts.join(", ")}.`, fields, opts);
  }

  const k = checkKeys(input, ["maxPrice", "minRating"]);
  if (!k.ok) return k;
  const o = k.value;
  const price = maxPrice(o);
  if (!price.ok) return price;
  let rating: number | undefined;
  if (hasOwn(o, "minRating") && o.minRating !== undefined && o.minRating !== null) {
    const r = o.minRating;
    if (typeof r !== "number" || !(MIN_RATINGS as readonly number[]).includes(r)) {
      return fail(`minRating: must be one of ${MIN_RATINGS.join(", ")}`);
    }
    rating = r;
  }
  if (rating === undefined && price.value === undefined) return fail("input: give maxPrice or minRating");

  const params: Record<string, unknown> = {};
  const fields: ActionProposal["fields"] = [];
  const parts: string[] = [];
  if (price.value !== undefined) {
    params.maxPrice = price.value;
    fields.push({ label: "Max price per night", after: formatInr(price.value) });
    parts.push(`up to ${formatInr(price.value)} a night`);
  }
  if (rating !== undefined) {
    params.minRating = rating;
    const label = rating === 0 ? "Any" : `${rating.toFixed(1)}+`;
    fields.push({ label: "Min rating", after: label });
    parts.push(`rating ${label}`);
  }
  return proposal(page, "setFilter", params, `Filter stays: ${parts.join(", ")}.`, fields, opts);
}

function validateSetSort(page: PageId, input: unknown, opts?: ValidateOptions): ActionValidationResult {
  const k = checkKeys(input, ["sort"]);
  if (!k.ok) return k;
  const sort = str(k.value, "sort", true);
  if (!sort.ok) return sort;
  const allowed: readonly string[] = page === "flights" ? FLIGHTS_SORTS : STAYS_SORTS;
  if (!allowed.includes(sort.value as string)) return fail(`sort: must be one of ${allowed.join(", ")}`);
  return proposal(
    page,
    "setSort",
    { sort: sort.value },
    `Sort ${page} by ${sort.value}.`,
    [{ label: "Sort", after: sort.value as string }],
    opts,
  );
}

function validateSearchPlace(page: PageId, input: unknown, opts?: ValidateOptions): ActionValidationResult {
  const k = checkKeys(input, ["query"]);
  if (!k.ok) return k;
  const query = str(k.value, "query", true);
  if (!query.ok) return query;
  return proposal(
    page,
    "searchPlace",
    { query: query.value },
    `Search places for "${query.value}".`,
    [{ label: "Search", after: query.value as string }],
    opts,
  );
}

function validateOpenPlace(page: PageId, input: unknown, opts?: ValidateOptions): ActionValidationResult {
  const k = checkKeys(input, ["name", "placeId"]);
  if (!k.ok) return k;
  const name = str(k.value, "name", true);
  if (!name.ok) return name;
  const placeId = str(k.value, "placeId", false);
  if (!placeId.ok) return placeId;
  if (placeId.value !== undefined && !/^[A-Za-z0-9_-]+$/.test(placeId.value)) {
    return fail("placeId: contains characters that are not allowed");
  }
  const params: Record<string, unknown> = { name: name.value };
  if (placeId.value !== undefined) params.placeId = placeId.value;
  return proposal(
    page,
    "openPlace",
    params,
    `Open ${name.value}.`,
    [{ label: "Open place", after: name.value as string }],
    opts,
  );
}

function validateGoTo(page: PageId, input: unknown, opts?: ValidateOptions): ActionValidationResult {
  const k = checkKeys(input, ["route"]);
  if (!k.ok) return k;
  const route = k.value.route;
  if (typeof route !== "string" || !(GOTO_ROUTES as readonly string[]).includes(route)) {
    return fail(`route: must be one of ${GOTO_ROUTES.join(", ")}`);
  }
  return proposal(page, "goTo", { route }, `Go to ${route}.`, [{ label: "Go to", after: route }], opts);
}

/**
 * Validates one model tool call for `page`. Names outside the page's
 * allow-list fail without running any validator. On success the proposal's
 * params, summary and fields come only from the validated values.
 */
export function validateAction(
  page: PageId,
  name: string,
  input: unknown,
  opts?: ValidateOptions,
): ActionValidationResult {
  const allowed = hasOwn(TOOL_ALLOW_LISTS, page) ? TOOL_ALLOW_LISTS[page] : [];
  if (typeof name !== "string" || !allowed.includes(name)) {
    return fail(`${String(name).slice(0, 40)}: tool is not available on this page`);
  }
  try {
    switch (name) {
      case "setSearch":
        return page === "flights"
          ? validateSetSearchFlights(page, input, opts)
          : validateSetSearchStays(page, input, opts);
      case "setFilter":
        return validateSetFilter(page, input, opts);
      case "setSort":
        return validateSetSort(page, input, opts);
      case "searchPlace":
        return validateSearchPlace(page, input, opts);
      case "openPlace":
        return validateOpenPlace(page, input, opts);
      case "goTo":
        return validateGoTo(page, input, opts);
      default:
        return fail(`${name.slice(0, 40)}: unknown tool`);
    }
  } catch {
    return fail("input: could not be validated");
  }
}

/* ------------------------------ tool specs ------------------------------ */

const STR = { type: "string", maxLength: MAX_STRING };
const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD" };
const GROUP = { type: "integer", minimum: MIN_GROUP, maximum: MAX_GROUP };
const PRICE = { type: "number", exclusiveMinimum: 0, maximum: MAX_PRICE, description: "Amount in INR" };

const NOTE = " Nothing changes until the traveller previews and applies it.";

function spec(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolSpec {
  return {
    name,
    description: description + NOTE,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
  };
}

const GOTO_SPEC = spec(
  "goTo",
  "Propose opening one page of the site. Use /plan when the traveller wants to plan a whole new trip.",
  { route: { type: "string", enum: [...GOTO_ROUTES] } },
  ["route"],
);

const SPECS: Record<string, ToolSpec> = {
  "flights:setSearch": spec(
    "setSearch",
    "Propose a flight search. Omit returnDate for one-way.",
    { origin: STR, destination: STR, departDate: DATE, returnDate: DATE, travellers: GROUP },
    ["origin", "destination", "departDate"],
  ),
  "stays:setSearch": spec(
    "setSearch",
    "Propose a stay search.",
    { destination: STR, checkIn: DATE, checkOut: DATE, guests: GROUP },
    ["destination", "checkIn", "checkOut"],
  ),
  "flights:setSort": spec("setSort", "Propose a sort order for the flight results.", {
    sort: { type: "string", enum: [...FLIGHTS_SORTS] },
  }, ["sort"]),
  "stays:setSort": spec("setSort", "Propose a sort order for the stay results.", {
    sort: { type: "string", enum: [...STAYS_SORTS] },
  }, ["sort"]),
  "flights:setFilter": spec(
    "setFilter",
    "Propose flight filters. Give stops, maxPrice or both.",
    { stops: { type: "array", items: { type: "integer", enum: [0, 1, 2] }, minItems: 1, maxItems: 3 }, maxPrice: PRICE },
    [],
  ),
  "stays:setFilter": spec(
    "setFilter",
    "Propose stay filters. Give maxPrice, minRating or both.",
    { maxPrice: PRICE, minRating: { type: "number", enum: [...MIN_RATINGS] } },
    [],
  ),
  "discover:searchPlace": spec("searchPlace", "Propose searching for a place.", { query: STR }, ["query"]),
  "discover:openPlace": spec(
    "openPlace",
    "Propose opening a place that is visible on the page.",
    { name: STR, placeId: STR },
    ["name"],
  ),
};

/** Converse tool specs for `page`, in allow-list order. Empty for the itinerary. */
export function toolSpecsFor(page: PageId): ToolSpec[] {
  const names = hasOwn(TOOL_ALLOW_LISTS, page) ? TOOL_ALLOW_LISTS[page] : [];
  const out: ToolSpec[] = [];
  for (const name of names) {
    if (name === "goTo") out.push(GOTO_SPEC);
    else {
      const s = SPECS[`${page}:${name}`];
      if (s) out.push(s);
    }
  }
  return out;
}
