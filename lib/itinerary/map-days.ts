/**
 * Pure mapping of the Scheduler, Enrichment and Polish results to TripDay[].
 * No I/O, no clock, no server-only imports (type imports are erased).
 *
 * - Every data field comes from the Place_Candidate with the same placeId.
 * - A price is set only from an accepted web price. No category, no AI estimate.
 * - A Stop without an accepted price has cost 0 and no priceSource.
 */
import type { PlaceCandidate } from "../providers/google-places";
import { MAX_SOURCES } from "../grounding/sources";
import type { Activity, SourceLink, TripDay } from "../types";
import type { EnrichedStop } from "./enrichment";
import type { FallbackOutcome } from "./price-fallback";
import { buildMapsUrl } from "./maps-link";
import { MAX_PHOTOS_PER_STOP, TITLE_CHARS } from "./constants";
import { nameKey } from "./place-key";
import { areaOfAddress, fallbackTitle, type PolishApplied, type PolishAppliedStop } from "./polish-check";
import type { ScheduleResult } from "./scheduler";
import { sanitizeDisplayText } from "./text";

const ARRIVAL_WORDING = /arrival day|departure day/i;
const AREA_CHARS = 60;
const PLACE_CHARS = 100;
const DESC_CHARS = 160;

/** One day to map: `title` null means the Plain_Itinerary title. */
export interface MapDayIn {
  day: number;
  title: string | null;
  stops: PolishAppliedStop[];
  dayTrip?: boolean;
}

export interface MapDaysInput {
  days: readonly MapDayIn[];
  /** Keyed by placeId. Missing entries mean "not checked", no price. */
  enrichment?: ReadonlyMap<string, EnrichedStop>;
  /** Accepted source links (enrichment.sources); filtered to those the built Stops use. */
  sources?: readonly SourceLink[];
  startDate?: string;
  destination?: string;
  /** selectedFlight.date, yyyy-mm-dd. */
  flightDate?: string;
  /** EnrichmentResult.unavailable: every sent search failed. Marks unchecked stops. */
  enrichmentUnavailable?: boolean;
  /**
   * Price fallback outcome. A placeId in `unverified` keeps cost 0 and no priceSource;
   * every Stop with an entry in `fallback` gets `priceFallback`.
   */
  fallback?: FallbackOutcome;
}

export interface MapDaysResult {
  days: TripDay[];
  sources: SourceLink[];
  /** Stops without an accepted web price, over all built days. */
  unpriced: number;
  /** Same count per day number. */
  unpricedByDay: Record<number, number>;
}

export function isoDatePlus(start: string | undefined, offsetDays: number): string {
  if (typeof start !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return "";
  const t = Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1, Number(start.slice(8, 10)));
  const d = new Date(t + offsetDays * 86_400_000);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function hhmm(min: number): string {
  const m = Math.max(0, Math.min(23 * 60 + 59, Math.round(min)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Plain_Itinerary input: the Scheduler order and times, no title, no sentence. */
export function plainDays(schedule: ScheduleResult, pool: readonly PlaceCandidate[]): MapDayIn[] {
  const byId = new Map<string, PlaceCandidate>();
  for (const c of pool) if (c && typeof c.placeId === "string" && !byId.has(c.placeId)) byId.set(c.placeId, c);
  const out: MapDayIn[] = [];
  for (const d of schedule.days) {
    const stops: PolishAppliedStop[] = [];
    for (const s of d.stops) {
      const candidate = byId.get(s.placeId);
      if (candidate) stops.push({ candidate, sentence: "", scheduled: s });
    }
    out.push({ day: d.day, title: null, stops });
  }
  return out;
}

/** Adapts an accepted polish to map input; titles are kept (checked again for uniqueness). */
export function polishedDays(applied: PolishApplied): MapDayIn[] {
  return applied.days.map((d) => ({ day: d.day, title: d.title, stops: d.stops }));
}

function distinctAreas(areas: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of areas) {
    const k = nameKey(a);
    if (!a || !k || seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

export function mapDays(input: MapDaysInput): MapDaysResult {
  const days: TripDay[] = [];
  const taken = new Set<string>();
  const used = new Set<string>();
  const unpricedByDay: Record<number, number> = {};
  let unpriced = 0;
  const flight = input.flightDate;

  for (const d of input.days) {
    const timed = d.stops.filter((s) => s.candidate && s.scheduled);
    if (timed.length === 0) continue;
    const date = isoDatePlus(input.startDate, d.day - 1);

    const areas = timed.map((s) =>
      sanitizeDisplayText(areaOfAddress(s.candidate.address, input.destination), AREA_CHARS),
    );

    let dayUnpriced = 0;
    const activities: Activity[] = timed.map((s, i) => {
      const c = s.candidate;
      const sc = s.scheduled!;
      const name = sanitizeDisplayText(c.name, PLACE_CHARS);
      const e = input.enrichment?.get(c.placeId);
      const price = input.fallback?.unverified.has(c.placeId) ? undefined : e?.price;
      const act: Activity = {
        time: hhmm(sc.startMin),
        title: name,
        description: sanitizeDisplayText(s.sentence, DESC_CHARS),
        cost: 0,
        area: areas[i],
        placeId: c.placeId,
        placeName: name,
        verified: true,
        mapsUrl: buildMapsUrl(c.placeId, name),
        location: { lat: c.location.lat, lng: c.location.lng },
      };
      const photos = (Array.isArray(c.photos) ? c.photos : [])
        .filter((p): p is string => typeof p === "string" && p !== "")
        .slice(0, MAX_PHOTOS_PER_STOP);
      if (photos.length > 0) {
        act.photos = photos;
        act.photoRef = photos[0];
      }
      if (sc.hoursText) act.openingHours = sc.hoursText;
      if (sc.hoursLabel) act.hoursLabel = sc.hoursLabel;
      if (typeof sc.travelToNextMin === "number" && Number.isFinite(sc.travelToNextMin)) {
        act.travelToNextMin = Math.max(0, Math.round(sc.travelToNextMin));
      }
      if (Number.isInteger(sc.visitMin) && sc.visitMin >= 1 && sc.visitMin <= 1440) {
        act.visitMin = sc.visitMin;
      }
      if (e) {
        act.webDetails =
          input.enrichmentUnavailable === true && e.webDetails.checked === false
            ? { ...e.webDetails, unavailable: true }
            : e.webDetails;
      }
      if (price) {
        act.cost = Math.max(0, Math.round(price.inr));
        act.costBasis = "person";
        act.costClass = price.kind === "typical" ? "meal" : price.inr === 0 ? "free-sight" : "paid-sight";
        act.priceSource = "web";
        act.priceBasis = price.basis;
        act.sourceUrl = price.sourceUrl;
        act.sourceHost = price.sourceHost;
        act.checkedAt = price.checkedAt;
        used.add(price.sourceUrl);
      } else {
        dayUnpriced += 1;
      }
      const fb = input.fallback?.fallback.get(c.placeId);
      if (fb) act.priceFallback = fb;
      for (const k of ["tip", "booking", "bestTime"] as const) {
        const w = e?.webDetails[k];
        if (w) used.add(w.sourceUrl);
      }
      return act;
    });

    // Title: accepted polish title, else "<area> day" / "Day <n>"; always distinct.
    let title: string;
    const raw = d.title === null ? "" : sanitizeDisplayText(d.title, TITLE_CHARS);
    const key = nameKey(raw);
    const wordingOk = !ARRIVAL_WORDING.test(raw) || (!!flight && date === flight);
    if (raw && key && wordingOk && !taken.has(key)) {
      taken.add(key);
      title = raw;
    } else {
      title = fallbackTitle(areas[0] ?? "", d.day, taken);
    }

    const day: TripDay = {
      day: d.day,
      date,
      title,
      theme: distinctAreas(areas).slice(0, 3).join(" · "),
      activities,
      total: activities.reduce((n, a) => n + a.cost, 0),
    };
    if (d.dayTrip) day.dayTrip = true;
    days.push(day);
    unpricedByDay[d.day] = dayUnpriced;
    unpriced += dayUnpriced;
  }

  const sources: SourceLink[] = [];
  for (const s of input.sources ?? []) {
    if (sources.length >= MAX_SOURCES) break;
    if (used.has(s.url) && !sources.some((x) => x.url === s.url)) sources.push(s);
  }
  return { days, sources, unpriced, unpricedByDay };
}

/** stats.proposed = candidates found (after de-duplication by placeId), verified = Stops built. */
export function batchStats(
  proposed: number,
  days: readonly TripDay[],
  ms: number,
): { proposed: number; verified: number; removed: number; ms: number } {
  const verified = days.reduce((n, d) => n + d.activities.length, 0);
  const p = Number.isFinite(proposed) ? Math.max(0, Math.round(proposed)) : 0;
  return { proposed: p, verified, removed: Math.max(0, p - verified), ms: Math.max(0, Math.round(ms)) };
}
