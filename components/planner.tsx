"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { parseRoute, emptyRouteState, routeConfirmed as _rc } from "@/lib/route-intake";
import { resolveTripLength } from "@/lib/itinerary/trip-length";
import { resolveTripDates, endFromDays } from "@/lib/itinerary/trip-dates";
import { durationFromText } from "@/lib/date-intake";
import { MAX_TRIP_DAYS } from "@/lib/itinerary/constants";
import { flightOfferFare, type WorkspaceState } from "@/lib/workspace";
import { buildItineraryPdf } from "@/lib/pdf";
import { computeSummary, priceSourceCounts, formatSourceCounts, unpricedStopCount, hasWebDetails, itineraryHasWebDetails } from "@/lib/trip-summary";
import { classifyFlightAvailability, isNoFlightRoute, GROUND_TRANSPORT_NOTE, type FlightAvailability } from "@/lib/flight-availability";
import {
  resolveUsdInr, normalizeItineraryToInr, restampItineraryDates, toPricerRequest,
  applyPriceResults, applyRouteFare, withEstimatedActivity, priceLabel, formatInr,
} from "@/lib/itinerary-inr";
import { USD_INR_FALLBACK, MAX_ACTIVITIES } from "@/lib/activity-pricer";
import { removeActivityAt, appendActivity } from "@/lib/itinerary/day-edit";
import { ESTIMATED_BASIS } from "@/lib/price-validator";
import { webAmountText } from "@/lib/web-price-format";
import { SourceLink as PriceSourceLink, CheckedAt, RouteFareLine } from "@/components/web-price-bits";
import { resolveBudgetLevel, resolveCityTier } from "@/lib/cost-caps";
import type { PriceResult } from "@/lib/activity-pricer";
import { illustration } from "@/lib/illustrations";
import { useTripContext } from "@/components/trip-context";
import { plannerDecision, type PlanSignal } from "@/lib/history/draft-gating";
import { saveLocal } from "@/lib/history/local-store";
import { useDestinationImage } from "@/components/destination-image";
import EditDayPanel from "@/components/edit-day-panel";
import DayDetailModal from "@/components/day-detail-modal";
import GamificationPanel from "@/components/gamification-panel";
import { useAccountXp } from "@/lib/client/use-account-xp";
import { emptyXp, award, type XpState, type XpEvent } from "@/lib/gamification";
import type { Activity, Itinerary, TripContext } from "@/lib/types";
import { serializeCriteria } from "@/lib/search-criteria";
import type { LiveHotel } from "@/lib/providers/serpapi-hotels";
import type { LiveFlight, PriceInsights } from "@/lib/providers/serpapi-flights";
import { checkedLabel as fmtCheckedLabel, todayIst } from "@/lib/ist-time";
import { planStartDateWrite } from "@/lib/start-date";
import { formatTripPreview } from "@/lib/trip-preview";
import type { FlightBookingCriteria } from "@/components/flight-booking-panel";
import BrandLoader from "@/components/brand-loader";
import TravelFacts from "@/components/travel-facts";
import SourcesList from "@/components/sources-list";
import { batchReducer, initBatchState, nextSlot, buildRequest, tripKeyOf } from "@/lib/itinerary/planner-batches";
import { beginGeneration, endGeneration, isGenerationActive } from "@/lib/itinerary/generation-session";
import { postBatch } from "@/lib/itinerary/batch-client";
import { classifyExit, scheduleUnmountAbort } from "@/lib/itinerary/generation-lifecycle";
import { unavailable } from "@/lib/itinerary/batch-wire";
import { mergeBatch, settlePending, buildTimeline, hasVerificationData, isComplete } from "@/lib/itinerary/completeness";
import { DayCarousel } from "@/components/day-carousel";
import { Toast } from "@/components/toast";
import { toastForSave, saveFingerprint, shouldSkipSave, type SaveOutcome, type ToastModel } from "@/lib/save-feedback";
import { fetchSession, subscribeSession, handleUnauthorized } from "@/lib/client/account-session";
import { setSyncSaving, setSyncSaved, setSyncFailed, setSyncUnavailable } from "@/lib/client/use-sync-status";
import { StopDetails } from "@/components/stop-details";
import { stopKey, isStopOpen, toggleStop, type StopOpenMap } from "@/lib/itinerary/stop-expand";
import { useMiscEstimates, miscKeyForDay } from "@/components/use-misc-estimate";
import { MiscLine } from "@/components/misc-line";
import { buildCostBreakdown } from "@/lib/cost-breakdown";
import { CostBreakdown } from "@/components/cost-breakdown";
import { ItinerarySearch } from "@/components/itinerary-search";
import { Highlight } from "@/components/highlight";
import { filterItinerary } from "@/lib/itinerary/search";
import { selectSlides, chooseDayMedia, formatTimeRange } from "@/lib/itinerary/carousel";
import { LIMIT_NOTE, dateSpanNotice, TOTAL_NOTE, activitiesLabel, progressText, verifiedLabel, stopsLabel, unpricedLabel, priceBadgeText, ACTIVITIES_WEB_ONLY_LABEL } from "@/lib/itinerary/labels";
import { ItineraryFailure, ItineraryBanner, DayHero, StopMeta, PriceCellNote, PlaceholderCard } from "@/components/itinerary-parts";
import type { SourceLink } from "@/lib/types";
import TripAssistant from "@/components/trip-assistant";
import type { AppliedEdit } from "@/lib/assistant/types";

const undatedNote = (n: number) => (n === 1 ? "Planned as Day 1 without calendar dates." : `Planned as Day 1 to Day ${n} without calendar dates.`);
const isUndatedNote = (s: string) => /^Planned as Day 1( to Day \d+)? without calendar dates\.$/.test(s);

/** Attach grounding sources; returns the same object when there are none. */
function withSources(it: Itinerary, links: SourceLink[]): Itinerary {
  return links.length === 0 ? it : { ...it, sources: links };
}

const INR = (n: number) => `INR ${n.toLocaleString("en-IN")}`;
const INR_FMT = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
/** Live stays + flights fetched for the generated trip (see /api/trip-live). */
type TripLiveStatus = "idle" | "loading" | "ready" | "error";
interface TripLive {
  status: TripLiveStatus;
  stays: LiveHotel[];
  flights: LiveFlight[];
  staysHref: string;
  flightsHref: string;
  note: string | null;
  /** Live provenance + criteria needed to render the full inline result cards. */
  staysProvider: string;
  staysCurrency: string;
  flightsProvider: string;
  flightsCurrency: string;
  checkedAt: string;
  checkedLabel: string;
  nights: number;
  insights: PriceInsights | null;
  staysCriteria: { destination: string; checkIn: string; checkOut: string; adults: number; rooms: number } | null;
  flightsCriteria: FlightBookingCriteria | null;
}

/** Default TripLive with no results loaded (all provenance fields blank). */
const EMPTY_LIVE: TripLive = {
  status: "idle", stays: [], flights: [], staysHref: "/stays", flightsHref: "/flights",
  note: null, staysProvider: "", staysCurrency: "INR", flightsProvider: "", flightsCurrency: "INR",
  checkedAt: "", checkedLabel: "", nights: 1, insights: null, staysCriteria: null, flightsCriteria: null,
};

/** Derive the best REAL place query for a day so the media shows the main landmark covered that day and every day resolves an image. */
function dayPlaceQuery(day: { title: string; activities: { title: string }[] }, destination: string): string {
  const dest = destination.trim();
  let core = day.title && day.title.trim().length > 0 ? day.title.trim() : "";
  const generic = /^(arrival|arrive|departure|depart|free day|leisure|checkout|check-in|rest)\b/i;
  if (!core || generic.test(core)) {
    const best = [...day.activities].map((a) => (a.title ? a.title.trim() : "")).filter((s) => s.length > 0).sort((a, b) => b.length - a.length)[0];
    if (best) core = best;
  }
  if (!core) core = dest;
  return (core + " " + dest).trim();
}

/** Marker illustration reused for every day node (Req 12.2, 17.5). */
const LOCATION_PIN = illustration("location-pin");

/** Deterministic, SSR-safe short-date formatter for a stored ISO `yyyy-mm-dd`.
 *  Parses only the stored string (NO Date.now()/new Date() of "now"), so server
 *  and client render identically — no hydration mismatch. Returns "" if the
 *  input is not a well-formed ISO date (fallback handled by the caller). */
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatShortDate(iso: string | undefined): string {
  if (typeof iso !== "string") return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return "";
  const month = Number(m[2]);
  const dayNum = Number(m[3]);
  if (month < 1 || month > 12 || dayNum < 1 || dayNum > 31) return "";
  return `${dayNum} ${SHORT_MONTHS[month - 1]}`;
}

/** Build the human date range for the cover from the itinerary's stored day
 *  dates. Uses ONLY the real `TripDay.date` values already present in the data
 *  (never fabricates calendar dates in render). Returns "" when absent. */
function coverDateRange(days: ReadonlyArray<{ date?: string }>): string {
  if (days.length === 0) return "";
  const start = formatShortDate(days[0]?.date);
  const end = formatShortDate(days[days.length - 1]?.date);
  if (start && end) return start === end ? start : `${start} – ${end}`;
  return start || end || "";
}

/**
 * TripCover — the premium itinerary cover (Req 6.1). A full-width, aspect-
 * reserved `.image-frame` with a REAL destination image fetched through the
 * existing `/api/image` route via `useDestinationImage` (gradient/illustration
 * fallback when none resolves, so there is never a broken image or CLS). The
 * serif trip title, destination, dates, travellers, and day-count metadata are
 * overlaid on the existing `--gradient-image-scrim`. Every field shown is drawn
 * from data that ALREADY EXISTS in the planner — no field is invented.
 */
function TripCover({
  title,
  destination,
  origin,
  dateRange,
  dayCount,
  travellers,
}: {
  title: string;
  destination: string;
  origin: string;
  dateRange: string;
  dayCount: number;
  travellers: number;
}) {
  const query = destination.trim() || title.trim() || "travel destination";
  const { url, srcSet, alt, onError } = useDestinationImage(query, 0, "cover");
  return (
    <header className="trip-cover reveal" aria-label="Trip overview">
      <div className="trip-cover__frame image-frame">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="trip-cover__img" srcSet={srcSet} src={url} alt={alt} onError={onError} />
        ) : (
          // Illustration/token fallback — never a broken image (Req 6.1 / 10.4).
          <div className="trip-cover__fallback" aria-hidden="true" />
        )}
        <div className="trip-cover__scrim" aria-hidden="true" />
        <div className="trip-cover__content">
          <p className="trip-cover__eyebrow">
            {origin.trim() ? `${origin.trim()} → ${destination || "your destination"}` : "Your itinerary"}
          </p>
          <h2 className="trip-cover__title">{title}</h2>
          <dl className="trip-cover__meta">
            {destination.trim() && (
              <div className="trip-cover__meta-item">
                <dt>Destination</dt>
                <dd>{destination.trim()}</dd>
              </div>
            )}
            {dateRange && (
              <div className="trip-cover__meta-item">
                <dt>Dates</dt>
                <dd>{dateRange}</dd>
              </div>
            )}
            <div className="trip-cover__meta-item">
              <dt>Length</dt>
              <dd>{dayCount} {dayCount === 1 ? "day" : "days"}</dd>
            </div>
            <div className="trip-cover__meta-item">
              <dt>Travellers</dt>
              <dd>{travellers} {travellers === 1 ? "traveller" : "travellers"}</dd>
            </div>
          </dl>
        </div>
      </div>
    </header>
  );
}

/** Assistant conversation states (Req 11.3): idle -> generating -> done | error. */
type AssistantStatus = "idle" | "generating" | "done" | "error";

/** Activity pricing request state (non-blocking indicator). */
type PricingStatus = "idle" | "loading" | "done" | "failed";

/** Base flight/stay fares used to seed and re-price the workspace. */
const BASE_FLIGHT = 30000;

/** A day under edit: which day number and the draft title/theme fields. */
type DayEdit = { day: number; title: string; theme: string };

export default function Planner({ resultsOnly = false }: { resultsOnly?: boolean } = {}) {
  const router = useRouter();
  const [request, setRequest] = useState("Goa from Delhi");
  const [duration, setDuration] = useState("4 days");
  const [travellers, setTravellers] = useState(2);
  const [vibe, setVibe] = useState("Culture & food");
  const [state, setState] = useState<WorkspaceState | null>(null);
  // Live fare inputs for the Pricing Engine. Seeded with the base fallback and
  // replaced by the cheapest live SerpApi flight/stay once /api/trip-live
  // returns, so the trip summary reflects real, current prices.
  const [liveFare, setLiveFare] = useState({ perPerson: BASE_FLIGHT, stay: 0, stayRate: null as number | null, flightLive: false, stayLive: false, noFlight: false });
  const liveFareRef = useRef(liveFare);
  // Flight availability for the current route (Req 9, 10). "none" = no-airport or
  // no live flights for the dates: no fares, flight line is 0, no BASE_FLIGHT.
  const [flightMode, setFlightMode] = useState<"unknown" | "available" | "none">("unknown");
  const [flightAvail, setFlightAvail] = useState<FlightAvailability | null>(null);
  const noFlight = flightMode === "none";
  // USD->INR rate, resolved ONCE (3s guard). "fallback" mode or a bad rate is
  // ignored by resolveUsdInr and replaced by USD_INR_FALLBACK (C10).
  const usdInrRef = useRef(USD_INR_FALLBACK);
  const ratePromiseRef = useRef<Promise<number> | null>(null);
  function getRate(): Promise<number> {
    if (!ratePromiseRef.current) {
      const fetched = fetch("/api/currency?from=USD&to=INR", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => resolveUsdInr(d).usdInr)
        .catch(() => USD_INR_FALLBACK);
      const guard = new Promise<number>((resolve) => { setTimeout(() => resolve(USD_INR_FALLBACK), 3000); });
      ratePromiseRef.current = Promise.race([fetched, guard]).then((rate) => { usdInrRef.current = rate; return rate; });
    }
    return ratePromiseRef.current;
  }
  useEffect(() => { void getRate(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Activity pricing (one batched Bedrock request per generation).
  const [pricing, setPricing] = useState<PricingStatus>("idle");
  // Per-batch pricing: keys already requested, keys in flight, and how many succeeded.
  const pricedKeysRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef<Set<string>>(new Set());
  const pricedOkRef = useRef(0);
  const stateRef = useRef<WorkspaceState | null>(null);
  const [openBasis, setOpenBasis] = useState<Record<string, boolean>>({});
  const [openStops, setOpenStops] = useState<StopOpenMap>({});
  const [error, setError] = useState("");
  const [route, setRoute] = useState(emptyRouteState());
  const [status, setStatus] = useState<AssistantStatus>("idle");
  const [editing, setEditing] = useState<DayEdit | null>(null);
  // No-phantom-auto-load (R6): true when the on-mount decision resolves to
  // "empty-start" (or a user-initiated generate ultimately yields nothing
  // usable), so the planner renders an explicit start prompt and NEVER
  // fabricates an itinerary. Set only by the decision logic below.
  const [showEmptyStart, setShowEmptyStart] = useState(false);
  // Which day (number) currently has the Edit Day panel open, and which has the Know More modal open.
  const [editDayOpen, setEditDayOpen] = useState<number | null>(null);
  const [knowMoreDay, setKnowMoreDay] = useState<number | null>(null);
  // Progressive, batch-wise generation state (trustworthy-itinerary). Task 7.3 adds the
  // driver effect that requests the later batches; 7.5 renders `expanded`; 7.3 uses
  // `retryBusy` and `focusDayRef` for the per-day Retry handlers.
  const [batchState, dispatch] = useReducer(batchReducer, undefined, initBatchState);
  const abortRef = useRef<AbortController | null>(null);
  // Mount tracking. Declared with its effect right here, BEFORE the on-mount
  // decision effect below, so mountedRef is already true when generate() starts.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      scheduleUnmountAbort(() => mountedRef.current, () => {
        abortRef.current?.abort();
        abortRef.current = null;
        launchedRef.current = "";
      });
    };
  }, []);
  const [progressMsg, setProgressMsg] = useState("");
  const [retryBusy, setRetryBusy] = useState<Record<string, boolean>>({});
  const focusDayRef = useRef<number | null>(null);
  const [limitNote, setLimitNote] = useState(false);
  const [dateNote, setDateNote] = useState("");
  /** Add a real named place (from Edit Day suggestions) as a new activity on a day. */
  /** Remove an activity (place) from a day by index, then re-price. */
  function removeDayActivity(dayNum: number, index: number) {
    if (!state) return;
    const itinerary: Itinerary = removeActivityAt(state.itinerary, dayNum, index);
    setState(reprice(itinerary));
  }

  /** Trip Assistant: apply a validated itinerary through the same state path as Edit Day. */
  function applyAssistantProposal(next: Itinerary, _inverse: AppliedEdit) {
    setState(reprice(next));
  }

  /** Trip Assistant undo: restore the previous itinerary. */
  function restoreAssistantItinerary(prev: Itinerary) {
    setState(reprice(prev));
  }

  function addNamedPlace(dayNum: number, placeName: string) {
    if (!state) return;
    const dest = route.destination || sharedContext.context.destination || "";
    const base: Activity = { time: "Flexible", title: placeName, description: "Added from Edit Day suggestions.", cost: 0 };
    const itinerary: Itinerary = appendActivity(
      state.itinerary,
      dayNum,
      withEstimatedActivity(base, dest, usdInrRef.current, costOpts()),
    );
    setState(reprice(itinerary));
  }

    // The single Shared_Trip_Context carried across pages (realtime-ai task 11.1).
  const sharedContext = useTripContext();
  // Travellers and rooms used for every price, criteria, and request (Req 5).
  const ctxTravellers = sharedContext.context.travellers;
  const travellersCount = Math.max(1, Math.trunc(Number(ctxTravellers ? ctxTravellers.adults + ctxTravellers.children : travellers)) || 1);
  const ctxRooms = Number((sharedContext.context as { rooms?: unknown }).rooms);
  const roomsDerived = !(Number.isInteger(ctxRooms) && ctxRooms >= 1);
  const roomsCount = roomsDerived ? Math.max(1, Math.ceil(travellersCount / 2)) : ctxRooms;
  // Deterministic, idempotent gamification state for this planning session.
  // XP lives on the account (server-validated); guests earn nothing.
  const [sessionSignedIn, setSessionSignedIn] = useState<boolean | null>(null);
  const accountXp = useAccountXp(sessionSignedIn);
  const xp: XpState = accountXp.state ?? emptyXp();
  function earn(event: XpEvent) {
    void accountXp.award(event, `${event}:${draftIdRef.current}`);
  }

  // Save-to-account state. A stable per-session draft id keeps saves idempotent
  // (saving twice updates the same record rather than duplicating).
  const draftIdRef = useRef<string>("");
  if (!draftIdRef.current) {
    draftIdRef.current =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `draft-${Date.now()}`;
  }
  const [toast, setToast] = useState<ToastModel | null>(null);
  // Bumped per generate(): resets the Trip Assistant transcript and undo history.
  const assistantGenRef = useRef(0);
  const startDateRef = useRef<HTMLInputElement | null>(null);
  const toastIdRef = useRef(0);
  const lastSavedFpRef = useRef<string | null>(null);
  function notify(outcome: SaveOutcome) {
    const next = toastForSave(toastIdRef.current, outcome);
    toastIdRef.current = next.id;
    setToast(next);
  }
  const [saving, setSaving] = useState(false);
  // Live stays + flights for the generated trip (auto-fetched once ready).
  const [live, setLive] = useState<TripLive>(EMPTY_LIVE);

  // Signed-in state comes from the server session (account-session helpers),
  // kept in a ref: null until the first answer arrives.
  const signedInRef = useRef<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchSession().then((s) => {
      if (alive) {
        signedInRef.current = s.signedIn;
        setSessionSignedIn(s.signedIn);
      }
    });
    const unsub = subscribeSession((s) => {
      signedInRef.current = s.signedIn;
      setSessionSignedIn(s.signedIn);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  /**
   * Save the current itinerary to the user's account via POST /api/trips, which
   * persists through the DynamoDB-backed Trip_Store (the newest five trips are
   * kept) - not just browser-local. The owner is derived server-side from the
   * session cookie, so no owner or user id is sent. Signed-out users, and
   * 401/503 responses, fall back to the device-local save with an honest toast.
   */
  async function saveTrip() {
    // Partial trips save as drafts; pending days are settled so none are persisted as pending.
    const savedItinerary = state ? settlePending(state.itinerary) : null;
    const savedStatus = state && isComplete(state.itinerary) ? "ready" : "draft";
    if (!state || saving) return;
    const fp = saveFingerprint({ name: state.itinerary.title, status: savedStatus, itinerary: savedItinerary ?? state.itinerary });
    if (shouldSkipSave(lastSavedFpRef.current, fp)) {
      notify({ kind: "unchanged" });
      return;
    }
    setSaving(true);
    let signedIn = signedInRef.current;
    if (signedIn === null) {
      signedIn = (await fetchSession()).signedIn;
      signedInRef.current = signedIn;
    }
    if (!signedIn) {
      // Guests (no signed-in session) save to the device-local store so Save always works.
      try {
        saveLocal({
          owner: "@local",
          clientDraftId: draftIdRef.current,
          name: state.itinerary.title,
          status: savedStatus,
          payload: {
            destination: route.destination || sharedContext.context.destination || "",
            origin: route.origin || sharedContext.context.origin || "",
            days: state.itinerary.days.length,
            totalCost: state.itinerary.totalCost,
            pricing: state.pricing,
            itinerary: savedItinerary ?? state.itinerary,
          },
        });
        earn("trip_confirmed");
        lastSavedFpRef.current = fp;
        notify({ kind: "saved", scope: "device" });
      } catch {
        notify({ kind: "failed" });
      } finally {
        setSaving(false);
      }
      return;
    }
    setSyncSaving();
    try {
      const res = await fetch("/api/trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "save",
          clientDraftId: draftIdRef.current,
          name: state.itinerary.title,
          status: savedStatus,
          payload: {
            destination: route.destination || sharedContext.context.destination || "",
            origin: route.origin || sharedContext.context.origin || "",
            days: state.itinerary.days.length,
            totalCost: state.itinerary.totalCost,
            pricing: state.pricing,
            itinerary: savedItinerary ?? state.itinerary,
          },
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { persisted?: boolean; error?: string };
      if (res.ok && data.persisted) {
        // Sync status is shown only after the Trips_API confirms the save.
        setSyncSaved();
        earn("trip_confirmed");
        lastSavedFpRef.current = fp;
        notify({ kind: "saved", scope: "account" });
      } else if (res.status === 401 || res.status === 503) {
        if (res.status === 401) {
          handleUnauthorized();
          signedInRef.current = false;
          setSyncFailed(undefined, "Signed out. Saved on this device only.");
        } else {
          setSyncUnavailable("Account saving is unavailable. Saved on this device only.");
        }
        try {
          saveLocal({
            owner: "@local",
            clientDraftId: draftIdRef.current,
            name: state.itinerary.title,
            status: savedStatus,
            payload: {
              destination: route.destination || sharedContext.context.destination || "",
              origin: route.origin || sharedContext.context.origin || "",
              days: state.itinerary.days.length,
              totalCost: state.itinerary.totalCost,
              pricing: state.pricing,
              itinerary: savedItinerary ?? state.itinerary,
            },
          });
          earn("trip_confirmed");
          lastSavedFpRef.current = fp;
          notify({ kind: "saved", scope: "device" });
        } catch {
          notify({ kind: "failed" });
        }
      } else {
        setSyncFailed(() => void saveTrip());
        notify({ kind: "failed", reason: data.error });
      }
    } catch {
      setSyncFailed(() => void saveTrip());
      notify({ kind: "failed" });
    } finally {
      setSaving(false);
    }
  }
  // On-mount planning decision (no-phantom-auto-load fix, R6). Instead of the
  // old "generate() when /itinerary has no stored itinerary" branch (which
  // fabricated an itinerary on an empty visit), we compute a PlanSignal from
  // the Shared_Trip_Context and the current route and defer to the pure
  // `plannerDecision` predicate:
  //   "show-stored"  -> re-price and show the already-generated itinerary
  //                     (the prior stored-itinerary behavior, unchanged).
  //   "generate"     -> call generate() (only reached when userInitiated).
  //   "empty-start"  -> render the Empty_Start_State; NEVER call generate().
  // The route is derived from `resultsOnly`: resultsOnly -> "/itinerary", else
  // "/trip". The one-shot `autoRanRef` guard is preserved, and the hydration
  // tick is still handled: the Shared_Trip_Context rehydrates from
  // sessionStorage a tick AFTER this component mounts, so when the context has
  // not hydrated yet (no destination, no stored itinerary, no userInitiated
  // flag) we clear the guard and bail so the decision re-runs once the context
  // appears. An empty visit (no userInitiated, no stored itinerary) lands on
  // "empty-start" and never calls generate().
  const autoRanRef = useRef(false);
  useEffect(() => {
    if (autoRanRef.current) return;

    const routeStr = resultsOnly ? "/itinerary" : "/trip";
    const stored = sharedContext.itinerary;
    const hasStoredItinerary = Boolean(
      stored && Array.isArray(stored.days) && stored.days.length > 0,
    );
    const hasContextDestination = Boolean(
      sharedContext.context.destination &&
        sharedContext.context.destination.trim(),
    );
    const userInitiated = sharedContext.userInitiated === true;

    // Hydration tick: if nothing has arrived yet (no stored itinerary, no
    // destination, and not user-initiated), the context likely has not
    // rehydrated. Leave the guard unset so this effect re-evaluates once the
    // context appears, rather than prematurely landing on "empty-start".
    if (!hasStoredItinerary && !hasContextDestination && !userInitiated) {
      autoRanRef.current = false;
      setShowEmptyStart(true);
      return;
    }

    autoRanRef.current = true;

    const signal: PlanSignal = {
      route: routeStr,
      userInitiated,
      hasStoredItinerary,
      hasContextDestination,
    };
    const decision = plannerDecision(signal);

    if (decision === "show-stored") {
      // Prefer the already-generated itinerary stored in the shared context so
      // the plan is shown INSTANTLY and never vanishes on re-render - we do NOT
      // call the LLM again here.
      if (stored && Array.isArray(stored.days) && stored.days.length > 0) {
        setShowEmptyStart(false);
        // Pending days: continue this session's generation (driver effect), or
        // settle them as withheld (with Retry) when no generation is active.
        let shown: Itinerary = stored;
        const pendingDays = stored.completeness?.pendingDays;
        if (Array.isArray(pendingDays) && pendingDays.length > 0) {
          const resumeKey = tripKeyOf({
            ...sharedContext.context,
            durationDays: stored.completeness?.requestedDays,
            interests: sharedContext.context.interests ?? [vibe],
          });
          if (isGenerationActive(resumeKey)) {
            dispatch({ type: "resume", tripKey: resumeKey, itinerary: stored });
          } else {
            shown = settlePending(stored);
            sharedContext.setItinerary(shown);
          }
        }
        if (shown.costUnit === "inr") {
          // Already normalised (and possibly AI-priced): show exactly as stored.
          setState(reprice(shown));
          setStatus("done");
        } else {
          // Legacy itinerary: convert to INR exactly once, then price it.
          void (async () => {
            const it = await prepareItinerary(shown);
            setState(reprice(it));
            sharedContext.setItinerary(it);
            setStatus("done");
            startPricing(it, sharedContext.context.destination ?? "");
          })();
        }
        if (sharedContext.context.destination || sharedContext.context.origin) {
          setRoute((prev) => ({
            ...prev,
            destination: sharedContext.context.destination ?? prev.destination,
            origin: sharedContext.context.origin ?? prev.origin,
          }));
        }
      }
      return;
    }

    if (decision === "generate") {
      // Only reached when the user actively started (or resumed) a plan. This
      // is what makes a trip planned in chat mode auto-load its live stays and
      // flights without a manual search.
      setShowEmptyStart(false);
      void generate();
      return;
    }

    // decision === "empty-start": render the explicit start prompt and do NOT
    // call generate(); nothing is fabricated.
    setShowEmptyStart(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    resultsOnly,
    sharedContext.context.destination,
    sharedContext.userInitiated,
    sharedContext.itinerary,
  ]);

  /**
   * Generate the day-by-day itinerary. When the Shared_Trip_Context carries a
   * destination, ask `POST /api/ai` (action "itinerary") to generate it spanning
   * the captured duration (Req 8.1, 8.2); the server already degrades to the
   * deterministic `buildItinerary` on any Bedrock error (`source:"fallback"`,
   * never a 500). If the fetch itself fails or the shared context is empty, we
   * fall back to the local synchronous build so the planner never breaks
   * offline (Req 10.3). Costs render as estimates and no activity as a confirmed
   * booking (Req 8.5). The existing `generating`/`status`/`error` message-state
   * UI drives the loading/error states (Req 10.1, 10.3, 10.4).
   */
  /**
   * Store the itinerary's REAL first/last day dates into the Shared_Trip_Context
   * date hints, so when the traveller opens the full /stays or /flights search
   * it runs with valid dates and shows LIVE results (photos + provider quotes +
   * Compare & book) instead of falling back to estimates. Only sets dates that
   * are real ISO dates; never fabricates.
   */
  function carryTripDatesToContext(itinerary: Itinerary) {
    const days = itinerary.days ?? [];
    const checkIn = (days[0]?.date || "").trim();
    const checkOut = (days[days.length - 1]?.date || "").trim();
    const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
    if (isDate(checkIn) && isDate(checkOut) && checkOut > checkIn) {
      // Never replace a date the traveller already chose: fill only empty fields.
      const cur = sharedContext.dates;
      const has = (v: unknown) => typeof v === "string" && v.trim() !== "";
      const next = { ...cur };
      if (!has(cur.checkIn)) next.checkIn = checkIn;
      if (!has(cur.checkOut)) next.checkOut = checkOut;
      if (!has(cur.departDate)) next.departDate = checkIn;
      if (!has(cur.returnDate)) next.returnDate = checkOut;
      if (next.checkIn !== cur.checkIn || next.checkOut !== cur.checkOut || next.departDate !== cur.departDate || next.returnDate !== cur.returnDate) {
        sharedContext.setDates(next);
      }
    }
  }

  /** Start date edit (Req 1.4, 1.5, 1.7, 1.8): write the start and its end, or clear all four date keys. */
  function onStartDateChange(value: string) {
    if (!value) {
      const { departDate: _d, checkIn: _c, returnDate: _r, checkOut: _o, ...rest } = sharedContext.dates;
      sharedContext.setDates(rest);
      return;
    }
    const write = planStartDateWrite(value, durationFromText(duration));
    if (write) sharedContext.patchDates(write);
  }

  /** Day-count edit: keep the start date, move the return date to start + count - 1 (Req 3.8). Never invents a start date. */
  function syncReturnToDayCount(text: string) {
    const start = sharedContext.dates.departDate;
    const n = durationFromText(text);
    if (typeof start !== "string" || !resolveTripDates({ startDate: start, endDate: start }).startDate || n === null || n < 1) return;
    const count = Math.min(MAX_TRIP_DAYS, n);
    const end = endFromDays(start, count);
    if (end === sharedContext.dates.returnDate) return;
    sharedContext.patchDates({ returnDate: end, checkOut: end });
  }

  /** Restamp to the chosen dates (C1), then convert to INR exactly once. */
  async function prepareItinerary(it: Itinerary): Promise<Itinerary> {
    if (it.costUnit === "inr") return it;
    const rate = await getRate();
    const start = sharedContext.dates.departDate;
    // Batch itineraries (they carry `completeness`) are already stamped by the server.
    const stamped = typeof start === "string" && !it.completeness ? restampItineraryDates(it, start) : it;
    return normalizeItineraryToInr(stamped, rate, costOpts());
  }

  /** Trip context for classification and caps: origin, destination and budget level. */
  function costOpts() {
    return {
      origin: (route.origin || sharedContext.context.origin || "").trim(),
      destination: (route.destination || sharedContext.context.destination || "").trim(),
      budgetLevel: resolveBudgetLevel(sharedContext.context.budgetLevel),
    };
  }

  /** Post one batched pricing request per generation; failures keep the estimates silently. */
  function startPricing(it: Itinerary, destination: string) {
    const opts = { ...costOpts(), destination: destination.trim() || costOpts().destination };
    const req = toPricerRequest(destination, it, opts);
    if (req.activities.length === 0 || !destination.trim()) return;
    const key = req.activities.map((a) => a.id).join("|");
    if (pricedKeysRef.current.has(key)) return;
    pricedKeysRef.current.add(key);
    inFlightRef.current.add(key);
    setPricing("loading");
    // Settle one request: status stays loading until every in-flight request ends.
    const settle = (ok: boolean) => {
      if (!inFlightRef.current.delete(key)) return;
      if (ok) pricedOkRef.current += 1;
      if (inFlightRef.current.size === 0) setPricing(pricedOkRef.current > 0 ? "done" : "failed");
    };
    const noFlightRoute = !!opts.origin && !!opts.destination
      && isNoFlightRoute(classifyFlightAvailability(opts.origin, opts.destination));
    const body = {
      destination: req.destination,
      activities: req.activities.slice(0, MAX_ACTIVITIES),
      budgetLevel: opts.budgetLevel,
      cityTier: resolveCityTier(opts.destination),
      origin: opts.origin,
      ...(noFlightRoute ? { routeFare: true } : {}),
    };
    fetch("/api/activity-prices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => { if (!r.ok) throw new Error("pricing " + r.status); return r.json(); })
      .then((data: { prices?: PriceResult[]; routeFare?: unknown }) => {
        if (!inFlightRef.current.has(key)) return;
        const cur = stateRef.current;
        if (!cur || !Array.isArray(data.prices)) { settle(false); return; }
        const next = applyRouteFare(applyPriceResults(cur.itinerary, data.prices, opts), data.routeFare);
        const nextState = reprice(next);
        setState(nextState);
        stateRef.current = nextState;
        sharedContext.setItinerary(next);
        settle(true);
      })
      .catch(() => { settle(false); });
  }

  async function generate() {
    assistantGenRef.current += 1;
    setStatus("generating");
    setError("");
    setEditing(null);
    lastSavedFpRef.current = null;

    // Prefer the shared context destination; otherwise parse the free-text box.
    const r = parseRoute(request, emptyRouteState());
    const destination = sharedContext.context.destination ?? r.destination;
    if (destination) {
      r.destination = destination;
      if (!r.origin && sharedContext.context.origin) r.origin = sharedContext.context.origin;
    }
    setRoute(r);

    if (!destination) {
      // Error path: descriptive message; preserve any prior itinerary preview
      // (do not wipe `state`) (Req 10.3).
      setError("Tell me where you want to go - try \"Goa from Delhi\".");
      setStatus("error");
      return;
    }

    // Chosen dates win over the typed length (Req 3.1, 3.2). Typed length is the fallback.
    const chosenDates = resolveTripDates({
      startDate: sharedContext.dates.departDate,
      endDate: sharedContext.dates.returnDate,
    });
    const trip = resolveTripLength({
      field: duration,
      contextDays: sharedContext.context.durationDays,
      startDate: sharedContext.dates.departDate,
      endDate: sharedContext.dates.returnDate,
    });
    let days = trip.days;
    let tripStart: string | undefined;
    let lengthNote = "";
    let capped = trip.capped;
    if (chosenDates.source === "dates" && chosenDates.days !== null) {
      days = chosenDates.days;
      capped = chosenDates.capped;
      tripStart = chosenDates.startDate ?? undefined;
      if (capped) lengthNote = `Your dates cover ${trip.dateSpanDays ?? days} days. Planning the first ${days}.`;
      else if (trip.days !== days) lengthNote = `Using ${days} days from your dates.`;
    } else {
      const withStart = resolveTripDates({ startDate: sharedContext.dates.departDate, days: trip.days });
      if (withStart.source === "days" && !withStart.needsStartDate) {
        tripStart = withStart.startDate ?? undefined;
      } else {
        lengthNote = undatedNote(days);
      }
    }
    setDateNote(lengthNote || (chosenDates.source === "dates" ? "" : (dateSpanNotice(trip.dateSpanDays, days) ?? "")));
    setLimitNote(capped);

    // Build the itinerary-request context from the shared context, falling back
    // to the local inputs for any field the shared context does not carry. Never
    // fabricate fields the traveler did not supply.
    const context: TripContext = {
      ...sharedContext.context,
      destination,
      durationDays: days,
      interests: sharedContext.context.interests ?? [vibe],
    };

    const tripKey = tripKeyOf({ ...context, durationDays: days });
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    pricedKeysRef.current = new Set();
    inFlightRef.current = new Set();
    pricedOkRef.current = 0;
    setPricing("idle");
    focusDayRef.current = null;
    setRetryBusy({});
    setProgressMsg("Verifying places on Google Maps…");
    const s0 = batchReducer(initBatchState(), { type: "start", tripKey, totalDays: days });
    dispatch({ type: "start", tripKey, totalDays: days });
    if (batchState.tripKey && batchState.tripKey !== tripKey) endGeneration();
    beginGeneration(tripKey);
    const slot = nextSlot(s0);
    if (!slot) {
      setError("We could not start planning this trip. Please try again.");
      setStatus("error");
      return;
    }

    // Nothing verified for batch 1: no plan is shown and nothing is invented.
    const showFailure = (resp: ReturnType<typeof unavailable>) => {
      dispatch({ type: "response", slotId: slot.id, tripKey, resp });
      setState(null);
      setProgressMsg("");
      setError("");
      setShowEmptyStart(false);
      setStatus("error");
    };

    // Silent only when superseded by a newer generate() or really unmounted.
    const exitOf = () => classifyExit({
      aborted: controller.signal.aborted,
      generationActive: isGenerationActive(tripKey),
      superseded: abortRef.current !== controller,
      unmounted: !mountedRef.current,
    });

    try {
      const startDate = tripStart;
      const req = buildRequest(s0, slot, { ...context, durationDays: days }, typeof startDate === "string" ? startDate : undefined);
      dispatch({ type: "request", slotId: slot.id });
      const resp = await postBatch(req, controller.signal);
      const exit1 = exitOf();
      if (exit1 === "silent") return;
      if (exit1 === "failure") { showFailure(unavailable(slot, "unavailable")); return; }
      if (!resp || resp.source !== "model" || resp.days.length === 0) {
        showFailure(resp && resp.source === "unavailable" ? resp : unavailable(slot, resp ? "unverified" : "unavailable"));
        return;
      }
      // Batch 1 only: convert to INR once (the server already stamped the dates),
      // then merge so completeness lists the later days as pending.
      const batchOnly = withSources(
        await prepareItinerary({
          title: `Trip to ${destination}`,
          totalCost: 0,
          days: resp.days, currency: "INR", costUnit: "inr",
          completeness: { requestedDays: days, verifiedDays: resp.verifiedDays, withheldDays: resp.withheldDays },
        }),
        resp.sources ?? [],
      );
      const exit2 = exitOf();
      if (exit2 === "silent") return;
      if (exit2 === "failure") { showFailure(unavailable(slot, "unavailable")); return; }
      const responseEvent = { type: "response", slotId: slot.id, tripKey, resp } as const;
      const afterBatch1 = batchReducer(batchReducer(batchReducer(s0, { type: "request", slotId: slot.id }), responseEvent), { type: "auto-retry" });
      const itin = mergeBatch(null, batchOnly, { ...resp, withheldDays: afterBatch1.withheld }, days);
      dispatch(responseEvent);
      dispatch({ type: "auto-retry" });
      setShowEmptyStart(false);
      setState(reprice(itin));
      sharedContext.setItinerary(itin);
      carryTripDatesToContext(itin);
      earn("itinerary_generated");
      const left = days - itin.days.length;
      setProgressMsg(left > 0 ? `Verified ${itin.days.length} of ${days} days so far.` : "");
      setStatus("done");
      if (!resultsOnly) { router.push("/itinerary"); return; }
    } catch {
      if (exitOf() === "silent") return;
      showFailure(unavailable(slot, "unavailable"));
    }
  }

  /**
   * Re-price a WorkspaceState after an itinerary mutation so the trip summary
   * stays in lockstep with the timeline. The activities subtotal is re-derived
   * from the edited itinerary's per-day totals and fed back through the shared
   * Pricing Engine with the same flight/stay base, mirroring recomputeWorkspace's
   * invariant (activities subtotal always equals the rendered itinerary).
   */
  function reprice(itinerary: Itinerary): WorkspaceState {
    const f = liveFareRef.current;
    const pricing = computeSummary({
      itinerary, stayInr: f.stay, flightPerPerson: f.perPerson, travellers: travellersCount, noFlight: f.noFlight,
    });
    return { itinerary, pricing };
  }

  /** Begin editing a day's title/theme. */
  function startEdit(day: number, title: string, theme: string) {
    setEditing({ day, title, theme });
  }

  /** Commit the draft title/theme to the itinerary and re-render the timeline. */
  function saveEdit() {
    if (!state || !editing) return;
    const days = state.itinerary.days.map((d) =>
      d.day === editing.day ? { ...d, title: editing.title, theme: editing.theme } : d,
    );
    const itinerary: Itinerary = { ...state.itinerary, days, revised: true };
    setState(reprice(itinerary));
    setEditing(null);
  }

  /**
   * Export the current itinerary to a polished, dependency-free PDF via the
   * existing uildItineraryPdf builder, then trigger a browser download. Maps
   * the planner's itinerary days onto the builder's TripDay shape, using each
   * day's own ISO date, or "Day N" when it has none (never today's date).
   */
  function exportPdf() {
    if (!state) return;
    const days = state.itinerary.days.map((d) => {
      const validDate = typeof d.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.date) && !Number.isNaN(Date.parse(d.date));
      return {
        day: d.day,
        date: validDate ? d.date : "Day " + d.day,
        title: d.title,
        theme: d.theme,
        activities: d.activities,
        total: d.total,
      };
    });
    const routeLabel = (route.origin || "-") + " to " + (route.destination || "your destination");
    const bytes = buildItineraryPdf(state.itinerary.title, routeLabel, days, state.pricing);
    const blob = new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (state.itinerary.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "itinerary") + ".pdf";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  // Scroll-reveal for the itinerary results (cover + each day-group + side
  // panel). A single IntersectionObserver reveals each `.reveal` node inside the
  // results subtree once (Req 6.3, 7.3). SSR-safe (runs only after mount) and
  // reduced-motion-aware: under reduced motion or without IntersectionObserver,
  // every node is shown immediately so content is never gated by motion.
  // Auto-fetch live stays + flights whenever a new itinerary becomes ready,
  // using the captured route, the first/last itinerary day dates and the
  // traveller count. Each generated trip spends at most two provider searches
  // (one stays, one flights); the server guards the monthly quota. Nothing is
  // fabricated: when a field is missing or the provider is unavailable the
  // section shows a labelled note and falls back to the full search pages.
  const liveKeyRef = useRef<string>("");
  useEffect(() => {
    if (!state) return;
    const dest = (route.destination || sharedContext.context.destination || "").trim();
    const orig = (route.origin || sharedContext.context.origin || "").trim();
    const days = state.itinerary.days;
    const checkIn = (days[0]?.date || "").trim();
    const checkOut = (days[days.length - 1]?.date || "").trim();
    const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
    const staysC = isDate(checkIn) && isDate(checkOut) && checkOut > checkIn && dest
      ? serializeCriteria({ category: "stays", destination: dest, checkIn, checkOut, guests: travellersCount, rooms: roomsCount })
      : "";
    const flightsC = isDate(checkIn) && isDate(checkOut) && checkOut > checkIn && dest && orig
      ? serializeCriteria({ category: "flights", tripType: "round-trip", origin: orig, destination: dest, departDate: checkIn, returnDate: checkOut, travellers: travellersCount, cabin: "economy" })
      : "";
    const staysHref = staysC ? `/stays?${staysC}` : "/stays";
    const flightsHref = flightsC ? `/flights?${flightsC}` : "/flights";
    const nights = (() => {
      const a = Date.parse(checkIn), b = Date.parse(checkOut);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 1;
      return Math.max(1, Math.round((b - a) / 86_400_000));
    })();
    const staysCriteria = dest ? { destination: dest, checkIn, checkOut, adults: travellersCount, rooms: roomsCount } : null;
    const flightsCriteria: FlightBookingCriteria | null = (dest && orig)
      ? { origin: orig, destination: dest, tripType: "round-trip", departDate: checkIn, returnDate: checkOut, cabin: "economy", travellers: travellersCount }
      : null;
    // Immediate, network-free classification (C7: only when both texts are non-blank).
    if (orig && dest) {
      const pre = classifyFlightAvailability(orig, dest);
      if (pre === "no-airport") { setFlightMode("none"); setFlightAvail("no-airport"); }
    } else {
      setFlightMode("unknown"); setFlightAvail(null);
    }
    if (!dest || !isDate(checkIn) || !isDate(checkOut)) {
      setLive({ ...EMPTY_LIVE, status: "ready", staysHref, flightsHref,
        note: "Add your travel dates and route in the chat to see live stays and flights for this trip." });
      return;
    }
    const key = `${orig}|${dest}|${checkIn}|${checkOut}|${travellersCount}`;
    if (liveKeyRef.current === key) return;
    liveKeyRef.current = key;
    // Route changed: forget the previous classification and refetch (Req 10.10).
    if (orig && dest && classifyFlightAvailability(orig, dest) !== "no-airport") { setFlightMode("unknown"); setFlightAvail(null); }
    let cancelled = false;
    setLive((pv) => ({ ...pv, status: "loading", staysHref, flightsHref, note: null, nights, staysCriteria, flightsCriteria }));
    const qs = new URLSearchParams({ origin: orig, destination: dest, checkIn, checkOut, travellers: String(travellersCount), cabin: "economy", tripType: "round-trip" });
    fetch(`/api/trip-live?${qs.toString()}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data: {
        stays?: { status: string; provider?: string; currency?: string; checkedAt?: string; hotels?: LiveHotel[]; error?: string };
        flights?: { status: string; provider?: string; currency?: string; checkedAt?: string; insights?: PriceInsights | null; flights?: LiveFlight[]; error?: string } | null;
        flightAvailability?: FlightAvailability;
      }) => {
        if (cancelled) return;
        // Server classification is authoritative; flights is null for "no-airport".
        const av: FlightAvailability = data.flightAvailability === "no-airport" || data.flightAvailability === "no-flights"
          ? data.flightAvailability : "available";
        setFlightAvail(av);
        setFlightMode(isNoFlightRoute(av) ? "none" : "available");
        const hotels = data.stays?.status === "live" ? (data.stays.hotels ?? []) : [];
        const fl = data.flights?.status === "live" ? (data.flights.flights ?? []) : [];
        const notes: string[] = [];
        if (hotels.length === 0) notes.push("live stays");
        if (fl.length === 0 && !isNoFlightRoute(av)) notes.push("live flights");
        const checkedAt = data.stays?.checkedAt || data.flights?.checkedAt || new Date().toISOString();
        setLive({
          status: "ready", stays: hotels, flights: fl, staysHref, flightsHref,
          note: notes.length ? `We could not load ${notes.join(" or ")} for these dates right now - open the full search to try again.` : null,
          staysProvider: data.stays?.provider || "Google Hotels via SerpApi",
          staysCurrency: data.stays?.currency || "INR",
          flightsProvider: data.flights?.provider || "Google Flights via SerpApi",
          flightsCurrency: data.flights?.currency || "INR",
          checkedAt, checkedLabel: fmtCheckedLabel(checkedAt), nights,
          insights: data.flights?.insights ?? null, staysCriteria, flightsCriteria,
        });
      })
      .catch(() => { if (!cancelled) setLive((pv) => ({ ...pv, status: "error", staysHref, flightsHref, note: "Live prices are unavailable right now. Open the full search to try again." })); });
    return () => { cancelled = true; };
  }, [state, route.destination, route.origin, travellersCount, roomsCount, sharedContext.context.destination, sharedContext.context.origin]);

  // Feed the cheapest live flight and stay into the Pricing Engine (real prices),
  // falling back to the base estimate when a live result is unavailable. Only INR
  // prices are used so totals never mix currencies. State is updated only when
  // pricing actually changes, so the live effect cannot loop.
  useEffect(() => {
    // Keep noFlight in the fare ref even before live data is ready (immediate
    // no-airport classification), and restore the base fare when flights resume.
    if (liveFareRef.current.noFlight !== noFlight) {
      const synced = noFlight
        ? { ...liveFareRef.current, perPerson: 0, flightLive: false, noFlight: true }
        : { ...liveFareRef.current, perPerson: BASE_FLIGHT, flightLive: false, noFlight: false };
      liveFareRef.current = synced;
      setLiveFare(synced);
    }
    if (live.status === "ready") {
      const inr = (c: string) => !c || c.toUpperCase() === "INR";
      const fl = inr(live.flightsCurrency) ? live.flights.map((x) => x.farePerPerson).filter((n) => Number.isFinite(n) && n > 0) : [];
      const st = inr(live.staysCurrency) ? live.stays.map((x) => x.ratePerNight).filter((n) => Number.isFinite(n) && n > 0) : [];
      const next = {
        // BASE_FLIGHT fallback only when the route has flights (Req 10.4, 10.5).
        perPerson: noFlight ? 0 : fl.length ? Math.round(Math.min(...fl)) : BASE_FLIGHT,
        stay: st.length ? Math.round(Math.min(...st) * Math.max(1, live.nights) * roomsCount) : 0,
        stayRate: st.length ? Math.round(Math.min(...st)) : null,
        flightLive: !noFlight && fl.length > 0,
        stayLive: st.length > 0,
        noFlight,
      };
      const prev = liveFareRef.current;
      if (prev.perPerson !== next.perPerson || prev.stay !== next.stay || prev.stayRate !== next.stayRate || prev.flightLive !== next.flightLive || prev.stayLive !== next.stayLive || prev.noFlight !== next.noFlight) {
        liveFareRef.current = next;
        setLiveFare(next);
      }
    }
    setState((s) => {
      if (!s) return s;
      const n = reprice(s.itinerary);
      const a = s.pricing, b = n.pricing;
      return a.flight === b.flight && a.stay === b.stay && a.activities === b.activities && a.finalPayable === b.finalPayable ? s : n;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, travellersCount, roomsCount, noFlight]);

  const resultsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!state) return;
    const root = resultsRef.current;
    if (!root || typeof window === "undefined") return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>(".reveal"));
    if (nodes.length === 0) return;
    const prefersReduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReduced || typeof IntersectionObserver === "undefined") {
      nodes.forEach((n) => n.classList.add("reveal--in"));
      return;
    }
    const observer = new IntersectionObserver(
      (entries, obs) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("reveal--in");
            obs.unobserve(entry.target);
          }
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.12 },
    );
    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, [state]);

  stateRef.current = state;
  const ctxRef = useRef(sharedContext);
  ctxRef.current = sharedContext;
  // Per-day Misc (web prices) line. Empty destination => no days => no request.
  const miscDestination = (route.destination || sharedContext.context.destination || "").trim();
  const miscTravellers = Math.min(50, Math.max(1, Math.trunc(Number(travellersCount)) || 1));
  const miscDays = useMemo(
    () => (miscDestination ? (state?.itinerary?.days ?? []) : []),
    [state?.itinerary?.days, miscDestination],
  );
  const misc = useMiscEstimates(miscDays, miscDestination, miscTravellers);

  // Cost breakdown (Req 1.5-1.8, 4.x). Built from already-fetched data only.
  const [includeRouteFare, setIncludeRouteFare] = useState(false);
  const [costOpen, setCostOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const filter = useMemo(
    () => filterItinerary(state ? state.itinerary : ({ days: [] } as unknown as Itinerary), searchQuery),
    [state, searchQuery],
  );
  const costBreakdown = useMemo(() => {
    if (!state) return null;
    const miscSum = Object.values(misc).reduce(
      (acc, m) => (m !== "loading" && m.status === "ok" ? acc + m.sumInr : acc),
      0,
    );
    const rf = state.itinerary.routeFare;
    const stops = state.itinerary.days.flatMap((x) => x.activities);
    return buildCostBreakdown({
      travellers: travellersCount,
      travellersSource: ctxTravellers ? "context" : "state",
      rooms: roomsCount,
      roomsDerived,
      nights: live.nights,
      hasFlights: !noFlight,
      flight: noFlight ? null : {
        amountInr: liveFare.flightLive ? liveFare.perPerson : null,
        basis: "per-person",
        source: "Live flight search",
      },
      stay: { rateInr: liveFare.stayRate, source: "Live hotel search" },
      activities: {
        amountInr: state.pricing.activities,
        webPricedCount: priceSourceCounts(state.itinerary).web,
        unpricedStopCount: unpricedStopCount(stops),
      },
      routeFare: rf
        ? { minInr: rf.minInr, maxInr: rf.maxInr, mode: rf.mode, source: rf.sourceHost, selected: includeRouteFare }
        : null,
      misc: miscSum > 0 ? { sumInr: miscSum, source: "Web prices" } : null,
      discount: state.pricing.discount > 0 ? { code: state.pricing.coupon, amountInr: state.pricing.discount } : null,
    });
  }, [state, misc, travellersCount, ctxTravellers, roomsCount, roomsDerived, live.nights, noFlight, liveFare, includeRouteFare]);
  // Key of the last slot attempt the driver launched (guards StrictMode double effects).
  const launchedRef = useRef("");
  // The Retry the user asked for: days to restore and the busy-flag key.
  const retryRef = useRef<{ days: number[]; busyKey: string } | null>(null);

  /** Trip context of the running generation (same shape generate() used for its key). */
  function batchContext(totalDays: number): TripContext {
    const c = ctxRef.current.context;
    return { ...c, durationDays: totalDays, interests: c.interests ?? [vibe] };
  }

  // Driver (slots 2.. and retries): batch 1 is requested by generate(). One
  // request at a time; the reducer ignores stale responses. The request is
  // cancelled by the unmount effect below (and by a new generate()), not on every
  // state change, because the "request" dispatch itself changes batchState.
  useEffect(() => {
    if (!resultsOnly) return; // /trip hands over to /itinerary after batch 1
    const slot = nextSlot(batchState);
    if (!slot || !isGenerationActive(batchState.tripKey)) return;
    const launchKey = `${batchState.tripKey}|${slot.id}|${slot.attempts}`;
    if (launchedRef.current === launchKey) return;
    launchedRef.current = launchKey;
    const tripKey = batchState.tripKey;
    const total = batchState.totalDays;
    const lastDay = slot.fromDay + slot.dayCount - 1;
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: "request", slotId: slot.id });
    setProgressMsg(progressText("verifying", slot.fromDay, lastDay));
    void (async () => {
      const ctx = batchContext(total);
      const startDate = ctxRef.current.dates.departDate;
      const req = buildRequest(batchState, slot, ctx, typeof startDate === "string" ? startDate : undefined);
      let resp: Awaited<ReturnType<typeof postBatch>> = null;
      try { resp = await postBatch(req, controller.signal); } catch { resp = null; }
      if (controller.signal.aborted || !isGenerationActive(tripKey)) return;
      const event = resp
        ? ({ type: "response", slotId: slot.id, tripKey, resp } as const)
        : ({ type: "network-error", slotId: slot.id, tripKey } as const);
      const after = batchReducer(batchReducer(batchReducer(batchState, { type: "request", slotId: slot.id }), event), { type: "auto-retry" });
      dispatch(event);
      dispatch({ type: "auto-retry" });
      const batchDays = resp && resp.source === "model" ? resp.days : [];
      try {
        const base = stateRef.current?.itinerary ?? ctxRef.current.itinerary ?? null;
        const prevWithheld = base?.completeness?.withheldDays ?? [];
        const withheldChanged = after.withheld.join(",") !== prevWithheld.join(",");
        if (base && (batchDays.length > 0 || withheldChanged)) {
          const dest = (ctx.destination ?? "").trim();
          const batchOnly = await prepareItinerary({
            title: base.title,
            totalCost: 0,
            days: batchDays, currency: "INR", costUnit: "inr",
            completeness: { requestedDays: total, verifiedDays: batchDays.map((d) => d.day), withheldDays: after.withheld },
          });
          if (controller.signal.aborted || !isGenerationActive(tripKey)) return;
          const itin = mergeBatch(base, batchOnly, { verifiedDays: batchDays.map((d) => d.day), withheldDays: after.withheld }, total);
          setState(reprice(itin));
          ctxRef.current.setItinerary(itin);
        }
      } catch {
        // The batch outcome is already recorded in the reducer; keep what is shown.
      }
      const upcoming = nextSlot(after);
      const restoredRange = batchDays.length > 0
        ? [Math.min(...batchDays.map((d) => d.day)), Math.max(...batchDays.map((d) => d.day))]
        : null;
      if (upcoming) setProgressMsg(progressText("verifying", upcoming.fromDay, upcoming.fromDay + upcoming.dayCount - 1));
      else if (restoredRange) setProgressMsg(progressText("added", restoredRange[0], restoredRange[1]));
      else if (after.withheld.length > 0) setProgressMsg(progressText("withheld", after.withheld[0], after.withheld[after.withheld.length - 1]));
      else setProgressMsg("");
      const pend = retryRef.current;
      if (pend && !upcoming) {
        const restored = pend.days.find((d) => after.verified.includes(d));
        if (restored !== undefined) focusDayRef.current = restored;
        retryRef.current = null;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchState]);

  // Unmount (or leaving the page): cancel the outstanding request. The session
  // marker is kept so returning to /itinerary resumes; a new trip ends it in generate().
  // (The mount-aware abort effect lives next to abortRef; endGeneration is NOT
  // called on unmount.)

  // Clear the per-run busy flags once nothing is running any more.
  useEffect(() => {
    if (batchState.phase !== "running") {
      retryRef.current = null;
      setRetryBusy((pv) => (Object.keys(pv).length === 0 ? pv : {}));
    }
  }, [batchState.phase]);

  // Move focus to the first restored day's heading after a successful Retry.
  useEffect(() => {
    const day = focusDayRef.current;
    if (day === null || typeof document === "undefined") return;
    const el = document.getElementById(`day-heading-${day}`);
    if (el) {
      focusDayRef.current = null;
      el.focus();
    }
  }, [state, batchState]);

  /**
   * Retry the withheld days from..to (wired to the placeholder and failure Retry
   * buttons by task 7.5). Re-enters the batch driver; verified days are untouched.
   */
  function retryRange(from: number, to: number) {
    const it = stateRef.current?.itinerary ?? ctxRef.current.itinerary ?? null;
    if (!it) return;
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const total = it.completeness?.requestedDays ?? it.days.length;
    let key = batchState.tripKey;
    if (!key || batchState.totalDays === 0) {
      key = tripKeyOf(batchContext(total));
      dispatch({ type: "resume", tripKey: key, itinerary: it });
    }
    beginGeneration(key);
    const days: number[] = [];
    for (let d = lo; d <= hi; d++) days.push(d);
    const busyKey = `${lo}-${hi}`;
    retryRef.current = { days, busyKey };
    setRetryBusy((pv) => ({ ...pv, [busyKey]: true }));
    dispatch({ type: "retry", fromDay: lo, toDay: hi });
  }
  const inFlightDays = new Set<number>();
  for (const sl of batchState.slots) {
    if (sl.status !== "loading") continue;
    for (let n = 0; n < sl.dayCount; n++) inFlightDays.add(sl.fromDay + n);
  }
  const timelineSlots = state ? buildTimeline(state.itinerary, inFlightDays) : [];
  const _ok = _rc;
  const fare = flightOfferFare(liveFare.perPerson, travellersCount);
  const generating = status === "generating";

  return (
    <main className="shell">
      {resultsOnly ? (
        <>
          <p className="eyebrow">Your itinerary</p>
          <h1>{state?.itinerary.title ?? "Building your trip plan…"}</h1>
          <p className="lead">
            Here is your day-by-day plan with a live cost summary. Every day pulls
            its own photos, and costs are estimates — no activity is a confirmed booking.
          </p>
        </>
      ) : (
        <>
          <p className="eyebrow">AI travel assistant</p>
          <h1>Plan your trip, together</h1>
          <p className="lead">
            Describe the trip you have in mind and I&apos;ll draft a day-by-day itinerary with a live cost summary. Pick a
            starting point below or write your own.
          </p>
        </>
      )}

      {/* Empty_Start_State (R6.2): an explicit start prompt shown when the
          on-mount decision is "empty-start" (or a user-initiated generate
          yielded nothing usable). It renders NO day/activity/booking content -
          nothing is fabricated. Suppressed while generating or when a real
          itinerary is present. */}
      {showEmptyStart && !generating && !state && (
        <section className="card planner-empty-start" aria-label="Start planning">
          <p className="eyebrow">No plan yet</p>
          <h2>Start planning your trip</h2>
          <p className="lead">
            You don&apos;t have a trip in progress. Tell us where you&apos;d like to go
            and we&apos;ll draft a day-by-day itinerary, or pick up one of your saved plans.
          </p>
          {error && (
            <p className="chat-status chat-status--error field-error" role="alert">
              {error}
            </p>
          )}
          <div className="timeline__actions">
            {resultsOnly ? (
              <button
                type="button"
                className="cta"
                onClick={() => router.push("/plan")}
              >
                Start planning
              </button>
            ) : (
              <button
                type="button"
                className="cta"
                onClick={() => {
                  setShowEmptyStart(false);
                  if (typeof document !== "undefined") {
                    const composer = document.querySelector<HTMLInputElement>(
                      ".planner-composer input",
                    );
                    composer?.focus();
                  }
                }}
              >
                Start planning
              </button>
            )}
            <button
              type="button"
              className="btn"
              onClick={() => {
                // Open your plans: dispatch a window event the history drawer
                // listens for, falling back to the plans route. Kept a plain
                // control - the drawer is not imported here.
                if (typeof window !== "undefined") {
                  window.dispatchEvent(new CustomEvent("tripgenie:open-plans"));
                }
                router.push("/plan");
              }}
            >
              Open your plans
            </button>
          </div>
        </section>
      )}

      {limitNote && <p className="chat-status" role="status">{LIMIT_NOTE}</p>}
      {dateNote && <p className="chat-status" role="status">{dateNote}</p>}
      {isUndatedNote(dateNote) && <button type="button" className="chat-chip" onClick={() => startDateRef.current?.focus()}>Add a start date</button>}
      {progressMsg && <p className="chat-status" role="status" aria-live="polite">{progressMsg}</p>}
      {batchState.phase === "failed" && !generating && !state && (
        <ItineraryFailure
          reason={batchState.reason}
          busy={retryBusy.all === true}
          onRetry={() => { void generate(); }}
        />
      )}

      {!resultsOnly && (
      <section className="planner-chat">
        {!generating && (
        <>
        <div className="card planner-composer">
          <label className="field">
            <span>Where to?</span>
            <input value={request} onChange={(e) => setRequest(e.target.value)} placeholder="Goa from Delhi" />
          </label>
          <div className="field-row">
            <label className="field">
              <span>How long?</span>
              <input value={duration} onChange={(e) => { setDuration(e.target.value); syncReturnToDayCount(e.target.value); }} placeholder="4 days" />
            </label>
            <label className="field">
              <span>Start date</span>
              <input type="date" min={todayIst()} ref={startDateRef} aria-describedby="start-date-hint" value={sharedContext.dates.departDate ?? ""} onChange={(e) => onStartDateChange(e.target.value)} />
              <p id="start-date-hint" className="field-hint">Optional. Without a start date your days are labelled Day 1 to Day N.</p>
            </label>
            <label className="field">
              <span>Travellers</span>
              <input
                type="number"
                min={1}
                max={9}
                value={travellers}
                onChange={(e) => setTravellers(Math.max(1, Number(e.target.value) || 1))}
              />
            </label>
          </div>
          <label className="field">
            <span>Vibe</span>
            <input value={vibe} onChange={(e) => setVibe(e.target.value)} placeholder="Culture & food" />
          </label>
          {(() => {
            const preview = formatTripPreview({
              where: request,
              destination: request.trim() ? undefined : sharedContext.context.destination,
              origin: request.trim() ? undefined : sharedContext.context.origin,
              startDate: sharedContext.dates.departDate,
              days: durationFromText(duration) ?? undefined,
              travellers,
              vibe,
            });
            return (
              <p className="trip-preview" aria-live="polite">
                <strong>Trip preview</strong>{" "}
                {preview.text ? (
                  <>
                    {preview.place}
                    {preview.dates && <>{preview.place ? " · " : ""}<span className="trip-preview__dates">{preview.dates}</span></>}
                    {[preview.travellers, preview.vibe].filter(Boolean).map((s) => " · " + s).join("")}
                  </>
                ) : (
                  "Add a destination to see your trip summary."
                )}
              </p>
            );
          })()}
          <button className="cta" onClick={generate} disabled={generating} aria-busy={generating}>
            {generating ? "Planning your trip…" : "Generate itinerary"}
          </button>
          {error && (
            <p className="chat-status chat-status--error field-error" role="alert">
              {error}
            </p>
          )}
        </div>
        </>
        )}

        {/* Assistant message states: pending/in-progress skeleton while generating (Req 11.3). */}
        {generating && (
          <div className="planner-drafting" aria-live="polite">
            <BrandLoader label="Planning your trip" size={160} />
            <TravelFacts destination={route.destination || sharedContext.context.destination || ""} />
          </div>
        )}
      </section>
      )}

      {state && (
        <div className="grid-2 planner-results" ref={resultsRef}>
          {/* Completed assistant response — itinerary as a structured timeline
              of day-by-day activity cards with location markers and green
              journey indicators (Req 12.1, 12.2). */}
          <div className="chat-message chat-message--done motion-rise planner-results__main">
            {/* Premium trip cover (Req 6.1): real destination image + overlaid
                serif title/dates/destination/travellers metadata. Uses only
                existing planner data; no field is invented. */}
            <TripCover
              title={state.itinerary.title}
              destination={route.destination || sharedContext.context.destination || ""}
              origin={route.origin || sharedContext.context.origin || ""}
              dateRange={coverDateRange(state.itinerary.days)}
              dayCount={state.itinerary.days.length}
              travellers={
                sharedContext.context.travellers
                  ? sharedContext.context.travellers.adults + sharedContext.context.travellers.children
                  : travellers
              }
            />
            <span className="chat-message__role">Here&apos;s your draft itinerary</span>
            <h2 className="planner-itinerary__title">{state.itinerary.title}</h2>
            {/* Every cost is an estimate and no activity is a confirmed booking
                (Req 8.5) — surfaced through the existing `eyebrow` class, no new
                token or class introduced. */}
            <p className="eyebrow">Estimated costs — no activity is a confirmed booking</p>
            {pricing === "loading" && (
              <p className="chat-status ai-pulse" role="status" aria-live="polite">Pricing activities in INR…</p>
            )}
            {pricing === "failed" && (
              <p className="chat-status" role="status" aria-live="polite">Using typical price ranges</p>
            )}
            {/* AI regenerate — re-invokes the existing async `generate()` path
                (POST /api/ai action:"itinerary") from the CURRENT shared context
                and reuses the existing `generating`/`status` loading UI; no new
                loading state is introduced (Req 8.4). Reuses the `cta` class. */}
            <div className="timeline__actions planner-toolbar">
              <button
                type="button"
                className="cta"
                onClick={generate}
                disabled={generating}
                aria-busy={generating}
              >
                {generating ? "Regenerating…" : "AI regenerate"}
              </button>
              {/* Save to the user's account (DynamoDB Trip_Store), not just
                  browser-local storage. Compact icon control, not a wide button. */}
              <button
                type="button"
                className="btn planner-export-btn"
                onClick={exportPdf}
                aria-label="Export this itinerary as a PDF"
                title="Export as PDF"
              >
                Export PDF
              </button>
              <button
                type="button"
                className="icon-btn planner-save-icon"
                onClick={saveTrip}
                disabled={saving}
                aria-busy={saving}
                aria-label={saving ? "Saving trip" : "Save trip"}
                title="Save trip"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M6 3h10l4 4v12.5a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 19.5v-15A1.5 1.5 0 015.5 3z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                  <path d="M8 3v5h7V3M8 21v-6h8v6" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
            <Toast toast={toast} onDismiss={() => setToast(null)} />
            <ItineraryBanner
              verifiedLabel={batchState.slots.length > 1 && state.itinerary.completeness ? verifiedLabel(state.itinerary.completeness) : ""}
              legacy={!hasVerificationData(state.itinerary)}
            />
            <aside className="card planner-summary planner-results__aside reveal">
              <h3 className="planner-summary__title">Trip summary</h3>
              <p className="lead planner-summary__route">
                {route.origin || "-"} to {route.destination}
                {noFlight && <> · <span className="planner-summary__note" role="note">{GROUND_TRANSPORT_NOTE}</span></>}
              </p>
              <div className="summary-grid" hidden>
              {noFlight ? (
                <>{state.itinerary.routeFare && <RouteFareLine fare={state.itinerary.routeFare} />}</>
              ) : (
                <>
                  <div className="row"><span>Flight (per person, {liveFare.flightLive ? "live" : "estimated"})</span><span>{INR(fare.perPerson)}</span></div>
                  <div className="row"><span>Flight x {fare.travellers}</span><span>{INR(fare.party)}</span></div>
                </>
              )}
              <div className="row"><span>Stay ({liveFare.stayLive ? `live, ${live.nights} ${live.nights === 1 ? "night" : "nights"}` : "estimated"})</span><span>{INR(state.pricing.stay)}</span></div>
              <div className="row"><span>{itineraryHasWebDetails(state.itinerary) ? <>{ACTIVITIES_WEB_ONLY_LABEL}<span className="row__suffix"> · {unpricedLabel(unpricedStopCount(state.itinerary.days.flatMap((x) => x.activities)))}</span></> : activitiesLabel(state.itinerary.completeness)}</span><span>{INR(state.pricing.activities)}</span></div>{formatSourceCounts(priceSourceCounts(state.itinerary)) !== "" && <p className="planner-summary__sources">{formatSourceCounts(priceSourceCounts(state.itinerary))}</p>}{state.itinerary.completeness && !isComplete(state.itinerary) && <p className="planner-summary__sources">{TOTAL_NOTE}</p>}
              {state.pricing.gross !== state.pricing.finalPayable && (
                <div className="row"><span>Gross</span><span>{INR(state.pricing.gross)}</span></div>
              )}
              <div className="row row--final"><span>Final payable</span><span>{INR(state.pricing.finalPayable)}</span></div>
              </div>
              {state.itinerary.routeFare && (
                <label className="planner-summary__route-fare-label">
                  <input
                    type="checkbox"
                    className="planner-summary__route-fare"
                    checked={includeRouteFare}
                    onChange={(e) => setIncludeRouteFare(e.target.checked)}
                  />{" "}
                  Add road/rail fare to total
                </label>
              )}
              {costBreakdown && (
                <>
                  <div className="planner-summary__cost">
                    <strong>Final payable</strong>
                    <span className="planner-summary__cost-amount">{INR(costBreakdown.totalInr)}</span>
                    <button
                      type="button"
                      className="planner-summary__cost-toggle"
                      aria-expanded={costOpen}
                      aria-controls="planner-cost-breakdown"
                      onClick={() => setCostOpen((v) => !v)}
                    >
                      Cost breakdown
                    </button>
                  </div>
                  <div id="planner-cost-breakdown">{costOpen && <CostBreakdown breakdown={costBreakdown} />}</div>
                </>
              )}
              {/* AI pick justification. */}
              {(() => {
                if (live.status !== "ready") return null;
                const pctBelow = (value: number, all: number[]): number | null => {
                  if (all.length < 2) return null;
                  const sorted = [...all].sort((a, b) => a - b);
                  const mid = Math.floor(sorted.length / 2);
                  const med = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
                  if (!(med > 0) || !(value < med)) return null;
                  const p = Math.floor(((med - value) / med) * 100);
                  return p >= 1 ? p : null;
                };
                const stays = live.stays || [];
                const flights = noFlight ? [] : (live.flights || []);
                const bestStay = stays.length ? [...stays].sort((a, b) => a.ratePerNight - b.ratePerNight)[0] : null;
                const bestFlight = flights.length ? [...flights].sort((a, b) => a.farePerPerson - b.farePerPerson)[0] : null;
                if (!bestStay && !bestFlight) return null;
                const stayPct = bestStay ? pctBelow(bestStay.ratePerNight, stays.map((h) => h.ratePerNight)) : null;
                const flightPct = bestFlight ? pctBelow(bestFlight.farePerPerson, flights.map((f) => f.farePerPerson)) : null;
                const stayBits: string[] = [];
                if (bestStay && typeof bestStay.rating === "number") stayBits.push(bestStay.reviews ? `Rated ${bestStay.rating} by ${Math.round(bestStay.reviews).toLocaleString("en-IN")} guests` : `Rated ${bestStay.rating}/5`);
                if (stayPct !== null) stayBits.push(`${stayPct}% below the median nightly price here`);
                const flightBits: string[] = [];
                if (bestFlight && typeof bestFlight.stops === "number") flightBits.push(bestFlight.stops === 0 ? "Non-stop" : `${bestFlight.stops} stop`);
                if (flightPct !== null) flightBits.push(`${flightPct}% below the median fare`);
                return (
                  <details className="planner-summary__picks">
                    <summary className="eyebrow planner-summary__pick-label">Why these picks</summary>
                    {bestStay && (
                      <div className="planner-summary__pick">
                        <span className="planner-summary__pick-tag">AI pick · Stay</span>
                        <span className="planner-summary__pick-name">{bestStay.name}</span>
                        {stayBits.length > 0 && <span className="planner-summary__pick-why">{stayBits.join(" · ")}</span>}
                      </div>
                    )}
                    {bestFlight && (
                      <div className="planner-summary__pick">
                        <span className="planner-summary__pick-tag">AI pick · Flight</span>
                        <span className="planner-summary__pick-name">from {INR_FMT.format(bestFlight.farePerPerson)} / person</span>
                        {flightBits.length > 0 && <span className="planner-summary__pick-why">{flightBits.join(" · ")}</span>}
                      </div>
                    )}
                    <p className="planner-summary__pick-note">AI picks are chosen from live results by rating, price vs the median, and convenience.</p>
                  </details>
                );
              })()}
            </aside>
            <div className="planner-xp-strip">
              {/* Gamification: deterministic XP/level/badges/quests for this
                  planning session (TripSaathi parity, FR-06). */}
              <GamificationPanel state={accountXp.state ?? undefined} guest={accountXp.status === "guest"} loading={accountXp.status === "loading"} error={accountXp.error} onRetry={accountXp.retry} compact />
            </div>
            <ItinerarySearch value={searchQuery} onQueryChange={setSearchQuery} count={filter.count} active={filter.active} />
            <ol className="timeline planner-itinerary">
              {timelineSlots.map((slot, di) => {
                if (slot.kind === "placeholder") {
                  if (filter.active) return null;
                  return (
                    <li key={"ph-" + slot.from} className="timeline__day">
                      <PlaceholderCard
                        slot={slot}
                        busy={!!retryBusy[`${slot.from}-${slot.to}`]}
                        onRetry={() => retryRange(slot.from, slot.to)}
                      />
                    </li>
                  );
                }
                const d = slot.day;
                if (filter.active && !filter.visibleDays.has(String(d.day))) return null;
                                const dayDate = formatShortDate(d.date);
                const isEditing = editing?.day === d.day;
                return (
                  <li
                    key={d.day}
                    className="timeline__day reveal"
                    style={{ transitionDelay: `calc(var(--anim-stagger-step) * ${Math.min(di, 6)})` }}
                  >
                    <span className="timeline__marker" aria-hidden="true">
                      {/* Location-pin marker from the Illustration_Library (Req 12.2). */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        className="timeline__marker-pin"
                        src={LOCATION_PIN.src}
                        alt=""
                        width={LOCATION_PIN.width}
                        height={LOCATION_PIN.height}
                      />
                    </span>
                    <article className={"card planner-day timeline__card"}>
                      {isEditing ? (
                        <div className="timeline__edit">
                          <label className="field">
                            <span>Day {d.day} title</span>
                            <input
                              value={editing.title}
                              onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                            />
                          </label>
                          <label className="field">
                            <span>Theme</span>
                            <input
                              value={editing.theme}
                              onChange={(e) => setEditing({ ...editing, theme: e.target.value })}
                            />
                          </label>
                          <div className="timeline__actions">
                            <button type="button" className="btn btn--primary" onClick={saveEdit}>
                              Save day
                            </button>
                            <button type="button" className="btn" onClick={() => setEditing(null)}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="timeline__head">
                            <div>
                              <h3 className="planner-day__title" id={"day-heading-" + d.day} tabIndex={-1}>
                                <span className="day-toggle day-toggle--static">
                                  <span className="day-toggle__main">
                                    <span className="day-toggle__num">Day {d.day}</span>
                                    {dayDate && <span className="day-toggle__date">{dayDate}</span>}
                                    <span className="day-toggle__title"><Highlight text={d.title} query={searchQuery} /></span>
                                  </span>
                                  <span className="day-toggle__meta">{stopsLabel(d.activities.length)}{hasWebDetails(d.activities) ? " · " + unpricedLabel(unpricedStopCount(d.activities)) : ""} · {formatInr(d.total)}</span>
                                </span>
                              </h3>
                              <p className="planner-day__theme"><Highlight text={d.theme} query={searchQuery} /></p>
                            </div>
                            <button
                              type="button"
                              className="btn btn--primary timeline__edit-btn"
                              onClick={() => startEdit(d.day, d.title, d.theme)}
                            >
                              Edit
                            </button>
                          </div>
                          {chooseDayMedia(d.activities) === "carousel" ? (
                            <DayCarousel slides={selectSlides(d.activities)} active />
                          ) : (
                            <DayHero day={d} fallbackQuery={dayPlaceQuery(d, route.destination || sharedContext.context.destination || "")} />
                          )}
                          <div id={"day-body-" + d.day} className="planner-day__body">
                          {d.activities.length === 0 && <p className="planner-day__activity-hint">Free day - no planned activities.</p>}
                          {d.activities.map((a, i) => {
                            const key = stopKey(d.day, i);
                            if (filter.active && !filter.visibleStops.get(String(d.day))?.has(key)) return null;
                            const open = isStopOpen(openStops, key) || (filter.active && filter.detailsMatchStopIds.has(key));
                            const detailsId = "stop-details-" + key;
                            const noteOnly = (a.webDetails && a.priceSource !== "web") || (a.costNote && (a.costClass === "stay-checkin" || a.costClass === "route-transport" || a.costClass === "shopping"));
                            return (
                            <div key={i} className={"row planner-day__activity stop-row" + (open ? " is-open" : "")}>
                              {(() => {
                                const tr = formatTimeRange(a, d.activities[i + 1]);
                                return (
                                  <span className="stop-row__time">
                                    <strong>{tr.start}</strong>
                                    {tr.kind === "range" && tr.end ? <span className="stop-row__end">{"– " + tr.end}</span> : null}
                                    {tr.kind === "estimate" && tr.end ? <span className="stop-row__end">{"until about " + tr.end}</span> : null}
                                  </span>
                                );
                              })()}
                            <span className="stop-row__main">
                              <Highlight text={a.title} query={searchQuery} />
                            </span>
                            <span className="price-basis stop-row__price">
                              {a.webDetails && a.priceSource !== "web" ? (<PriceCellNote a={a} />) : a.costNote && (a.costClass === "stay-checkin" || a.costClass === "route-transport" || a.costClass === "shopping") ? (
                                <span className="price-cell__note">{a.costNote}</span>
                              ) : (
                                <span className="price-group"><span>{a.priceSource === "web" ? webAmountText(a.cost, a.sourceHost ?? "") : formatInr(a.cost)}</span>{" "}
                                <span className="price-cell__unit">{a.costBasis === "group" ? "per group" : "per person"}</span></span>
                              )}{" "}
                            </span>
                            <button
                              type="button"
                              className="stop-row__toggle"
                              aria-expanded={open}
                              aria-controls={detailsId}
                              onClick={() => setOpenStops((m) => toggleStop(m, key))}
                            >
                              {open ? "Hide details" : "Details"}
                            </button>
                            <StopDetails id={detailsId} open={open}>
                              {a.description ? <span className="planner-day__activity-hint">{a.description}</span> : null}
                              <StopMeta a={a} hasNext={i < d.activities.length - 1} />
                              {noteOnly ? null : (
                                <span className="price-basis">
                                  {a.webDetails ? null : <span className={"price-badge price-badge--" + (a.priceSource === "web" ? "web" : a.priceSource === "ai" ? "ai" : "estimated")}>{priceBadgeText(a)}</span>}{" "}
                                  {!a.webDetails && a.priceSource === "web" && a.sourceHost && a.sourceUrl && (
                                    <>
                                      <PriceSourceLink url={a.sourceUrl} host={a.sourceHost} />{" "}
                                      {a.checkedAt && <CheckedAt iso={a.checkedAt} />}{" "}
                                    </>
                                  )}
                                  <button
                                    type="button"
                                    className="price-basis__toggle"
                                    aria-expanded={openBasis[d.day + "-" + i] === true}
                                    aria-controls={"basis-" + d.day + "-" + i}
                                    onClick={() => setOpenBasis((pv) => ({ ...pv, [d.day + "-" + i]: !pv[d.day + "-" + i] }))}
                                  >
                                    {openBasis[d.day + "-" + i] === true ? "Hide basis" : "Price basis"}
                                  </button>
                                  {openBasis[d.day + "-" + i] === true && (
                                    <span id={"basis-" + d.day + "-" + i} className="price-basis__text">{a.priceBasis || ESTIMATED_BASIS}</span>
                                  )}
                                </span>
                              )}
                            </StopDetails>
                            </div>
                            );
                            })}
                          <div className="row">
                            <span>Day total{hasWebDetails(d.activities) ? " · " + unpricedLabel(unpricedStopCount(d.activities)) : ""}</span>
                            <span>{formatInr(d.total)}</span>
                          </div>
                          <MiscLine key={miscKeyForDay(d, miscDestination, miscTravellers)} day={d} result={misc[miscKeyForDay(d, miscDestination, miscTravellers)]} />
                          <div className="timeline__actions">
                            {/* Day-level budget edit via refineItinerary — revises
                                only this day's total, leaving unedited days
                                untouched (Req 8.3). Reuses existing `btn` class. */}
                            <button
                              type="button"
                              className="btn timeline__editday-btn"
                              onClick={() => setEditDayOpen(editDayOpen === d.day ? null : d.day)}
                            >
                              Edit Day
                            </button>
                            <button
                              type="button"
                              className="btn timeline__know-btn"
                              onClick={() => setKnowMoreDay(d.day)}
                            >
                              Know more
                            </button>
                          </div>
                          </div>
                          {editDayOpen === d.day && (
                            <EditDayPanel
                              seedQuery={dayPlaceQuery(d, route.destination || sharedContext.context.destination || "")}
                              destination={route.destination || sharedContext.context.destination || ""}
                              theme={d.theme}
                              activities={d.activities}
                              onAdd={(name) => addNamedPlace(d.day, name)}
                              onRemove={(idx) => removeDayActivity(d.day, idx)}
                              onClose={() => setEditDayOpen(null)}
                            />
                          )}
                          {knowMoreDay === d.day && (
                            <DayDetailModal
                              day={d}
                              destination={route.destination || sharedContext.context.destination || ""}
                              onClose={() => setKnowMoreDay(null)}
                            />
                          )}
                        </>
                      )}
                    </article>
                  </li>
                );
              })}
            </ol>
            <SourcesList sources={state.itinerary.sources} />

            {/* Live stays + flights for this trip (Google Hotels / Google
                Flights via SerpApi). Auto-fetched once the itinerary is ready;
                every price is real and links through to the full search. */}
            <section className="trip-live reveal" aria-label="Live prices for this trip">
              <div className="trip-live__head">
                <h3 className="trip-live__title">Live prices for your trip</h3>
                <p className="eyebrow">Real stays and flights for your dates - book on the provider's site</p>
              </div>
              {live.status === "loading" ? (
                <BrandLoader label="Fetching live stays and flights for your trip" size={130} />
              ) : (
                <div className="trip-live__sections">
                  <a className="trip-live__card" href={live.staysHref}>
                    <div className="trip-live__card-head">
                      <h4 className="trip-live__coltitle">Stays</h4>
                      <span className="trip-live__card-go">Open full search {"→"}</span>
                    </div>
                    {live.stays.length > 0 ? (
                      <p className="trip-live__card-meta">
                        {live.stays.length} live {live.stays.length === 1 ? "stay" : "stays"} for your dates {"·"} from{" "}
                        <strong>{INR_FMT.format(Math.min(...live.stays.map((h) => h.ratePerNight)))}</strong> / night
                      </p>
                    ) : (
                      <p className="trip-live__card-meta">Open the full stays search for live prices.</p>
                    )}
                  </a>
                  {noFlight ? (
                    <div className="trip-live__card" role="note">
                      <div className="trip-live__card-head">
                        <h4 className="trip-live__coltitle">Flights</h4>
                      </div>
                      <p className="trip-live__card-meta">{GROUND_TRANSPORT_NOTE}</p>{noFlight && state.itinerary.routeFare && <RouteFareLine fare={state.itinerary.routeFare} />}
                      {flightAvail === "no-flights" && (
                        <p className="trip-live__card-meta">No flights were found for your dates. Try different dates.</p>
                      )}
                    </div>
                  ) : (
                  <a className="trip-live__card" href={live.flightsHref}>
                    <div className="trip-live__card-head">
                      <h4 className="trip-live__coltitle">Flights</h4>
                      <span className="trip-live__card-go">Open full search {"→"}</span>
                    </div>
                    {live.flights.length > 0 ? (
                      <p className="trip-live__card-meta">
                        {live.flights.length} live {live.flights.length === 1 ? "fare" : "fares"} for your route {"·"} from{" "}
                        <strong>{INR_FMT.format(Math.min(...live.flights.map((f) => f.farePerPerson)))}</strong> / person
                      </p>
                    ) : (
                      <p className="trip-live__card-meta">Open the full flights search for live fares.</p>
                    )}
                  </a>
                  )}
                </div>
              )}
              {live.note && (
                <p className="trip-live__note" role="status">{live.note}</p>
              )}
            </section>
          </div>
        </div>
      )}
      {state && state.itinerary.days.length > 0 && (
        <TripAssistant
          itinerary={state.itinerary}
          context={sharedContext.context}
          resetKey={assistantGenRef.current}
          onApply={applyAssistantProposal}
          onRestore={restoreAssistantItinerary}
          estimate={(a) => withEstimatedActivity(a, route.destination || sharedContext.context.destination || "", usdInrRef.current, costOpts())}
        />
      )}
    </main>
  );
}