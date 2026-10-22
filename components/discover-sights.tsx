"use client";

/**
 * Discover - a dynamic tourist-place search engine (TripGenie).
 *
 * Dynamic by design: on every mount the world-places list is shuffled with a
 * fresh seed, so the surface "refreshes" each visit. A large hero carousel of
 * beautiful places leads; each card shows a REAL image thumbnail with live
 * temperature + currency chips and small symbol overlays. Clicking a card opens
 * a detail view (live Wikipedia summary, prominent places, weather, FX). Below,
 * a search box returns map-style result cards (real photos + a static map panel)
 * for any query. All imagery comes from the existing /api/image route; live
 * signals from /api/place-details. Token-only styling; original inline SVG
 * icons (no third-party/brand art).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shuffledPlaces, searchPlaces, type WorldPlace } from "@/lib/world-places";

/* ----------------------------- live data hooks --------------------------- */

interface PlaceDetails {
  name: string;
  destination: { data: { name: string; summary: string; places: string[] }; mode: string; provider: string };
  weather: { data: { destination: string; tempC: number; summary: string }; mode: string; provider: string };
  currency: { base: string; quote: string; rate: number; mode: string; provider: string } | null;
}

/** Resolve one real image for a place from /api/image; null until loaded. */
function usePlaceImage(query: string, slot: number): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ kind: "destination", query, slot: String(slot) });
    fetch(`/api/image?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((d: { url?: string }) => { if (!cancelled && d?.url) setUrl(d.url); })
      .catch(() => { if (!cancelled) setUrl(null); });
    return () => { cancelled = true; };
  }, [query, slot]);
  return url;
}

/* ------------------------------- icons ----------------------------------- */

function PinIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 21s7-6.3 7-11a7 7 0 10-14 0c0 4.7 7 11 7 11z" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="10" r="2.4" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}
function TempIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M14 14.8V5a2 2 0 10-4 0v9.8a4 4 0 104 0z" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}
function CoinIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9.5 9.5h3.2a1.8 1.8 0 010 3.6H10m0 0h3.2m-3.2 0v2.4m0-7.4V7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.8" />
      <line x1="10.8" y1="10.8" x2="14" y2="14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/* --------------------------- live chips overlay -------------------------- */

/** Fetches live weather + FX for a place and renders them as overlay chips. */
function LiveChips({ place }: { place: WorldPlace }) {
  const [temp, setTemp] = useState<number | null>(null);
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ name: place.name, currency: place.currency });
    fetch(`/api/place-details?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((d: PlaceDetails) => {
        if (cancelled) return;
        const t = d.weather?.data?.tempC;
        if (typeof t === "number" && Number.isFinite(t)) setTemp(t);
        if (d.currency && Number.isFinite(d.currency.rate)) setRate(d.currency.rate);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [place.name, place.currency]);

  return (
    <div className="disc-chips" aria-hidden="false">
      <span className="disc-chip"><PinIcon /> {place.country}</span>
      {temp !== null && <span className="disc-chip"><TempIcon /> {temp}&deg;C</span>}
      {rate !== null && (
        <span className="disc-chip"><CoinIcon /> 1 {place.currency} = {rate.toFixed(2)} INR</span>
      )}
    </div>
  );
}

/* ------------------------------ place card ------------------------------- */

function PlaceCard({ place, slot, onOpen }: { place: WorldPlace; slot: number; onOpen: (p: WorldPlace) => void }) {
  const img = usePlaceImage(`${place.name} ${place.country}`, slot);
  return (
    <button type="button" className="disc-card" onClick={() => onOpen(place)} aria-label={`View ${place.name}, ${place.country}`}>
      <span className="disc-card__media img-layer" aria-hidden={!img}>
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="img-layer__img" src={img} alt={place.name} loading="lazy" />
        ) : null}
        <span className="disc-card__scrim" aria-hidden="true" />
      </span>
      <span className="disc-card__overlay">
        <span className="disc-card__title">{place.name}</span>
        <LiveChips place={place} />
      </span>
    </button>
  );
}

/* ------------------------------ detail view ------------------------------ */

function PlaceDetail({ place, onClose }: { place: WorldPlace; onClose: () => void }) {
  const [details, setDetails] = useState<PlaceDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const hero = usePlaceImage(`${place.name} ${place.country}`, 0);
  const alt = usePlaceImage(`${place.name} landmark`, 1);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ name: place.name, currency: place.currency });
    fetch(`/api/place-details?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((d: PlaceDetails) => { if (!cancelled) setDetails(d); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [place.name, place.currency]);

  const temp = details?.weather?.data?.tempC;
  const rate = details?.currency?.rate;
  const summary = details?.destination?.data?.summary;
  const prominent = details?.destination?.data?.places ?? [];

  return (
    <div className="disc-detail" role="dialog" aria-modal="true" aria-label={`${place.name} details`}>
      <div className="disc-detail__backdrop" aria-hidden="true" onClick={onClose} />
      <div className="disc-detail__panel">
        <button type="button" className="btn disc-detail__close" onClick={onClose} aria-label="Close">
          Close
        </button>
        <div className="disc-detail__gallery">
          {[hero, alt].map((u, idx) =>
            u ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={idx} className="disc-detail__img" src={u} alt={`${place.name} ${idx + 1}`} loading="lazy" />
            ) : (
              <span key={idx} className="disc-detail__img disc-detail__img--empty" aria-hidden="true" />
            ),
          )}
        </div>
        <div className="disc-detail__body">
          <p className="eyebrow">{place.region}</p>
          <h2 className="disc-detail__title">{place.name}, {place.country}</h2>
          <div className="disc-chips disc-chips--static">
            {typeof temp === "number" && Number.isFinite(temp) && <span className="disc-chip disc-chip--solid"><TempIcon /> {temp}&deg;C now</span>}
            {typeof rate === "number" && Number.isFinite(rate) && <span className="disc-chip disc-chip--solid"><CoinIcon /> 1 {place.currency} = {rate.toFixed(2)} INR</span>}
          </div>
          <p className="disc-detail__summary">{loading ? "Loading live details..." : summary || place.blurb}</p>
          {prominent.length > 0 && (
            <>
              <h3 className="disc-detail__subhead">Prominent places</h3>
              <ul className="disc-detail__places">
                {prominent.slice(0, 6).map((p) => <li key={p}>{p}</li>)}
              </ul>
            </>
          )}
          <a className="cta disc-detail__cta" href={`/plan?q=${encodeURIComponent(place.name)}`}>
            Plan a trip to {place.name}
          </a>
        </div>
      </div>
    </div>
  );
}

/* ------------------------- search result (map-style) --------------------- */

function SearchResultCard({ place, slot, onOpen }: { place: WorldPlace; slot: number; onOpen: (p: WorldPlace) => void }) {
  const img = usePlaceImage(`${place.name} ${place.country}`, slot);
  // Static OpenStreetMap-style thumbnail is not available without a key; we use
  // a labelled map-placeholder panel plus the real photo so the row reads like
  // a maps result without calling an unconfigured maps provider.
  return (
    <li className="disc-result">
      <button type="button" className="disc-result__btn" onClick={() => onOpen(place)}>
        <span className="disc-result__photo img-layer" aria-hidden={!img}>
          {img ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="img-layer__img" src={img} alt={place.name} loading="lazy" />
          ) : null}
        </span>
        <span className="disc-result__text">
          <span className="disc-result__name">{place.name}</span>
          <span className="disc-result__meta"><PinIcon /> {place.country} &middot; {place.region}</span>
          <span className="disc-result__blurb">{place.blurb}</span>
        </span>
        <span className="disc-result__map" aria-hidden="true">
          <span className="disc-result__map-pin"><PinIcon /></span>
          <span className="disc-result__map-label">Map</span>
        </span>
      </button>
    </li>
  );
}

/* -------------------------------- main ----------------------------------- */

export default function DiscoverSights() {
  // Fresh shuffle per mount -> dynamic ordering every visit.
  const [seed] = useState(() => (typeof window !== "undefined" ? Date.now() : 1) & 0x7fffffff);
  const places = useMemo(() => shuffledPlaces(seed), [seed]);
  const featured = places.slice(0, 8);

  const [open, setOpen] = useState<WorldPlace | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WorldPlace[] | null>(null);

  const onOpen = useCallback((p: WorldPlace) => setOpen(p), []);

  // Auto-scrolling carousel (no manual drag): advance one card every 3.5s and
  // loop back to the start at the end. Honors prefers-reduced-motion.
  const railRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const reduce = typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;
    if (reduce) return;
    const id = window.setInterval(() => {
      const card = el.querySelector<HTMLElement>(".disc-card");
      const step = card ? card.offsetWidth + 24 : 320;
      const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 8;
      el.scrollTo({ left: atEnd ? 0 : el.scrollLeft + step, behavior: "smooth" });
    }, 3500);
    return () => window.clearInterval(id);
  }, []);

  function runSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    setResults(q ? searchPlaces(q) : null);
  }

  return (
    <main className="shell disc">
      <section className="motion-rise disc__intro">
        <p className="eyebrow">Discover</p>
        <h1 className="display">Find your next place to wander</h1>
        <p className="lead">
          Search a country, a city or a vibe, or browse the gallery below - it
          reshuffles every time you open it. Each card carries a real photo with
          the local temperature and exchange rate; tap any place for live details.
        </p>

        {/* Search FIRST, at the top. */}
        <form className="disc-search__bar disc-search__bar--top" onSubmit={runSearch} role="search">
          <span className="disc-search__icon" aria-hidden="true"><SearchIcon /></span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Try beaches, mountains, Japan, temples..."
            aria-label="Search places"
          />
          <button type="submit" className="cta disc-search__cta">Search</button>
        </form>

        {results !== null && (
          results.length > 0 ? (
            <ul className="disc-results" aria-label={`Results for ${query}`}>
              {results.map((p, i) => (
                <SearchResultCard key={p.id} place={p} slot={i} onOpen={onOpen} />
              ))}
            </ul>
          ) : (
            <p className="disc-search__empty">No matches for &ldquo;{query}&rdquo;. Try a country, a region, or a vibe like &ldquo;beach&rdquo;.</p>
          )
        )}
      </section>

      {/* Hero carousel of beautiful places */}
      <section className="disc-carousel" aria-label="Featured beautiful places">
        <div className="disc-carousel__track" ref={railRef}>
          {featured.map((p, i) => (
            <PlaceCard key={p.id} place={p} slot={i} onOpen={onOpen} />
          ))}
        </div>
      </section>

      {/* Full gallery grid */}
      <section className="disc-gallery" aria-label="More places to explore">
        <h2 className="section-title disc__h2">Explore more</h2>
        <div className="disc-grid">
          {places.slice(8).map((p, i) => (
            <PlaceCard key={p.id} place={p} slot={i + 8} onOpen={onOpen} />
          ))}
        </div>
      </section>

      {open && <PlaceDetail place={open} onClose={() => setOpen(null)} />}
    </main>
  );
}