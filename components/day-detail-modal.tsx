"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom"; import { fallbackBrief, isEmptyBrief, truncateWords, type BriefFacts, type BriefSource, type DayBrief } from "@/lib/know-more/brief";

/**
 * DayDetailModal ("Know more") - detailed, real-time info for ONE day, in sync
 * with exactly the places shown in that day card. For each place of the day it
 * fetches /api/place-details and shows a real photo, Google rating, and the
 * place's own review (reviews live UNDER each place, never at the day level).
 * A place that does not resolve to real Google data shows only its text, so no
 * unrelated place/review ever appears.
 */

interface DayActivity { time: string; title: string; description: string; cost: number; }
interface DayInput { day: number; title: string; theme: string; activities: DayActivity[]; }

interface GoogleBlock {
  rating: number | null;
  userRatingCount: number | null;
  reviews: { hasReviews: boolean; items: Array<{ author: string; rating: number; text: string }> };
  photos: Array<{ src: string; attribution: string }>;
}
interface PlaceInfo {
  key: string;
  label: string;
  time: string;
  description: string;
  loading: boolean;
  google: GoogleBlock | null;
}

function withWidth(src: string, w: number): string {
  return src + (src.includes("?") ? "&w=" + w : "?w=" + w);
}

export default function DayDetailModal({ day, destination, onClose }: { day: DayInput; destination: string; onClose: () => void; }) {
  const [places, setPlaces] = useState<PlaceInfo[]>([]);
  const [mounted, setMounted] = useState(false); const [brief, setBrief] = useState<{ brief: DayBrief; source: BriefSource } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setMounted(true);
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    // Lock the page behind the modal so it cannot scroll or bleed through.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  useEffect(() => {
    const base: PlaceInfo[] = day.activities.map((a, i) => ({ key: a.title + "-" + i, label: a.title, time: a.time, description: a.description, loading: true, google: null }));
    setPlaces(base);
    let cancelled = false;
    day.activities.forEach((a, i) => {
      const q = (a.title + " " + destination).trim();
      fetch("/api/place-details?" + new URLSearchParams({ name: q }).toString())
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
        .then((d: { google?: GoogleBlock | null }) => { if (!cancelled) setPlaces((prev) => prev.map((p, idx) => (idx === i ? { ...p, loading: false, google: d.google ?? null } : p))); })
        .catch(() => { if (!cancelled) setPlaces((prev) => prev.map((p, idx) => (idx === i ? { ...p, loading: false } : p))); });
    });
    return () => { cancelled = true; };
  }, [day, destination]);

  // Once every place request has settled, ask for ONE short day brief built from those facts.
  useEffect(() => {
    if (places.length === 0 || places.some((p) => p.loading)) { setBrief(null); return; }
    const facts: BriefFacts = {
      destination, day: day.day,
      places: places.map((p) => {
        const r = p.google?.reviews?.hasReviews ? p.google.reviews.items[0] : null;
        return { title: p.label, time: p.time, description: p.description, rating: typeof p.google?.rating === "number" ? p.google.rating : null, ratingCount: typeof p.google?.userRatingCount === "number" ? p.google.userRatingCount : null, reviewExcerpt: r ? truncateWords(r.text, 25) : null };
      }),
    };
    let cancelled = false;
    const useFallback = () => { if (!cancelled) setBrief({ brief: fallbackBrief(facts), source: "itinerary" }); };
    fetch("/api/day-brief", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(facts) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((d: { brief?: DayBrief; source?: BriefSource }) => {
        if (cancelled) return;
        if (d.brief && !isEmptyBrief(d.brief) && d.source === "ai") setBrief({ brief: d.brief, source: "ai" });
        else if (d.brief && !isEmptyBrief(d.brief)) setBrief({ brief: d.brief, source: "itinerary" });
        else useFallback();
      })
      .catch(useFallback);
    return () => { cancelled = true; };
  }, [places, day.day, destination]);

  if (!mounted || typeof document === "undefined") return null;

  const briefSections: Array<[keyof DayBrief, string]> = [["highlights", "Highlights"], ["bestTime", "Best time"], ["tips", "Tips"], ["gettingThere", "Getting there"], ["goodToKnow", "Good to know"]];

  return createPortal(
    <div className="daydetail" role="dialog" aria-modal="true" aria-label={"Details for Day " + day.day}>
      <div className="daydetail__backdrop" aria-hidden="true" onClick={onClose} />
      <div className="daydetail__panel">
        <header className="daydetail__head">
          <div>
            <p className="eyebrow">Day {day.day} &middot; {destination}</p>
            <h2 className="daydetail__title">{day.title}</h2>
            <p className="daydetail__theme">{day.theme}</p>
          </div>
          <button ref={closeRef} type="button" className="btn daydetail__close" onClick={onClose} aria-label="Close">Close</button>
        </header>
        <div className="daydetail__body">
          <section className="daydetail__brief" aria-label="Day summary">
            {brief === null ? (
              <p className="daydetail__brief-loading">Preparing a short summary&hellip;</p>
            ) : (
              <>
                {briefSections.map(([key, title]) => brief.brief[key].length > 0 && (
                  <div key={key} className="daydetail__brief-section">
                    <h3 className="daydetail__brief-title">{title}</h3>
                    <ul className="daydetail__brief-list">
                      {brief.brief[key].map((b, i) => <li key={i}>{b}</li>)}
                    </ul>
                  </div>
                ))}
                <p className="daydetail__brief-label">{brief.source === "ai" ? "Summary written by AI from the details below. Check opening hours before you go." : "From your itinerary"}</p>
              </>
            )}
          </section>
          {places.map((p) => {
            const photo = p.google?.photos?.[0];
            const rating = p.google && typeof p.google.rating === "number" ? p.google.rating : null;
            const review = p.google?.reviews?.hasReviews ? p.google.reviews.items[0] : null;
            return (
              <article key={p.key} className="daydetail__place">
                <div className="daydetail__place-media img-layer">
                  {photo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="daydetail__place-img" src={withWidth(photo.src, 800)} alt={p.label} loading="lazy" />
                  ) : (
                    <span className="daydetail__place-img daydetail__place-img--empty" aria-hidden="true" />
                  )}
                  {rating !== null && (
                    <span className="daydetail__place-rating">&#9733; {rating.toFixed(1)}{p.google && p.google.userRatingCount ? " (" + p.google.userRatingCount.toLocaleString() + ")" : ""}</span>
                  )}
                </div>
                <div className="daydetail__place-body">
                  <h3 className="daydetail__place-name">{p.label}</h3>
                  <p className="daydetail__place-time"><strong>{p.time}</strong></p>
                  <p className="daydetail__place-desc">{p.description}</p>
                  {p.loading ? (
                    <p className="daydetail__place-loading">Loading real-time details&hellip;</p>
                  ) : review ? (
                    <blockquote className="daydetail__place-review">
                      <span className="daydetail__place-review-label">Google review excerpt</span> &ldquo;{truncateWords(review.text, 25)}&rdquo;
                      <cite>&mdash; {review.author}, via Google</cite>
                    </blockquote>
                  ) : (
                    <p className="daydetail__place-noreview">No verified Google review for this place yet.</p>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
