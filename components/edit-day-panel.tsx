"use client";

import { useEffect, useRef, useState } from "react";

/**
 * EditDayPanel ("Edit Day") - manage the places for a single day.
 *  - Lists the day's CURRENT places, each with a Remove (x) control.
 *  - Suggests RELEVANT real places (via /api/place-suggestions, Google Text
 *    Search seeded from the day theme + destination), each with a mini real
 *    photo and a short REASON it fits the day, and an Add control.
 * Fully guarded: no key / no results shows an honest empty state.
 */

interface DayActivity { time: string; title: string; description: string; cost: number; }
interface Suggestion { placeId: string; name: string; rating: number | null; userRatingCount: number | null; address: string; photo: { src: string; attribution: string } | null; }

function withWidth(src: string, w: number): string {
  return src + (src.includes("?") ? "&w=" + w : "?w=" + w);
}

/** A short, honest reason a suggestion fits this day (derived from real data). */
function reasonFor(s: Suggestion, theme: string): string {
  if (typeof s.rating === "number" && s.rating >= 4.5 && (s.userRatingCount ?? 0) >= 500) return "Top-rated spot travellers love";
  if (typeof s.rating === "number" && s.rating >= 4.2) return "Highly rated and popular";
  const t = theme.trim();
  if (t) return "Fits your \"" + t + "\" theme";
  return "Popular nearby place";
}

export default function EditDayPanel({
  seedQuery,
  destination,
  theme,
  activities,
  onAdd,
  onRemove,
  onClose,
}: {
  seedQuery: string;
  destination: string;
  theme: string;
  activities: DayActivity[];
  onAdd: (placeName: string) => void;
  onRemove: (index: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(seedQuery);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const reqRef = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (!q) { setSuggestions([]); setLoading(false); return; }
    const id = ++reqRef.current;
    setLoading(true);
    const t = window.setTimeout(() => {
      fetch("/api/place-suggestions?" + new URLSearchParams({ q }).toString())
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
        .then((d: { suggestions?: Suggestion[] }) => { if (reqRef.current === id) setSuggestions(Array.isArray(d.suggestions) ? d.suggestions : []); })
        .catch(() => { if (reqRef.current === id) setSuggestions([]); })
        .finally(() => { if (reqRef.current === id) setLoading(false); });
    }, 250);
    return () => window.clearTimeout(t);
  }, [query]);

  return (
    <div className="editday">
      <div className="editday__head">
        <h4 className="editday__title">Edit this day</h4>
        <button type="button" className="btn editday__close" onClick={onClose} aria-label="Close edit day">Done</button>
      </div>

      <div className="editday__current">
        <p className="eyebrow">Places in this day</p>
        {activities.length === 0 ? (
          <p className="editday__status">No places yet - add one from the suggestions below.</p>
        ) : (
          <ul className="editday__current-list">
            {activities.map((a, i) => (
              <li key={a.title + "-" + i} className="editday__current-item">
                <span className="editday__current-name">{a.title}</span>
                <button type="button" className="editday__remove" onClick={() => onRemove(i)} aria-label={"Remove " + a.title}>&times;</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="eyebrow editday__sugg-label">Suggested places for this day</p>
      <label className="field editday__search">
        <span className="sr-only">Search places</span>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={"Search places in " + destination} aria-label="Search places to add" />
      </label>
      {loading ? (
        <p className="editday__status">Finding relevant places&hellip;</p>
      ) : suggestions.length === 0 ? (
        <p className="editday__status">No places found. Try a different search.</p>
      ) : (
        <ul className="editday__grid">
          {suggestions.map((s) => (
            <li key={s.placeId} className="editday__card">
              <div className="editday__card-media img-layer">
                {s.photo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="editday__card-img" src={withWidth(s.photo.src, 480)} alt={s.name} loading="lazy" />
                ) : (
                  <span className="editday__card-img editday__card-img--empty" aria-hidden="true" />
                )}
              </div>
              <div className="editday__card-body">
                <span className="editday__card-name">{s.name}</span>
                {s.rating !== null && (
                  <span className="editday__card-rating">&#9733; {s.rating.toFixed(1)}{s.userRatingCount ? " (" + s.userRatingCount.toLocaleString() + ")" : ""}</span>
                )}
                <span className="editday__card-reason">{reasonFor(s, theme)}</span>
                <button type="button" className="cta editday__add" onClick={() => onAdd(s.name)}>Add to day</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
