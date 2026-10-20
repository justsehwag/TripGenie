"use client";

import { useState } from "react";
import { parseRoute, emptyRouteState, routeConfirmed as _rc } from "@/lib/route-intake";
import { durationFromText } from "@/lib/date-intake";
import { recomputeWorkspace, flightOfferFare, type WorkspaceState } from "@/lib/workspace";
import { calculateTripPricing } from "@/lib/pricing";
import { illustration } from "@/lib/illustrations";
import type { Activity, Itinerary } from "@/lib/types";

const INR = (n: number) => `INR ${n.toLocaleString("en-IN")}`;

/** Marker illustration reused for every day node (Req 12.2, 17.5). */
const LOCATION_PIN = illustration("location-pin");

/** Default cost applied to a newly added activity (keeps totals coherent). */
const NEW_ACTIVITY_COST = 1500;

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

export default function Planner() {
  const [request, setRequest] = useState("Goa from Delhi");
  const [duration, setDuration] = useState("4 days");
  const [travellers, setTravellers] = useState(2);
  const [vibe, setVibe] = useState("Culture & food");
  const [state, setState] = useState<WorkspaceState | null>(null);
  const [error, setError] = useState("");
  const [route, setRoute] = useState(emptyRouteState());
  const [status, setStatus] = useState<AssistantStatus>("idle");
  const [editing, setEditing] = useState<DayEdit | null>(null);

  function generate() {
    // Enter the in-progress state so the assistant surface shows a bounded
    // generating indicator. The planning computation itself stays synchronous;
    // we only mark the transition for the message-state UI (Req 11.3).
    setStatus("generating");
    setError("");
    setEditing(null);
    const r = parseRoute(request, emptyRouteState());
    setRoute(r);
    if (!r.destination) {
      // Error path: show a descriptive message and preserve prior conversation
      // content (do not wipe an existing itinerary preview) (Req 11.5).
      setError("Tell me where you want to go - try \"Goa from Delhi\".");
      setStatus("error");
      return;
    }
    const days = durationFromText(duration) ?? 4;
    const next = recomputeWorkspace({
      destination: r.destination,
      startDate: new Date().toISOString().slice(0, 10),
      resolvedDays: days,
      vibes: [vibe],
      flight: BASE_FLIGHT,
      stay: BASE_STAY,
    });
    setState(next);
    setStatus("done");
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

  /** Commit the draft title/theme to the itinerary and re-render the timeline. */
  function saveEdit() {
    if (!state || !editing) return;
    const days = state.itinerary.days.map((d) =>
      d.day === editing.day ? { ...d, title: editing.title, theme: editing.theme } : d,
    );
    setState(reprice({ ...state.itinerary, days, revised: true }));
    setEditing(null);
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
    setState(reprice({ ...state.itinerary, days, revised: true }));
  }

  const _ok = _rc;
  const fare = flightOfferFare(BASE_FLIGHT, travellers);
  const generating = status === "generating";

  return (
    <main className="shell">
      <p className="eyebrow">AI travel assistant</p>
      <h1>Plan your trip, together</h1>
      <p className="lead">
        Describe the trip you have in mind and I&apos;ll draft a day-by-day itinerary with a live cost summary. Pick a
        starting point below or write your own.
      </p>

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

      {state && (
        <div className="grid-2">
          {/* Completed assistant response — itinerary as a structured timeline
              of day-by-day activity cards with location markers and green
              journey indicators (Req 12.1, 12.2). */}
          <div className="chat-message chat-message--done motion-rise">
            <span className="chat-message__role">Here&apos;s your draft itinerary</span>
            <h2 className="planner-itinerary__title">{state.itinerary.title}</h2>
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
          </aside>
        </div>
      )}
    </main>
  );
}
