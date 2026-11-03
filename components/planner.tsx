"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { parseRoute, emptyRouteState, routeConfirmed as _rc } from "@/lib/route-intake";
import { durationFromText } from "@/lib/date-intake";
import { recomputeWorkspace, flightOfferFare, type WorkspaceState } from "@/lib/workspace";
import { calculateTripPricing } from "@/lib/pricing";
import { buildItineraryPdf } from "@/lib/pdf";
import { refineItinerary } from "@/lib/itinerary-engine";
import { illustration } from "@/lib/illustrations";
import { useTripContext } from "@/components/trip-context";
import { plannerDecision, type PlanSignal } from "@/lib/history/draft-gating";
import { useDestinationImage } from "@/components/destination-image";
import GooglePlaceMedia from "@/components/google-place-media";
import EditDayPanel from "@/components/edit-day-panel";
import DayDetailModal from "@/components/day-detail-modal";
import GamificationPanel from "@/components/gamification-panel";
import { emptyXp, award, type XpState, type XpEvent } from "@/lib/gamification";
import type { Activity, Itinerary, TripContext } from "@/lib/types";
import { serializeCriteria } from "@/lib/search-criteria";
import type { LiveHotel } from "@/lib/providers/serpapi-hotels";
import type { LiveFlight, PriceInsights } from "@/lib/providers/serpapi-flights";
import { checkedLabel as fmtCheckedLabel } from "@/lib/ist-time";
import type { FlightBookingCriteria } from "@/components/flight-booking-panel";
import BrandLoader from "@/components/brand-loader";
import TravelFacts from "@/components/travel-facts";

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

/** Default cost applied to a newly added activity (keeps totals coherent). */
const NEW_ACTIVITY_COST = 1500;

/** Per-click budget delta for the day-level refine control (Req 8.3). */
const DAY_BUDGET_STEP = 1000;

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
  const { url, alt } = useDestinationImage(query, 0);
  return (
    <header className="trip-cover reveal" aria-label="Trip overview">
      <div className="trip-cover__frame image-frame">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="trip-cover__img" src={url} alt={alt} />
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

/** Selectable example prompts that seed the request input (Req 11.2). */
const SUGGESTED_PROMPTS: ReadonlyArray<{ label: string; request: string; duration: string; vibe: string }> = [
  { label: "A relaxed 4-day Goa trip for two", request: "Goa from Delhi", duration: "4 days", vibe: "Relaxed & beachside" },
  { label: "5 days in Tokyo, food & culture", request: "Tokyo from Mumbai", duration: "5 days", vibe: "Culture & food" },
  { label: "Budget week in Bali", request: "Bali from Delhi", duration: "7 days", vibe: "Budget adventure" },
];

/** Base flight/stay fares used to seed and re-price the workspace. */
const BASE_FLIGHT = 30000;
const BASE_STAY = 20000;

/** A day under edit: which day number and the draft title/theme fields. */
type DayEdit = { day: number; title: string; theme: string };

export default function Planner({ resultsOnly = false }: { resultsOnly?: boolean } = {}) {
  const router = useRouter();
  const [request, setRequest] = useState("Goa from Delhi");
  const [duration, setDuration] = useState("4 days");
  const [travellers, setTravellers] = useState(2);
  const [vibe, setVibe] = useState("Culture & food");
  const [state, setState] = useState<WorkspaceState | null>(null);
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
  /** Add a real named place (from Edit Day suggestions) as a new activity on a day. */
  /** Remove an activity (place) from a day by index, then re-price. */
  function removeDayActivity(dayNum: number, index: number) {
    if (!state) return;
    const days = state.itinerary.days.map((d) => {
      if (d.day !== dayNum) return d;
      const activities = d.activities.filter((_, i) => i !== index);
      const total = activities.reduce((s, a) => s + a.cost, 0);
      return { ...d, activities, total };
    });
    const itinerary: Itinerary = { ...state.itinerary, days, revised: true };
    setState(reprice(itinerary));
    carryEditToContext(itinerary);
  }

  function addNamedPlace(dayNum: number, placeName: string) {
    if (!state) return;
    const days = state.itinerary.days.map((d) => {
      if (d.day !== dayNum) return d;
      const activity: Activity = { time: "Flexible", title: placeName, description: "Added from Edit Day suggestions.", cost: NEW_ACTIVITY_COST };
      const activities = [...d.activities, activity];
      const total = activities.reduce((s, a) => s + a.cost, 0);
      return { ...d, activities, total };
    });
    const itinerary: Itinerary = { ...state.itinerary, days, revised: true };
    setState(reprice(itinerary));
    carryEditToContext(itinerary);
  }
  // The single Shared_Trip_Context carried across pages (realtime-ai task 11.1).
  const sharedContext = useTripContext();
  // Deterministic, idempotent gamification state for this planning session.
  const [xp, setXp] = useState<XpState>(emptyXp);
  function earn(event: XpEvent) {
    setXp((prev) => award(prev, event));
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
  const [saveMsg, setSaveMsg] = useState("");
  const [saving, setSaving] = useState(false);
  // Live stays + flights for the generated trip (auto-fetched once ready).
  const [live, setLive] = useState<TripLive>(EMPTY_LIVE);

  /** Resolve the signed-in owner from the browser-local session (My Trips key). */
  function currentOwner(): string | null {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem("tripgenie.session");
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { userId?: string };
      return typeof parsed.userId === "string" && parsed.userId.trim() ? parsed.userId.trim() : null;
    } catch {
      return null;
    }
  }

  /**
   * Save the current itinerary to the user's account via POST /api/trips, which
   * persists through the DynamoDB-backed Trip_Store (newest-5 retention) - not
   * just browser-local. Signed-out users are prompted to sign in; the API also
   * refuses to persist without an owner.
   */
  async function saveTrip() {
    if (!state || saving) return;
    const owner = currentOwner();
    if (!owner) {
      setSaveMsg("Sign in to save this trip to your account.");
      window.setTimeout(() => router.push("/account"), 1200);
      return;
    }
    setSaving(true);
    setSaveMsg("");
    try {
      const res = await fetch("/api/trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner,
          clientDraftId: draftIdRef.current,
          name: state.itinerary.title,
          status: "ready",
          payload: {
            destination: route.destination || sharedContext.context.destination || "",
            origin: route.origin || sharedContext.context.origin || "",
            days: state.itinerary.days.length,
            totalCost: state.itinerary.totalCost,
            pricing: state.pricing,
            itinerary: state.itinerary,
          },
        }),
      });
      const data = (await res.json()) as { persisted?: boolean; error?: string };
      if (res.ok && data.persisted) {
        earn("trip_confirmed");
        setSaveMsg("Saved to your account. Find it under My trips.");
      } else {
        setSaveMsg(data.error || "Sign in to save this trip to your account.");
      }
    } catch {
      setSaveMsg("Could not save right now. Please try again.");
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
        setState(reprice(stored));
        setStatus("done");
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
   * Deterministic OFFLINE fallback — the original synchronous local build via
   * `recomputeWorkspace`. Kept verbatim so the planner never breaks when the
   * shared context is empty or `/api/ai` (Bedrock) is unreachable (Req 10.3).
   */
  function buildLocal(destination: string, days: number): WorkspaceState {
    return recomputeWorkspace({
      destination,
      startDate: new Date().toISOString().slice(0, 10),
      resolvedDays: days,
      vibes: [vibe],
      flight: BASE_FLIGHT,
      stay: BASE_STAY,
    });
  }

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
      sharedContext.setDates({
        ...sharedContext.dates,
        checkIn, checkOut, departDate: checkIn, returnDate: checkOut,
      });
    }
  }

  async function generate() {
    setStatus("generating");
    setError("");
    setEditing(null);

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

    const days =
      sharedContext.context.durationDays ?? durationFromText(duration) ?? 4;

    // Build the itinerary-request context from the shared context, falling back
    // to the local inputs for any field the shared context does not carry. Never
    // fabricate fields the traveler did not supply.
    const context: TripContext = {
      ...sharedContext.context,
      destination,
      durationDays: days,
      interests: sharedContext.context.interests ?? [vibe],
    };

    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "itinerary", context }),
      });
      if (!res.ok) throw new Error(`AI itinerary failed: ${res.status}`);
      const data = (await res.json()) as { itinerary: Itinerary };
      // Re-price the AI itinerary through the shared Pricing Engine so the trip
      // summary stays in lockstep with the rendered timeline.
      setState(reprice(data.itinerary));
      sharedContext.setItinerary(data.itinerary);
      carryTripDatesToContext(data.itinerary);
      earn("itinerary_generated");
      setStatus("done");
      if (!resultsOnly) { router.push("/itinerary"); return; }
    } catch {
      // Graceful offline fallback to the existing local synchronous build.
      try {
        const local = buildLocal(destination, days);
        if (
          !local.itinerary ||
          !Array.isArray(local.itinerary.days) ||
          local.itinerary.days.length === 0
        ) {
          // The fallback produced nothing usable: show the explicit
          // Empty_Start_State with an error rather than fabricating content.
          throw new Error("empty local build");
        }
        setShowEmptyStart(false);
        setState(local);
        sharedContext.setItinerary(local.itinerary);
        carryTripDatesToContext(local.itinerary);
        earn("itinerary_generated");
        setStatus("done");
        if (!resultsOnly) { router.push("/itinerary"); return; }
      } catch {
        // Even the offline fallback is unavailable: do NOT fabricate an
        // itinerary. Surface the start prompt with an error indication (R6.8).
        setState(null);
        setError(
          "We couldn't build your plan right now. Try starting again in a moment.",
        );
        setStatus("error");
        setShowEmptyStart(true);
      }
    }
  }

  /** Populate the planner inputs from a suggested prompt, then generate. */
  function applyPrompt(p: (typeof SUGGESTED_PROMPTS)[number]) {
    setRequest(p.request);
    setDuration(p.duration);
    setVibe(p.vibe);
  }

  /**
   * Re-price a WorkspaceState after an itinerary mutation so the trip summary
   * stays in lockstep with the timeline. The activities subtotal is re-derived
   * from the edited itinerary's per-day totals and fed back through the shared
   * Pricing Engine with the same flight/stay base, mirroring recomputeWorkspace's
   * invariant (activities subtotal always equals the rendered itinerary).
   */
  function reprice(itinerary: Itinerary): WorkspaceState {
    const activities = itinerary.days.reduce((s, d) => s + d.total, 0);
    const pricing = calculateTripPricing({ flight: BASE_FLIGHT, stay: BASE_STAY, activities });
    return { itinerary: { ...itinerary, totalCost: activities }, pricing };
  }

  /** Begin editing a day's title/theme. */
  function startEdit(day: number, title: string, theme: string) {
    setEditing({ day, title, theme });
  }

  /**
   * Carry an itinerary edit back into the single Shared_Trip_Context so any
   * subsequent page reads the updated values (Req 4.7). We only mirror fields
   * the edit actually touched — the destination and the resolved duration
   * (days) — through the provider's shallow-merge `patchContext`; no other
   * context field is fabricated or disturbed.
   */
  function carryEditToContext(itinerary: Itinerary) {
    sharedContext.patchContext({ durationDays: itinerary.days.length });
  }

  /** Commit the draft title/theme to the itinerary and re-render the timeline. */
  function saveEdit() {
    if (!state || !editing) return;
    const days = state.itinerary.days.map((d) =>
      d.day === editing.day ? { ...d, title: editing.title, theme: editing.theme } : d,
    );
    const itinerary: Itinerary = { ...state.itinerary, days, revised: true };
    setState(reprice(itinerary));
    carryEditToContext(itinerary);
    setEditing(null);
  }

  /**
   * Adjust a single day's budget via `refineItinerary` from the itinerary
   * engine. The engine revises ONLY the targeted day's total (clamped >= 0) and
   * recomputes the trip total, leaving every unedited day byte-identical — i.e.
   * the edit never regenerates the rest of the itinerary (Req 8.3). We then
   * re-price through the shared Pricing Engine and mirror the edit back into the
   * Shared_Trip_Context (Req 4.7).
   */
  function refineDay(day: number, budgetDelta: number) {
    if (!state) return;
    const itinerary = refineItinerary(state.itinerary, day, budgetDelta);
    setState(reprice(itinerary));
    carryEditToContext(itinerary);
    earn("day_refined");
  }

  /**
   * Append a new activity to a day: recompute that day's total (sum of its
   * activities) and re-price the trip so the summary aside stays consistent
   * (Req 12.4). This is a real, immutable mutation of the rendered itinerary.
   */
  function addActivity(day: number) {
    if (!state) return;
    const days = state.itinerary.days.map((d) => {
      if (d.day !== day) return d;
      const activity: Activity = {
        time: "17:00",
        title: `Free time in ${route.destination || "town"}`,
        description: "An added activity you can tailor further.",
        cost: NEW_ACTIVITY_COST,
      };
      const activities = [...d.activities, activity];
      const total = activities.reduce((s, a) => s + a.cost, 0);
      return { ...d, activities, total };
    });
    const itinerary: Itinerary = { ...state.itinerary, days, revised: true };
    setState(reprice(itinerary));
    carryEditToContext(itinerary);
  }

  /**
   * Export the current itinerary to a polished, dependency-free PDF via the
   * existing uildItineraryPdf builder, then trigger a browser download. Maps
   * the planner's itinerary days onto the builder's TripDay shape, supplying a
   * date per day (today + dayIndex) so the PDF reads with real calendar dates.
   */
  function exportPdf() {
    if (!state) return;
    const base = new Date();
    const days = state.itinerary.days.map((d, idx) => {
      const dt = new Date(base.getTime() + idx * 86400000);
      return {
        day: d.day,
        date: dt.toISOString().slice(0, 10),
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
      ? serializeCriteria({ category: "stays", destination: dest, checkIn, checkOut, guests: travellers, rooms: 1 })
      : "";
    const flightsC = isDate(checkIn) && isDate(checkOut) && checkOut > checkIn && dest && orig
      ? serializeCriteria({ category: "flights", tripType: "round-trip", origin: orig, destination: dest, departDate: checkIn, returnDate: checkOut, travellers, cabin: "economy" })
      : "";
    const staysHref = staysC ? `/stays?${staysC}` : "/stays";
    const flightsHref = flightsC ? `/flights?${flightsC}` : "/flights";
    const nights = (() => {
      const a = Date.parse(checkIn), b = Date.parse(checkOut);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 1;
      return Math.max(1, Math.round((b - a) / 86_400_000));
    })();
    const staysCriteria = dest ? { destination: dest, checkIn, checkOut, adults: travellers, rooms: 1 } : null;
    const flightsCriteria: FlightBookingCriteria | null = (dest && orig)
      ? { origin: orig, destination: dest, tripType: "round-trip", departDate: checkIn, returnDate: checkOut, cabin: "economy", travellers }
      : null;
    if (!dest || !isDate(checkIn) || !isDate(checkOut)) {
      setLive({ ...EMPTY_LIVE, status: "ready", staysHref, flightsHref,
        note: "Add your travel dates and route in the chat to see live stays and flights for this trip." });
      return;
    }
    const key = `${orig}|${dest}|${checkIn}|${checkOut}|${travellers}`;
    if (liveKeyRef.current === key) return;
    liveKeyRef.current = key;
    let cancelled = false;
    setLive((pv) => ({ ...pv, status: "loading", staysHref, flightsHref, note: null, nights, staysCriteria, flightsCriteria }));
    const qs = new URLSearchParams({ origin: orig, destination: dest, checkIn, checkOut, travellers: String(travellers), cabin: "economy", tripType: "round-trip" });
    fetch(`/api/trip-live?${qs.toString()}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data: {
        stays?: { status: string; provider?: string; currency?: string; checkedAt?: string; hotels?: LiveHotel[]; error?: string };
        flights?: { status: string; provider?: string; currency?: string; checkedAt?: string; insights?: PriceInsights | null; flights?: LiveFlight[]; error?: string };
      }) => {
        if (cancelled) return;
        const hotels = data.stays?.status === "live" ? (data.stays.hotels ?? []) : [];
        const fl = data.flights?.status === "live" ? (data.flights.flights ?? []) : [];
        const notes: string[] = [];
        if (hotels.length === 0) notes.push("live stays");
        if (fl.length === 0) notes.push("live flights");
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
  }, [state, route.destination, route.origin, travellers, sharedContext.context.destination, sharedContext.context.origin]);

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

  const _ok = _rc;
  const fare = flightOfferFare(BASE_FLIGHT, travellers);
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

      {!resultsOnly && (
      <section className="planner-chat">
        {!generating && (
        <>
        <div className="chat-suggestions" role="group" aria-label="Suggested prompts">
          <span className="chat-suggestions__label">Try one of these</span>
          <div className="chat-suggestions__chips">
            {SUGGESTED_PROMPTS.map((p) => (
              <button
                key={p.label}
                type="button"
                className="chat-chip"
                onClick={() => applyPrompt(p)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="card planner-composer">
          <label className="field">
            <span>Where to?</span>
            <input value={request} onChange={(e) => setRequest(e.target.value)} placeholder="Goa from Delhi" />
          </label>
          <div className="field-row">
            <label className="field">
              <span>How long?</span>
              <input value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="4 days" />
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
            {/* AI regenerate — re-invokes the existing async `generate()` path
                (POST /api/ai action:"itinerary") from the CURRENT shared context
                and reuses the existing `generating`/`status` loading UI; no new
                loading state is introduced (Req 8.4). Reuses the `cta` class. */}
            <div className="timeline__actions">
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
                aria-label={saving ? "Saving trip" : "Save this trip"}
                title={saving ? "Saving..." : "Save this trip"}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M6 3h10l4 4v12.5a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 19.5v-15A1.5 1.5 0 015.5 3z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                  <path d="M8 3v5h7V3M8 21v-6h8v6" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
            {saveMsg && (
              <p className="chat-status planner-save-msg" role="status">{saveMsg}</p>
            )}
            <ol className="timeline planner-itinerary">
              {state.itinerary.days.map((d, di) => {
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
                    <article className="card planner-day timeline__card">
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
                              <h3 className="planner-day__title">
                                Day {d.day} - {d.title}
                              </h3>
                              <p className="planner-day__theme">{d.theme}</p>
                            </div>
                            <button
                              type="button"
                              className="btn btn--primary timeline__edit-btn"
                              onClick={() => startEdit(d.day, d.title, d.theme)}
                            >
                              Edit
                            </button>
                          </div>
                          <GooglePlaceMedia query={dayPlaceQuery(d, route.destination || sharedContext.context.destination || "")} />
                          {d.activities.map((a, i) => (
                            <div key={i} className="row planner-day__activity" tabIndex={0}>
                              <span>
                                <strong>{a.time}</strong> {a.title}
                                {a.description ? <span className="planner-day__activity-hint">{a.description}</span> : null}
                              </span>
                              <span>{INR(a.cost)}</span>
                            </div>
                          ))}
                          <div className="row">
                            <span>Day total</span>
                            <span>{INR(d.total)}</span>
                          </div>
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
                </div>
              )}
              {live.note && (
                <p className="trip-live__note" role="status">{live.note}</p>
              )}
            </section>
          </div>

          <aside className="card planner-summary planner-results__aside reveal">
            <h3 className="planner-summary__title">Trip summary</h3>
            <p className="lead planner-summary__route">
              {route.origin || "-"} to {route.destination}
            </p>
            <div className="row"><span>Flight (per person)</span><span>{INR(fare.perPerson)}</span></div>
            <div className="row"><span>Flight x {fare.travellers}</span><span>{INR(fare.party)}</span></div>
            <div className="row"><span>Stay</span><span>{INR(state.pricing.stay)}</span></div>
            <div className="row"><span>Activities</span><span>{INR(state.pricing.activities)}</span></div>
            <div className="row"><span>Gross</span><span>{INR(state.pricing.gross)}</span></div>
            <div className="row"><span>Final payable</span><span>{INR(state.pricing.finalPayable)}</span></div>

            {/* Gamification: deterministic XP/level/badges/quests for this
                planning session (TripSaathi parity, FR-06). */}
            <GamificationPanel state={xp} />
          </aside>
        </div>
      )}
    </main>
  );
}