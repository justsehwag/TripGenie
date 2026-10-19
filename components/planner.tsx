"use client";

import { useState } from "react";
import { parseRoute, emptyRouteState, routeConfirmed as _rc } from "@/lib/route-intake";
import { durationFromText } from "@/lib/date-intake";
import { recomputeWorkspace, flightOfferFare, type WorkspaceState } from "@/lib/workspace";

const INR = (n: number) => `INR ${n.toLocaleString("en-IN")}`;

export default function Planner() {
  const [request, setRequest] = useState("Goa from Delhi");
  const [duration, setDuration] = useState("4 days");
  const [travellers, setTravellers] = useState(2);
  const [vibe, setVibe] = useState("Culture & food");
  const [state, setState] = useState<WorkspaceState | null>(null);
  const [error, setError] = useState("");
  const [route, setRoute] = useState(emptyRouteState());

  function generate() {
    setError("");
    const r = parseRoute(request, emptyRouteState());
    setRoute(r);
    if (!r.destination) {
      setError("Tell me where you want to go - try \"Goa from Delhi\".");
      setState(null);
      return;
    }
    const days = durationFromText(duration) ?? 4;
    const next = recomputeWorkspace({
      destination: r.destination,
      startDate: new Date().toISOString().slice(0, 10),
      resolvedDays: days,
      vibes: [vibe],
      flight: 30000,
      stay: 20000,
    });
    setState(next);
  }

  const _ok=_rc;const fare = flightOfferFare(30000, travellers);

  return (
    <main className="shell">
      <p className="eyebrow">Planning workspace</p>
      <h1>Design your trip</h1>

      <section className="booking-surface" style={{ marginBottom: "1.5rem" }}>
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
            <input type="number" min={1} max={9} value={travellers} onChange={(e) => setTravellers(Math.max(1, Number(e.target.value) || 1))} />
          </label>
        </div>
        <label className="field">
          <span>Vibe</span>
          <input value={vibe} onChange={(e) => setVibe(e.target.value)} placeholder="Culture & food" />
        </label>
        <button className="cta" onClick={generate}>Generate itinerary</button>
        {error && <p style={{ color: "#b84a2e", marginBottom: 0 }}>{error}</p>}
      </section>

      {state && (
        <div className="grid-2">
          <div className="motion-rise">
            <h2 style={{ marginTop: 0 }}>{state.itinerary.title}</h2>
            {state.itinerary.days.map((d) => (
              <article key={d.day} className="glass" style={{ marginBottom: "1rem" }}>
                <h3 style={{ marginTop: 0 }}>Day {d.day} - {d.title}</h3>
                <p style={{ color: "#b84a2e", fontWeight: 700, marginTop: 0 }}>{d.theme}</p>
                {d.activities.map((a, i) => (
                  <div key={i} className="row">
                    <span><strong>{a.time}</strong> {a.title}</span>
                    <span>{INR(a.cost)}</span>
                  </div>
                ))}
                <div className="row"><span>Day total</span><span>{INR(d.total)}</span></div>
              </article>
            ))}
          </div>

          <aside className="booking-surface" style={{ alignSelf: "start", position: "sticky", top: "1rem" }}>
            <h3 style={{ marginTop: 0 }}>Trip summary</h3>
            <p className="lead" style={{ margin: "0 0 1rem" }}>{route.origin || "-"} to {route.destination}</p>
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
