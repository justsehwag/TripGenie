"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { parseRoute, emptyRouteState, routeConfirmed as _rc } from "@/lib/route-intake";
import { durationFromText } from "@/lib/date-intake";
import { recomputeWorkspace, flightOfferFare, type WorkspaceState } from "@/lib/workspace";
import { calculateTripPricing } from "@/lib/pricing";
import { refineItinerary } from "@/lib/itinerary-engine";
import { illustration } from "@/lib/illustrations";
import { useTripContext } from "@/components/trip-context";
import LocationCarousel from "@/components/location-carousel";
import GamificationPanel from "@/components/gamification-panel";
import { emptyXp, award, type XpState, type XpEvent } from "@/lib/gamification";
import type { Activity, Itinerary, TripContext } from "@/lib/types";

const INR = (n: number) => `INR ${n.toLocaleString("en-IN")}`;

/** Marker illustration reused for every day node (Req 12.2, 17.5). */
const LOCATION_PIN = illustration("location-pin");

/** Default cost applied to a newly added activity (keeps totals coherent). */
const NEW_ACTIVITY_COST = 1500;

/** Per-click budget delta for the day-level refine control (Req 8.3). */
const DAY_BUDGET_STEP = 1000;

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
  // When arriving at /trip from the concierge, the context already holds a
  // destination: auto-generate the itinerary once on mount so the user lands on
  // a ready plan instead of an empty form (guarded so it never re-fires).
  const autoRanRef = useRef(false);
  useEffect(() => {
    if (autoRanRef.current) return;
    autoRanRef.current = true;
    // Results page (/itinerary): prefer the already-generated itinerary stored
    // in the shared context so the plan is shown INSTANTLY and never vanishes
    // on re-render - we do NOT call the LLM again here. Only regenerate if no
    // stored plan exists (e.g. direct navigation to /itinerary).
    if (resultsOnly) {
      const stored = sharedContext.itinerary;
      if (stored && Array.isArray(stored.days) && stored.days.length > 0) {
        setState(reprice(stored));
        setStatus("done");
        if (sharedContext.context.destination || sharedContext.context.origin) {
          setRoute((prev) => ({
            ...prev,
            destination: sharedContext.context.destination ?? prev.destination,
            origin: sharedContext.context.origin ?? prev.origin,
          }));
        }
        return;
      }
      void generate();
      return;
    }
    // Input page (/trip): auto-generate only when the concierge already handed
    // us a destination; otherwise wait for the user to submit the form.
    if (!sharedContext.context.destination) return;
    void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      earn("itinerary_generated");
      setStatus("done");
      if (!resultsOnly) { router.push("/itinerary"); return; }
    } catch {
      // Graceful offline fallback to the existing local synchronous build.
      const local = buildLocal(destination, days);
      setState(local);
      sharedContext.setItinerary(local.itinerary);
      earn("itinerary_generated");
      setStatus("done");
      if (!resultsOnly) { router.push("/itinerary"); return; }
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

      {!resultsOnly && (
      <section className="planner-chat">
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

        {/* Assistant message states: pending/in-progress skeleton while generating (Req 11.3). */}
        {generating && (
          <div className="card chat-message chat-message--pending motion-rise" aria-live="polite">
            <span className="chat-message__role">TripGenie is drafting your itinerary</span>
            <div className="chat-skeleton">
              <span className="chat-skeleton__line" />
              <span className="chat-skeleton__line" />
              <span className="chat-skeleton__line chat-skeleton__line--short" />
            </div>
          </div>
        )}
      </section>
      )}

      {state && (
        <div className="grid-2">
          {/* Completed assistant response — itinerary as a structured timeline
              of day-by-day activity cards with location markers and green
              journey indicators (Req 12.1, 12.2). */}
          <div className="chat-message chat-message--done motion-rise">
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
              {state.itinerary.days.map((d) => {
                const isEditing = editing?.day === d.day;
                return (
                  <li key={d.day} className="timeline__day">
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
                          {/* Image carousel for THIS day - a day-specific query so
                              every day pulls its own distinct photos (not one shared image). */}
                          <LocationCarousel
                            query={`${d.title} ${d.theme} ${route.destination || sharedContext.context.destination || ""}`.trim()}
                            seed={d.day}
                          />
                          {d.activities.map((a, i) => (
                            <div key={i} className="row">
                              <span>
                                <strong>{a.time}</strong> {a.title}
                              </span>
                              <span>{INR(a.cost)}</span>
                            </div>
                          ))}
                          <div className="row">
                            <span>Day total</span>
                            <span>{INR(d.total)}</span>
                          </div>
                          <div className="timeline__actions">
                            <button
                              type="button"
                              className="cta timeline__add-btn"
                              onClick={() => addActivity(d.day)}
                            >
                              Add activity
                            </button>
                            {/* Day-level budget edit via refineItinerary — revises
                                only this day's total, leaving unedited days
                                untouched (Req 8.3). Reuses existing `btn` class. */}
                            <button
                              type="button"
                              className="btn"
                              onClick={() => refineDay(d.day, DAY_BUDGET_STEP)}
                            >
                              Raise budget
                            </button>
                            <button
                              type="button"
                              className="btn"
                              onClick={() => refineDay(d.day, -DAY_BUDGET_STEP)}
                            >
                              Lower budget
                            </button>
                          </div>
                        </>
                      )}
                    </article>
                  </li>
                );
              })}
            </ol>
          </div>

          <aside className="card planner-summary">
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
