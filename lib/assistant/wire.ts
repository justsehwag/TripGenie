/**
 * Wire validation for the Trip Assistant. Pure, client-safe, never throws.
 * Hand-written validators (no zod). Imports types only.
 */
import type { Itinerary } from "../types";
import type {
  AssistantContext,
  AssistantRequest,
  ChatTurn,
  CitedPriceRecord,
  EditOp,
  EditProposal,
  OfferedPlace,
  PlaceRecord,
  ProfileSubset,
  WireDay,
  WireItinerary,
  WireStop,
} from "./types";

/* ------------------------------ limits ------------------------------ */
export const MAX_MESSAGE_CHARS = 1000;
export const MAX_ASSISTANT_TURN_CHARS = 4000;
export const MAX_BODY_BYTES = 262144;
export const MAX_HISTORY_TURNS = 10;
export const MAX_OFFERED = 30;
export const MAX_PROPOSALS = 5;
export const MAX_SUMMARY_CHARS = 200;
export const MAX_DAYS = 30;
export const MAX_STOPS_PER_DAY = 20;
export const MAX_TEXT_FIELD_CHARS = 600;
export const MAX_SHORT_FIELD_CHARS = 200;
export const MAX_INTERESTS = 20;
export const MAX_PARTY_COUNT = 50;
export const MAX_PLACE_ID_CHARS = 300;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/* ------------------------------ helpers ----------------------------- */
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  return v.length > max ? v.slice(0, max) : v;
}
function nonEmptyStr(v: unknown, max: number): string | undefined {
  const s = str(v, max);
  return s !== undefined && s.trim().length > 0 ? s : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function int(v: unknown, min: number, max: number): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
}
function counts(v: unknown): { adults: number; children: number } | undefined {
  if (!isObj(v)) return undefined;
  const adults = int(v.adults, 0, MAX_PARTY_COUNT);
  const children = int(v.children, 0, MAX_PARTY_COUNT);
  return adults === undefined || children === undefined ? undefined : { adults, children };
}
function lonLat(v: unknown): { lat: number; lng: number } | undefined {
  if (!isObj(v)) return undefined;
  const lat = num(v.lat);
  const lng = num(v.lng);
  if (lat === undefined || lng === undefined || Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;
  return { lat, lng };
}

/* ------------------------- byte-size guard -------------------------- */
/** UTF-8 byte length of a string. Never throws. */
export function utf8ByteLength(text: string): number {
  try {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  } catch {
    /* fall through */
  }
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** True when the text's UTF-8 size is within the limit (default MAX_BODY_BYTES). */
export function withinByteLimit(text: string, maxBytes: number = MAX_BODY_BYTES): boolean {
  return typeof text === "string" && utf8ByteLength(text) <= maxBytes;
}

/** True when a content-length header value is a valid size within the limit. Missing header is OK. */
export function contentLengthOk(header: string | null | undefined, maxBytes: number = MAX_BODY_BYTES): boolean {
  if (header === null || header === undefined || header === "") return true;
  const n = Number(header);
  return Number.isFinite(n) && n >= 0 && n <= maxBytes;
}

/* ------------------------ profile whitelist ------------------------- */
/**
 * Keeps only firstName, homeCity, travelStyle and party. Everything else
 * (userId, email, phone, payment, ...) is dropped. Returns undefined when
 * nothing valid remains.
 */
export function whitelistProfile(raw: unknown): ProfileSubset | undefined {
  if (!isObj(raw)) return undefined;
  const out: ProfileSubset = {};
  const firstName = nonEmptyStr(raw.firstName, MAX_SHORT_FIELD_CHARS);
  if (firstName !== undefined) out.firstName = firstName.trim();
  const homeCity = nonEmptyStr(raw.homeCity, MAX_SHORT_FIELD_CHARS);
  if (homeCity !== undefined) out.homeCity = homeCity.trim();
  const travelStyle = nonEmptyStr(raw.travelStyle, MAX_SHORT_FIELD_CHARS);
  if (travelStyle !== undefined) out.travelStyle = travelStyle.trim();
  const party = counts(raw.party);
  if (party) out.party = party;
  return Object.keys(out).length > 0 ? out : undefined;
}

/* ------------------------ context whitelist ------------------------- */
/** Keeps only the AssistantContext fields, each validated. */
export function whitelistContext(raw: unknown): AssistantContext {
  const out: AssistantContext = {};
  if (!isObj(raw)) return out;
  const origin = nonEmptyStr(raw.origin, MAX_SHORT_FIELD_CHARS);
  if (origin !== undefined) out.origin = origin;
  const destination = nonEmptyStr(raw.destination, MAX_SHORT_FIELD_CHARS);
  if (destination !== undefined) out.destination = destination;
  const durationDays = int(raw.durationDays, 1, MAX_DAYS);
  if (durationDays !== undefined) out.durationDays = durationDays;
  const travellers = counts(raw.travellers);
  if (travellers) out.travellers = travellers;
  const budgetLevel = nonEmptyStr(raw.budgetLevel, MAX_SHORT_FIELD_CHARS);
  if (budgetLevel !== undefined) out.budgetLevel = budgetLevel;
  const diet = nonEmptyStr(raw.diet, MAX_SHORT_FIELD_CHARS);
  if (diet !== undefined) out.diet = diet;
  const pace = nonEmptyStr(raw.pace, MAX_SHORT_FIELD_CHARS);
  if (pace !== undefined) out.pace = pace;
  if (Array.isArray(raw.interests)) {
    const list: string[] = [];
    for (const i of raw.interests) {
      const s = nonEmptyStr(i, 80);
      if (s !== undefined) list.push(s);
      if (list.length >= MAX_INTERESTS) break;
    }
    out.interests = list;
  }
  return out;
}

/* --------------------------- itinerary ------------------------------ */
function parseStop(raw: unknown): WireStop | null {
  if (!isObj(raw)) return null;
  const time = str(raw.time, 40);
  const title = nonEmptyStr(raw.title, MAX_SHORT_FIELD_CHARS);
  const description = str(raw.description, MAX_TEXT_FIELD_CHARS);
  const cost = num(raw.cost);
  if (time === undefined || title === undefined || description === undefined || cost === undefined) return null;
  const s: WireStop = { time, title, description, cost };
  if (raw.priceSource === "ai" || raw.priceSource === "estimated" || raw.priceSource === "web") {
    s.priceSource = raw.priceSource;
  }
  const sourceHost = nonEmptyStr(raw.sourceHost, MAX_SHORT_FIELD_CHARS);
  if (sourceHost !== undefined) s.sourceHost = sourceHost;
  const checkedAt = nonEmptyStr(raw.checkedAt, 60);
  if (checkedAt !== undefined) s.checkedAt = checkedAt;
  const placeId = nonEmptyStr(raw.placeId, MAX_PLACE_ID_CHARS);
  if (placeId !== undefined) s.placeId = placeId;
  const placeName = nonEmptyStr(raw.placeName, MAX_SHORT_FIELD_CHARS);
  if (placeName !== undefined) s.placeName = placeName;
  const area = nonEmptyStr(raw.area, MAX_SHORT_FIELD_CHARS);
  if (area !== undefined) s.area = area;
  const location = lonLat(raw.location);
  if (location) s.location = location;
  const openingHours = nonEmptyStr(raw.openingHours, MAX_SHORT_FIELD_CHARS);
  if (openingHours !== undefined) s.openingHours = openingHours;
  if (raw.hoursLabel === "Typical hours" || raw.hoursLabel === "Hours not listed") s.hoursLabel = raw.hoursLabel;
  const travel = num(raw.travelToNextMin);
  if (travel !== undefined && travel >= 0 && travel <= 1440) s.travelToNextMin = travel;
  const visit = num(raw.visitMin);
  if (visit !== undefined && visit >= 0 && visit <= 1440) s.visitMin = visit;
  return s;
}

function parseDay(raw: unknown): WireDay | null {
  if (!isObj(raw)) return null;
  const day = int(raw.day, 1, MAX_DAYS);
  const date = str(raw.date, 40);
  const title = str(raw.title, MAX_SHORT_FIELD_CHARS);
  const theme = str(raw.theme, MAX_SHORT_FIELD_CHARS);
  const total = num(raw.total);
  if (day === undefined || date === undefined || title === undefined || theme === undefined || total === undefined) {
    return null;
  }
  if (!Array.isArray(raw.activities) || raw.activities.length > MAX_STOPS_PER_DAY) return null;
  const activities: WireStop[] = [];
  for (const a of raw.activities) {
    const stop = parseStop(a);
    if (!stop) return null;
    activities.push(stop);
  }
  const d: WireDay = { day, date, title, theme, total, activities };
  if (raw.dayTrip === true) d.dayTrip = true;
  return d;
}

function parseItinerary(raw: unknown): WireItinerary | null {
  if (!isObj(raw)) return null;
  const title = str(raw.title, MAX_SHORT_FIELD_CHARS);
  const totalCost = num(raw.totalCost);
  if (title === undefined || totalCost === undefined) return null;
  if (!Array.isArray(raw.days) || raw.days.length < 1 || raw.days.length > MAX_DAYS) return null;
  const days: WireDay[] = [];
  for (const d of raw.days) {
    const day = parseDay(d);
    if (!day) return null;
    days.push(day);
  }
  return { title, totalCost, days };
}

/**
 * Projects a full Itinerary onto the wire shape: drops photos, photoRef,
 * webDetails, mapsUrl, priceBasis and sources. Caps to 30 days and 20 stops
 * per day. Never throws; malformed input yields an empty projection.
 */
export function toWireItinerary(it: Itinerary): WireItinerary {
  const out: WireItinerary = { title: "", totalCost: 0, days: [] };
  try {
    out.title = String(it.title ?? "").slice(0, MAX_SHORT_FIELD_CHARS);
    out.totalCost = Number.isFinite(it.totalCost) ? it.totalCost : 0;
    for (const d of (it.days ?? []).slice(0, MAX_DAYS)) {
      const day: WireDay = {
        day: d.day,
        date: String(d.date ?? ""),
        title: String(d.title ?? ""),
        theme: String(d.theme ?? ""),
        total: Number.isFinite(d.total) ? d.total : 0,
        activities: [],
      };
      if (d.dayTrip === true) day.dayTrip = true;
      for (const a of (d.activities ?? []).slice(0, MAX_STOPS_PER_DAY)) {
        const s: WireStop = {
          time: String(a.time ?? ""),
          title: String(a.title ?? ""),
          description: String(a.description ?? "").slice(0, MAX_TEXT_FIELD_CHARS),
          cost: Number.isFinite(a.cost) ? a.cost : 0,
        };
        if (a.priceSource) s.priceSource = a.priceSource;
        if (a.sourceHost) s.sourceHost = a.sourceHost;
        if (a.checkedAt) s.checkedAt = a.checkedAt;
        if (a.placeId) s.placeId = a.placeId;
        if (a.placeName) s.placeName = a.placeName;
        if (a.area) s.area = a.area;
        if (a.location) s.location = { lat: a.location.lat, lng: a.location.lng };
        if (a.openingHours) s.openingHours = a.openingHours;
        if (a.hoursLabel) s.hoursLabel = a.hoursLabel;
        if (typeof a.travelToNextMin === "number") s.travelToNextMin = a.travelToNextMin;
        if (typeof a.visitMin === "number") s.visitMin = a.visitMin;
        day.activities.push(s);
      }
      out.days.push(day);
    }
  } catch {
    /* return what was built */
  }
  return out;
}

/* ----------------------------- history ------------------------------ */
/** Returns the last `max` turns (default 10). Never mutates the input. */
export function trimHistory(history: readonly ChatTurn[] | undefined | null, max: number = MAX_HISTORY_TURNS): ChatTurn[] {
  if (!Array.isArray(history) || max <= 0) return [];
  return history.slice(-max);
}

function parseHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: ChatTurn[] = [];
  for (const t of raw) {
    if (!isObj(t) || (t.role !== "user" && t.role !== "assistant") || typeof t.text !== "string") continue;
    const text = str(t.text, t.role === "user" ? MAX_MESSAGE_CHARS : MAX_ASSISTANT_TURN_CHARS) ?? "";
    if (text.trim().length === 0) continue;
    turns.push({ role: t.role, text });
  }
  return trimHistory(turns);
}

function parseOffered(raw: unknown): OfferedPlace[] {
  if (!Array.isArray(raw)) return [];
  const out: OfferedPlace[] = [];
  for (const o of raw) {
    if (!isObj(o)) continue;
    const placeId = nonEmptyStr(o.placeId, MAX_PLACE_ID_CHARS);
    const name = nonEmptyStr(o.name, MAX_SHORT_FIELD_CHARS);
    if (placeId !== undefined && name !== undefined) out.push({ placeId, name });
  }
  return out.slice(-MAX_OFFERED);
}

/* --------------------------- parseRequest --------------------------- */
export type ParseRequestResult =
  | { ok: true; value: AssistantRequest }
  | { ok: false; error: string };

/**
 * Validates an unknown request body. `message` is trimmed and must be
 * 1..1000 chars; `itinerary` is required and non-empty; `profile` and
 * `context` are whitelisted; `history` is trimmed to 10 turns; `offered`
 * to 30. Never throws.
 */
export function parseRequest(body: unknown): ParseRequestResult {
  try {
    if (!isObj(body)) return { ok: false, error: "body must be an object" };
    if (typeof body.message !== "string") return { ok: false, error: "message is required" };
    const message = body.message.trim();
    if (message.length < 1) return { ok: false, error: "message is empty" };
    if (message.length > MAX_MESSAGE_CHARS) return { ok: false, error: "message is too long" };
    const itinerary = parseItinerary(body.itinerary);
    if (!itinerary) return { ok: false, error: "itinerary is missing or invalid" };
    const value: AssistantRequest = {
      message,
      history: parseHistory(body.history),
      itinerary,
      context: whitelistContext(body.context),
    };
    const profile = whitelistProfile(body.profile);
    if (profile) value.profile = profile;
    const offered = parseOffered(body.offered);
    if (offered.length > 0) value.offered = offered;
    return { ok: true, value };
  } catch {
    return { ok: false, error: "invalid request" };
  }
}

/** Parses a raw JSON text body with the byte guard first. Never throws. */
export function parseRequestText(text: string): ParseRequestResult {
  if (typeof text !== "string" || !withinByteLimit(text)) return { ok: false, error: "body too large" };
  try {
    return parseRequest(JSON.parse(text));
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
}

/* ----------------------------- proposals ---------------------------- */
function parseEditOp(raw: unknown): EditOp | null {
  if (!isObj(raw)) return null;
  const day = int(raw.day, 1, MAX_DAYS);
  if (day === undefined) return null;
  const idxMax = MAX_STOPS_PER_DAY - 1;
  const time = raw.time === undefined ? undefined : typeof raw.time === "string" && TIME_RE.test(raw.time) ? raw.time : null;
  if (time === null) return null;
  switch (raw.op) {
    case "add": {
      const placeId = nonEmptyStr(raw.placeId, MAX_PLACE_ID_CHARS);
      const index = raw.index === undefined ? undefined : int(raw.index, 0, MAX_STOPS_PER_DAY);
      if (placeId === undefined || (raw.index !== undefined && index === undefined)) return null;
      const op: EditOp = { op: "add", day, placeId };
      if (index !== undefined) op.index = index;
      if (time !== undefined) op.time = time;
      return op;
    }
    case "replace": {
      const index = int(raw.index, 0, idxMax);
      const expectTitle = nonEmptyStr(raw.expectTitle, MAX_SHORT_FIELD_CHARS);
      const placeId = nonEmptyStr(raw.placeId, MAX_PLACE_ID_CHARS);
      if (index === undefined || expectTitle === undefined || placeId === undefined) return null;
      return { op: "replace", day, index, expectTitle, placeId };
    }
    case "remove": {
      const index = int(raw.index, 0, idxMax);
      const expectTitle = nonEmptyStr(raw.expectTitle, MAX_SHORT_FIELD_CHARS);
      if (index === undefined || expectTitle === undefined) return null;
      return { op: "remove", day, index, expectTitle };
    }
    case "move": {
      const index = int(raw.index, 0, idxMax);
      const expectTitle = nonEmptyStr(raw.expectTitle, MAX_SHORT_FIELD_CHARS);
      const toDay = int(raw.toDay, 1, MAX_DAYS);
      const toIndex = raw.toIndex === undefined ? undefined : int(raw.toIndex, 0, MAX_STOPS_PER_DAY);
      if (index === undefined || expectTitle === undefined || toDay === undefined) return null;
      if (raw.toIndex !== undefined && toIndex === undefined) return null;
      const op: EditOp = { op: "move", day, index, expectTitle, toDay };
      if (toIndex !== undefined) op.toIndex = toIndex;
      if (time !== undefined) op.time = time;
      return op;
    }
    case "retime": {
      const index = int(raw.index, 0, idxMax);
      const expectTitle = nonEmptyStr(raw.expectTitle, MAX_SHORT_FIELD_CHARS);
      if (index === undefined || expectTitle === undefined || time === undefined) return null;
      return { op: "retime", day, index, expectTitle, time };
    }
    default:
      return null;
  }
}

function parsePlace(raw: unknown): PlaceRecord | null {
  if (!isObj(raw)) return null;
  const placeId = nonEmptyStr(raw.placeId, MAX_PLACE_ID_CHARS);
  const name = nonEmptyStr(raw.name, MAX_SHORT_FIELD_CHARS);
  const address = str(raw.address, MAX_TEXT_FIELD_CHARS);
  const location = lonLat(raw.location);
  const mapsUrl = str(raw.mapsUrl, 2000);
  if (placeId === undefined || name === undefined || address === undefined || !location || mapsUrl === undefined) {
    return null;
  }
  const p: PlaceRecord = { placeId, name, address, location, mapsUrl };
  const area = nonEmptyStr(raw.area, MAX_SHORT_FIELD_CHARS);
  if (area !== undefined) p.area = area;
  const photoRef = nonEmptyStr(raw.photoRef, 500);
  if (photoRef !== undefined) p.photoRef = photoRef;
  if (Array.isArray(raw.photos)) {
    const photos = raw.photos.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 500).slice(0, 3);
    if (photos.length > 0) p.photos = photos;
  }
  const openingHours = nonEmptyStr(raw.openingHours, MAX_SHORT_FIELD_CHARS);
  if (openingHours !== undefined) p.openingHours = openingHours;
  if (raw.hoursLabel === "Typical hours" || raw.hoursLabel === "Hours not listed") p.hoursLabel = raw.hoursLabel;
  const rating = num(raw.rating);
  if (rating !== undefined && rating >= 0 && rating <= 5) p.rating = rating;
  const visitMin = int(raw.visitMin, 1, 1440);
  if (visitMin !== undefined) p.visitMin = visitMin;
  return p;
}

function parsePrice(raw: unknown): CitedPriceRecord | null {
  if (!isObj(raw)) return null;
  const inr = num(raw.inr);
  const sourceUrl = str(raw.sourceUrl, 2000);
  const sourceHost = nonEmptyStr(raw.sourceHost, MAX_SHORT_FIELD_CHARS);
  const checkedAt = nonEmptyStr(raw.checkedAt, 60);
  const basis = str(raw.basis, MAX_SHORT_FIELD_CHARS);
  if (inr === undefined || inr < 0 || sourceUrl === undefined || !sourceUrl.startsWith("https://")) return null;
  if (sourceHost === undefined || checkedAt === undefined || basis === undefined) return null;
  return { inr, sourceUrl, sourceHost, checkedAt, basis };
}

/**
 * Parses a proposal from a JSON string or an already-parsed value.
 * Returns null for anything invalid. Never throws.
 */
export function parseProposal(input: unknown): EditProposal | null {
  try {
    const raw = typeof input === "string" ? JSON.parse(input) : input;
    if (!isObj(raw) || raw.version !== 1) return null;
    const id = nonEmptyStr(raw.id, 64);
    const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
    if (id === undefined || summary.length < 1 || summary.length > MAX_SUMMARY_CHARS) return null;
    const edit = parseEditOp(raw.edit);
    if (!edit) return null;
    const p: EditProposal = { version: 1, id, summary, edit };
    if (raw.place !== undefined) {
      const place = parsePlace(raw.place);
      if (!place) return null;
      p.place = place;
    }
    if (raw.price !== undefined) {
      const price = parsePrice(raw.price);
      if (!price) return null;
      p.price = price;
    }
    return p;
  } catch {
    return null;
  }
}

function orderedEdit(e: EditOp): Record<string, unknown> {
  switch (e.op) {
    case "add":
      return { op: e.op, day: e.day, index: e.index, time: e.time, placeId: e.placeId };
    case "replace":
      return { op: e.op, day: e.day, index: e.index, expectTitle: e.expectTitle, placeId: e.placeId };
    case "remove":
      return { op: e.op, day: e.day, index: e.index, expectTitle: e.expectTitle };
    case "move":
      return {
        op: e.op,
        day: e.day,
        index: e.index,
        expectTitle: e.expectTitle,
        toDay: e.toDay,
        toIndex: e.toIndex,
        time: e.time,
      };
    case "retime":
      return { op: e.op, day: e.day, index: e.index, expectTitle: e.expectTitle, time: e.time };
  }
}

function orderedPlace(p: PlaceRecord): Record<string, unknown> {
  return {
    placeId: p.placeId,
    name: p.name,
    address: p.address,
    area: p.area,
    location: { lat: p.location.lat, lng: p.location.lng },
    mapsUrl: p.mapsUrl,
    photoRef: p.photoRef,
    photos: p.photos,
    openingHours: p.openingHours,
    hoursLabel: p.hoursLabel,
    rating: p.rating,
    visitMin: p.visitMin,
  };
}

/**
 * Serialises a proposal with a fixed key order (undefined values are
 * omitted by JSON.stringify). `parseProposal(printProposal(p))` equals `p`
 * for any valid proposal. Never throws; returns "" on failure.
 */
export function printProposal(p: EditProposal): string {
  try {
    return JSON.stringify({
      version: p.version,
      id: p.id,
      summary: p.summary,
      edit: orderedEdit(p.edit),
      place: p.place ? orderedPlace(p.place) : undefined,
      price: p.price
        ? {
            inr: p.price.inr,
            sourceUrl: p.price.sourceUrl,
            sourceHost: p.price.sourceHost,
            checkedAt: p.price.checkedAt,
            basis: p.price.basis,
          }
        : undefined,
    });
  } catch {
    return "";
  }
}
