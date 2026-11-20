/**
 * Trip Assistant: Google Places lookups (server-only).
 *
 * `searchPlacesForAssistant` wraps `searchCandidatesText`, `fetchPlaceRecord`
 * fetches one place fresh by id (Places Details, same field mask as the
 * candidate search, same mapper), and `buildAlternativesQuery` builds the
 * bounded query for "suggest something else".
 *
 * Provider functions are injected through `deps` so tests can fake them. No
 * function here throws; failures come back as `{ status: "unavailable" }` or
 * `null`. The API key is sent only as a header and never returned or logged.
 */
import { googlePlacesApiKey } from "@/lib/config";
import { isInjectionText, sanitizeText } from "@/lib/grounding/sanitize";
import { LOOKUP_TIMEOUT_MS } from "@/lib/itinerary/constants";
import { typicalWeekday, weekdayDescription, weekdayOf } from "@/lib/itinerary/hours";
import { buildMapsUrl } from "@/lib/itinerary/maps-link";
import { areaOfAddress } from "@/lib/itinerary/polish-check";
import { visitMinutes } from "@/lib/itinerary/scheduler";
import {
  CANDIDATE_FIELD_MASK,
  parseCandidates,
  searchCandidatesText,
  type CandidateLookup,
  type CandidateSearchOptions,
  type PlaceCandidate,
  type PostFetchLike,
} from "@/lib/providers/google-places";
import type { PlaceRecord } from "./types";

/** Requirement 5.8. */
export const MAX_ASSISTANT_PLACES = 5;
/** Requirement 10.1 / design: alternatives query length cap. */
export const MAX_ALTERNATIVES_QUERY_CHARS = 120;
const MAX_TEXT_SEARCH_RESULTS = 20;
const MAX_NAME_CHARS = 100;
const MAX_ADDRESS_CHARS = 160;
const MAX_AREA_CHARS = 60;

const DETAILS_BASE = "https://places.googleapis.com/v1/places/";
/** The candidate mask for a Details GET: same fields, without the "places." prefix. */
const DETAILS_FIELD_MASK = CANDIDATE_FIELD_MASK.split(",")
  .map((f) => f.replace(/^places\./, ""))
  .join(",");

/** One place as the model sees it (Requirement 5.4). */
export interface ShapedPlace {
  placeId: string;
  name: string;
  address: string;
  area?: string;
  rating?: number;
  openingHours?: string;
  hoursLabel?: "Typical hours" | "Hours not listed";
}

export type PlacesSearchResult =
  | { status: "ok"; places: ShapedPlace[] }
  | { status: "unavailable" };

export interface PlacesLookupDeps {
  searchText: (
    query: string,
    fetchImpl?: PostFetchLike,
    opts?: CandidateSearchOptions,
  ) => Promise<CandidateLookup>;
  /** Fresh Places Details by id. Resolves to null when not found or failed. */
  fetchDetails: (
    placeId: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<PlaceCandidate | null>;
}

export interface SearchPlacesInput {
  /** The model's query (already validated, at most 120 chars). */
  query: string;
  destination: string;
  /** Area of the named day's Stops, when a day was named (Requirement 5.3). */
  dayArea?: string;
  /** Place ids of Stops already in the itinerary. */
  existingPlaceIds?: Iterable<string>;
  /** Keep places already in the itinerary (Requirement 5.7). */
  includeExisting?: boolean;
  /** yyyy-mm-dd of the named day, used to pick that weekday's hours. */
  date?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function clean(s: unknown, max: number): string {
  return sanitizeText(typeof s === "string" ? s : "").slice(0, max).trim();
}

/** Opening hours text and its label for one candidate. */
function hoursFor(
  c: PlaceCandidate,
  date?: string,
): { openingHours?: string; hoursLabel?: "Typical hours" | "Hours not listed" } {
  if (!c.hours) return { hoursLabel: "Hours not listed" };
  const dated = date !== undefined ? weekdayOf(date) : null;
  if (dated !== null) {
    const text = weekdayDescription(c.hours, dated);
    return text ? { openingHours: clean(text, 120) } : { hoursLabel: "Hours not listed" };
  }
  const typical = typicalWeekday(c.hours);
  const text = typical === null ? null : weekdayDescription(c.hours, typical);
  return text ? { openingHours: clean(text, 120), hoursLabel: "Typical hours" } : { hoursLabel: "Hours not listed" };
}

function shapeOne(c: PlaceCandidate, destination: string, date?: string): ShapedPlace | null {
  const name = clean(c.name, MAX_NAME_CHARS);
  if (name.length === 0 || isInjectionText(c.name)) return null;
  const area = clean(areaOfAddress(c.address, destination), MAX_AREA_CHARS);
  const out: ShapedPlace = {
    placeId: c.placeId,
    name,
    address: clean(c.address, MAX_ADDRESS_CHARS),
  };
  if (area) out.area = area;
  if (typeof c.rating === "number") out.rating = c.rating;
  Object.assign(out, hoursFor(c, date));
  return out;
}

/**
 * Drop candidates without a placeId and, unless `includeExisting`, those already
 * in the itinerary. Duplicate ids are kept once. At most 5 results, in order.
 */
export function shapePlaces(
  candidates: readonly PlaceCandidate[],
  opts: {
    destination: string;
    existingPlaceIds?: Iterable<string>;
    includeExisting?: boolean;
    date?: string;
  },
): ShapedPlace[] {
  const existing = new Set<string>(opts.existingPlaceIds ?? []);
  const seen = new Set<string>();
  const out: ShapedPlace[] = [];
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (!c || typeof c.placeId !== "string" || c.placeId.length === 0) continue;
    if (seen.has(c.placeId)) continue;
    if (!opts.includeExisting && existing.has(c.placeId)) continue;
    const shaped = shapeOne(c, opts.destination, opts.date);
    if (!shaped) continue;
    seen.add(c.placeId);
    out.push(shaped);
    if (out.length >= MAX_ASSISTANT_PLACES) break;
  }
  return out;
}

/** Query text biased to the destination and, when given, the day's area. */
function biasedQuery(input: SearchPlacesInput): string {
  const parts: string[] = [input.query.trim()];
  const lower = () => parts.join(" ").toLowerCase();
  for (const extra of [input.dayArea, input.destination]) {
    const t = typeof extra === "string" ? extra.trim() : "";
    if (t && !lower().includes(t.toLowerCase())) parts.push(t);
  }
  return parts.filter(Boolean).join(" ");
}

export async function searchPlacesForAssistant(
  input: SearchPlacesInput,
  deps: Partial<PlacesLookupDeps> = {},
): Promise<PlacesSearchResult> {
  try {
    const search = deps.searchText ?? searchCandidatesText;
    const query = biasedQuery(input);
    if (query.length === 0) return { status: "unavailable" };
    const lookup = await search(query, undefined, {
      maxResults: MAX_TEXT_SEARCH_RESULTS,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
    if (!lookup || lookup.kind !== "ok") return { status: "unavailable" };
    return {
      status: "ok",
      places: shapePlaces(lookup.candidates, {
        destination: input.destination,
        existingPlaceIds: input.existingPlaceIds,
        includeExisting: input.includeExisting,
        date: input.date,
      }),
    };
  } catch {
    return { status: "unavailable" };
  }
}

/** Map a candidate to the PlaceRecord carried by a proposal. */
export function candidateToPlaceRecord(c: PlaceCandidate, destination?: string, date?: string): PlaceRecord {
  const name = clean(c.name, MAX_NAME_CHARS);
  const rec: PlaceRecord = {
    placeId: c.placeId,
    name,
    address: clean(c.address, MAX_ADDRESS_CHARS),
    location: { lat: c.location.lat, lng: c.location.lng },
    mapsUrl: buildMapsUrl(c.placeId, name),
    visitMin: visitMinutes(c),
  };
  const area = clean(areaOfAddress(c.address, destination), MAX_AREA_CHARS);
  if (area) rec.area = area;
  const photos = (Array.isArray(c.photos) ? c.photos : []).filter((p) => typeof p === "string" && p !== "");
  if (photos.length > 0) {
    rec.photos = photos;
    rec.photoRef = photos[0];
  }
  if (typeof c.rating === "number") rec.rating = c.rating;
  Object.assign(rec, hoursFor(c, date));
  return rec;
}

/** Real Places Details GET by id. Never throws; null on any failure. */
async function defaultFetchDetails(
  placeId: string,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<PlaceCandidate | null> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const key = googlePlacesApiKey();
    if (key.length === 0) return null;
    const f = (globalThis as { fetch?: unknown }).fetch;
    if (typeof f !== "function") return null;
    if (opts?.signal) {
      if (opts.signal.aborted) return null;
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    const requested = opts?.timeoutMs;
    timer = setTimeout(
      () => controller.abort(),
      typeof requested === "number" && requested > 0 ? Math.min(requested, 5000) : LOOKUP_TIMEOUT_MS,
    );
    const response = await (f as PostFetchLike)(DETAILS_BASE + encodeURIComponent(placeId), {
      method: "GET",
      headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": DETAILS_FIELD_MASK },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json();
    const parsed = parseCandidates({ places: [body] });
    return parsed && parsed.length > 0 ? parsed[0] : null;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    opts?.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Fresh Places Details for one id, mapped to a PlaceRecord. Returns null when
 * the place is not found or the lookup failed. Never throws.
 */
export async function fetchPlaceRecord(
  placeId: string,
  opts: { destination?: string; date?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  deps: Partial<PlacesLookupDeps> = {},
): Promise<PlaceRecord | null> {
  try {
    const id = typeof placeId === "string" ? placeId.trim() : "";
    if (id.length === 0) return null;
    const fetchDetails = deps.fetchDetails ?? defaultFetchDetails;
    const c = await fetchDetails(id, { timeoutMs: opts.timeoutMs, signal: opts.signal });
    if (!c || typeof c.placeId !== "string" || c.placeId.length === 0) return null;
    if (clean(c.name, MAX_NAME_CHARS).length === 0) return null;
    return candidateToPlaceRecord(c, opts.destination, opts.date);
  } catch {
    return null;
  }
}

export interface AlternativesQueryInput {
  destination: string;
  theme: string;
  category: string;
  /** Constraint words such as "cheaper", "closer", "indoor", "vegetarian". */
  constraints?: readonly string[];
  interests?: readonly string[];
}

function words(s: unknown): string {
  return sanitizeText(typeof s === "string" ? s : "").replace(/\s+/g, " ").trim();
}

/**
 * Places query for alternatives: constraint words, category, theme and
 * destination, at most 120 characters. When the required parts are too long the
 * longest one is shortened first. Interests are added only if they fit whole.
 */
export function buildAlternativesQuery(input: AlternativesQueryInput): string {
  const constraints = (input.constraints ?? []).map(words).filter(Boolean);
  const required: string[] = [...constraints, words(input.category), words(input.theme), words(input.destination)];
  // Fixed layout: "<constraints> <category> <theme> in <destination>"
  const build = (p: string[]): string => {
    const n = constraints.length;
    const head = p.slice(0, n + 2).filter(Boolean).join(" ");
    return `${head} in ${p[n + 2]}`.replace(/\s+/g, " ").trim();
  };
  const parts = required.slice();
  let guard = 0;
  while (build(parts).length > MAX_ALTERNATIVES_QUERY_CHARS && guard++ < 1000) {
    let longest = 0;
    for (let i = 1; i < parts.length; i++) if (parts[i].length > parts[longest].length) longest = i;
    if (parts[longest].length === 0) break;
    parts[longest] = parts[longest].slice(0, -1).trimEnd();
  }
  let query = build(parts);
  for (const raw of input.interests ?? []) {
    const w = words(raw);
    if (!w || query.toLowerCase().includes(w.toLowerCase())) continue;
    if (`${query} ${w}`.length > MAX_ALTERNATIVES_QUERY_CHARS) break;
    query = `${query} ${w}`;
  }
  return query.slice(0, MAX_ALTERNATIVES_QUERY_CHARS);
}
