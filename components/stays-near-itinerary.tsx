"use client";

import { useState } from "react";
import { useTripContext } from "@/components/trip-context";
import HotelsSection from "@/components/hotels-section";

/**
 * StaysNearItinerary - shows 30+ real Google hotels for a destination. Seeds
 * the destination from the Shared_Trip_Context when a trip was generated;
 * otherwise lets the traveler type a destination so real hotels always appear
 * (no longer gated behind having a generated itinerary). Distances to planned
 * spots are shown when an itinerary exists.
 */
export default function StaysNearItinerary() {
  const { context, itinerary } = useTripContext();
  const ctxDest = context.destination?.trim() ?? "";
  const [typed, setTyped] = useState("");
  const destination = (ctxDest || typed).trim();

  const spots =
    itinerary && Array.isArray(itinerary.days)
      ? itinerary.days.map((d) => d.title).filter((t) => typeof t === "string" && t.trim().length > 0)
      : [];

  return (
    <section className="stays-near" aria-label="Real hotels">
      {ctxDest ? (
        <p className="eyebrow">For your trip to {ctxDest}</p>
      ) : (
        <form className="stays-near__search" onSubmit={(e) => e.preventDefault()}>
          <label className="field">
            <span>Find real hotels in</span>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="e.g. Goa, Paris, Tokyo" aria-label="Destination for hotels" />
          </label>
        </form>
      )}
      {destination ? (
        <HotelsSection destination={destination} spots={spots} />
      ) : (
        <p className="hotels__loading">Type a destination above to see real hotels with ratings and reviews.</p>
      )}
    </section>
  );
}
