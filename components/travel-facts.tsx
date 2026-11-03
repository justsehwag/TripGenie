"use client";

import { useEffect, useMemo, useState } from "react";
import { factsFor } from "@/lib/travel-facts";

/**
 * TravelFacts - a rotating "did you know" line shown beside the loading
 * animation while an itinerary drafts. It picks the curated fact set for the
 * destination (generic pool as fallback) and cycles through it every few
 * seconds. Presentational only; the lines are general facts/tips, nothing about
 * the user's specific booking is invented.
 *
 * Reduced motion: the cycling timer is disabled and a single fact is shown, so
 * there is no movement for travellers who prefer reduced motion. The line is an
 * aria-live polite region so the change is announced without stealing focus.
 */
export default function TravelFacts({ destination }: { destination?: string }) {
  const facts = useMemo(() => factsFor(destination), [destination]);
  const [i, setI] = useState(0);

  useEffect(() => {
    setI(0);
    if (facts.length <= 1) return;
    if (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return; // honour reduced motion: show a single fact, no cycling
    }
    const id = window.setInterval(() => {
      setI((prev) => (prev + 1) % facts.length);
    }, 3800);
    return () => window.clearInterval(id);
  }, [facts]);

  return (
    <p className="travel-facts" role="status" aria-live="polite">
      <span className="travel-facts__tag">Did you know</span>
      <span key={i} className="travel-facts__text">{facts[i]}</span>
    </p>
  );
}