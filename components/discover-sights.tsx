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

/**
 * A single attributable Google review as surfaced by the place-details route
 * (narrowed to the fields this view renders). The route derives these from the
 * shared review engine; content is shown with explicit Google attribution and
 * never persisted (Req 3.4 / ToS attribution).
 */
interface GoogleReviewItem {
  author: string;
  rating: number;
  text: string;
}

/** The review summary fields this detail view actually consumes (narrow + nullable-safe). */
interface GoogleReviewSummary {
  hasReviews: boolean;
  score: number | null;
  count: number;
  source: string;
  items: GoogleReviewItem[];
  note: string;
}

/**
 * The additive Google enrichment block from /api/place-details. Present only on
 * a live/cached enrichment; `null`/absent on a Google fallback - every consumer
 * MUST guard on its presence so the detail view renders fully without it
 * (Req 5.3, 5.4, 10.2).
 */
interface GoogleEnrichment {
  mode: "live" | "cached";
  provider: string;
  rating: number | null;
  userRatingCount: number | null;
  priceLevel: number | null;
  reviews: GoogleReviewSummary;
  photos: Array<{ src: string; attribution: string }>;
}

interface PlaceDetails {
  name: string;
  destination: { data: { name: string; summary: string; places: string[] }; mode: string; provider: string };
  weather: { data: { destination: string; tempC: number; summary: string }; mode: string; provider: string };
  currency: { base: string; quote: string; rate: number; mode: string; provider: string } | null;
  /**
   * Additive Google enrichment. Optional + nullable: it is only present on a
   * live/cached result and is `null` on a Google fallback. Nothing in the view
   * depends on it (Req 5.3, 5.4, 10.2).
   */
  google?: GoogleEnrichment | null;
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
function StarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3.5l2.6 5.3 5.9.86-4.25 4.14 1 5.86L12 17.9l-5.25 2.77 1-5.86L3.5 9.66l5.9-.86L12 3.5z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
/** Directional arrow that nudges forward on hover (non-touch) - a premium affordance. */
function ArrowIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
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

/* ------------------------------ mosaic tile ------------------------------ */

/**
 * A single image-led gallery tile for the VARIED mosaic. Reuses the shared
 * `.hoverable` + `.image-frame` motion pattern so the real photo zooms (scale
 * ~1.04) inside a CLIPPED frame while the overlaid serif name + location label
 * stay perfectly stable and readable. On hover (non-touch) the whole tile lifts
 * slightly and the directional arrow nudges forward; on touch, a tap fires the
 * existing `onOpen` to open the live detail directly - the direct-to-detail
 * flow is unchanged.
 *
 * Imagery uses the existing `usePlaceImage` (/api/image), which already resolves
 * a REAL photo server-side (Google/Wikipedia) and never 404s. The fallback
 * ladder is: real photo (via /api/image) -> while unresolved, a token-coloured
 * placeholder frame (never a broken <img> and never the old checkerboard).
 *
 * `variant` selects the grid footprint (large featured vs medium) via a
 * namespaced modifier class; it does NOT change behaviour.
 */
function MosaicTile({
  place,
  slot,
  variant,
  onOpen,
}: {
  place: WorldPlace;
  slot: number;
  variant: "feature" | "medium";
  onOpen: (p: WorldPlace) => void;
}) {
  const img = usePlaceImage(`${place.name} ${place.country}`, slot);
  const category = place.tags && place.tags.length > 0 ? place.tags[0] : place.region;
  return (
    <button
      type="button"
      className={`disc-tile hoverable disc-tile--${variant}`}
      onClick={() => onOpen(place)}
      aria-label={`View ${place.name}, ${place.country}`}
    >
      <span className="disc-tile__frame image-frame" aria-hidden={!img}>
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={img} alt={place.name} loading="lazy" />
        ) : (
          // Fallback rung: no resolved photo yet -> token-coloured placeholder,
          // never a broken image or the old empty checkerboard.
          <span className="disc-tile__placeholder" aria-hidden="true" />
        )}
        <span className="disc-tile__scrim" aria-hidden="true" />
      </span>
      <span className="disc-tile__overlay">
        <span className="disc-tile__meta">
          <span className="disc-tile__label"><PinIcon /> {place.country || category}</span>
          <span className="disc-tile__arrow" aria-hidden="true"><ArrowIcon /></span>
        </span>
        <span className="disc-tile__title">{place.name}</span>
        <LiveChips place={place} />
      </span>
    </button>
  );
}

/* ------------------------------ detail view ------------------------------ */

function PlaceDetail({ place, onClose }: { place: WorldPlace; onClose: () => void }) {
  const [details, setDetails] = useState<PlaceDetails | null>(null);
  const [loading, setLoading] = useState(true);
  // Wikipedia-sourced images are a LOW-RES fallback only; the high-res Google
  // Place Photos (requested at a large width) are preferred for the gallery so
  // the detail view is sharp rather than pixelated.
  const heroFallback = usePlaceImage(`${place.name} ${place.country}`, 0);
  const altFallback = usePlaceImage(`${place.name} landmark`, 1);

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
  const google = details?.google ?? null;
  const googleRating = google && typeof google.rating === "number" && Number.isFinite(google.rating) ? google.rating : null;
  const googleReviewItems = google?.reviews?.hasReviews ? google.reviews.items ?? [] : [];
  // High-res Google photos (request a large width via the proxy's ?w=). These
  // are the primary gallery; the Wikipedia fallbacks fill in only if Google has
  // no photo for the place.
  const googlePhotos = (google?.photos ?? []).map((p) => ({
    src: p.src.includes("?") ? `${p.src}&w=1280` : `${p.src}?w=1280`,
    attribution: p.attribution,
  }));
  const gallery: Array<{ src: string; attribution?: string }> =
    googlePhotos.length > 0
      ? googlePhotos
      : [heroFallback, altFallback].filter((u): u is string => Boolean(u)).map((u) => ({ src: u }));

  const hasLiveSummary = Boolean(summary) && summary !== `Details for ${place.name} are temporarily unavailable.`;

  return (
    <div className="disc-detail" role="dialog" aria-modal="true" aria-label={`${place.name} details`}>
      <div className="disc-detail__backdrop" aria-hidden="true" onClick={onClose} />
      <div className="disc-detail__panel">
        {/* Top action bar: Add to trip FIRST (top), then Close. */}
        <div className="disc-detail__topbar">
          <a className="cta disc-detail__add" href={`/plan?dest=${encodeURIComponent(place.name)}`}>
            + Add {place.name} to trip
          </a>
          <button type="button" className="btn disc-detail__close" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        <div className="disc-detail__gallery">
          {gallery.length > 0 ? (
            gallery.slice(0, 4).map((g, idx) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={`${g.src}-${idx}`} className="disc-detail__img" src={g.src} alt={`${place.name} ${idx + 1}`} loading="lazy" />
            ))
          ) : (
            <span className="disc-detail__img disc-detail__img--empty" aria-hidden="true" />
          )}
        </div>

        <div className="disc-detail__body">
          <p className="eyebrow">{place.region}</p>
          <h2 className="disc-detail__title">{place.name}{place.country ? `, ${place.country}` : ""}</h2>

          {/* Live chips: weather + FX + Google rating, all live. */}
          <div className="disc-chips disc-chips--static">
            {typeof temp === "number" && Number.isFinite(temp) && <span className="disc-chip disc-chip--solid"><TempIcon /> {temp}&deg;C now</span>}
            {typeof rate === "number" && Number.isFinite(rate) && <span className="disc-chip disc-chip--solid"><CoinIcon /> 1 {place.currency} = {rate.toFixed(2)} INR</span>}
            {googleRating !== null && (
              <span className="disc-chip disc-chip--solid">
                <StarIcon /> {googleRating.toFixed(1)}/5
                {google && typeof google.userRatingCount === "number" && Number.isFinite(google.userRatingCount) ? ` (${google.userRatingCount})` : ""}
              </span>
            )}
          </div>

          {/* Why visit - live "what is special" blurb sourced from the live */}
          {/* destination summary; minimal history/facts follow as highlights. */}
          <h3 className="disc-detail__subhead">Why visit {place.name}</h3>
          <p className="disc-detail__summary">
            {loading ? "Loading live details..." : hasLiveSummary ? summary : place.blurb}
          </p>

          {prominent.length > 0 && (
            <>
              <h3 className="disc-detail__subhead">Highlights &amp; things to see</h3>
              <ul className="disc-detail__places">
                {prominent.slice(0, 6).map((p) => <li key={p}>{p}</li>)}
              </ul>
            </>
          )}

          {/* Attributable Google reviews (explicit attribution per ToS). */}
          {googleReviewItems.length > 0 && (
            <>
              <h3 className="disc-detail__subhead">Reviews</h3>
              <ul className="disc-detail__reviews">
                {googleReviewItems.map((rv, i) => (
                  <li key={`${rv.author}-${i}`} className="disc-detail__review">
                    <span className="disc-detail__review-head">
                      <span className="disc-detail__review-author">{rv.author}</span>
                      {Number.isFinite(rv.rating) && (
                        <span className="disc-chip disc-chip--solid disc-detail__review-rating">
                          <StarIcon /> {rv.rating.toFixed(1)}
                        </span>
                      )}
                    </span>
                    <p className="disc-detail__review-text">{rv.text}</p>
                  </li>
                ))}
              </ul>
              <p className="disc-detail__attribution">Reviews from Google</p>
            </>
          )}
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
      </button>
    </li>
  );
}

/* ------------------------- free-text query place ------------------------ */

/**
 * Build a synthetic WorldPlace from a free-text search query so the Discover
 * surface can show a result for ANY real place the user types - not only the
 * curated gallery list. The detail view fetches live data (summary, weather,
 * FX, Google photos/reviews) for the exact name, so a synthesized place still
 * renders full live content. Currency is left empty (the FX chip hides when
 * unknown); name/country are split from a "City, Region, Country" style query.
 */
function makeQueryPlace(query: string): WorldPlace {
  const parts = query.split(",").map((s) => s.trim()).filter(Boolean);
  const name = parts[0] || query.trim();
  const country = parts.length > 1 ? parts[parts.length - 1] : "";
  return {
    id: `q:${query.toLowerCase()}`,
    name,
    country,
    currency: "",
    blurb: `Live details for ${name}.`,
    region: "Asia",
    tags: [],
  };
}

/* -------------------------------- main ----------------------------------- */

export default function DiscoverSights() {
  // Deterministic seed for the FIRST (server + client) render to avoid a
  // hydration mismatch; we reshuffle on the client right after mount so the
  // surface still feels fresh each visit (Discover 'reshuffles every time').
  const [seed, setSeed] = useState(1);
  useEffect(() => { setSeed(Date.now() & 0x7fffffff); }, []);
  const places = useMemo(() => shuffledPlaces(seed), [seed]);
  const featured = places.slice(0, 8);

  const [open, setOpen] = useState<WorldPlace | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WorldPlace[] | null>(null);

  const onOpen = useCallback((p: WorldPlace) => setOpen(p), []);

  // Real-time Google autocomplete suggestions for the search box.
  const [acSuggestions, setAcSuggestions] = useState<Array<{ placeId: string; primary: string; secondary: string; text: string }>>([]);
  const [acOpen, setAcOpen] = useState(false);
  const acReq = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 1) { setAcSuggestions([]); setAcOpen(false); return; }
    const id = ++acReq.current;
    const timer = window.setTimeout(() => {
      fetch("/api/place-autocomplete?" + new URLSearchParams({ q }).toString())
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
        .then((d: { predictions?: Array<{ placeId: string; primary: string; secondary: string; text: string }> }) => {
          if (acReq.current !== id) return;
          const preds = d.predictions ?? [];
          setAcSuggestions(preds);
          setAcOpen(preds.length > 0);
        })
        .catch(() => { if (acReq.current === id) { setAcSuggestions([]); setAcOpen(false); } });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [query]);

  function chooseSuggestion(label: string) {
    setQuery(label);
    setAcOpen(false);
    // Go STRAIGHT to the live detail view for the picked place - no
    // intermediate result list to click through.
    const local = searchPlaces(label);
    setResults(null);
    setOpen(local.length > 0 ? local[0] : makeQueryPlace(label));
  }

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
    if (!q) { setResults(null); return; }
    // Submitting the search opens the live detail view for the best match
    // directly, rather than listing a card the user must click again.
    const local = searchPlaces(q);
    setResults(null);
    setOpen(local.length > 0 ? local[0] : makeQueryPlace(q));
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

        {/* Search FIRST, at the top, with realtime Google suggestions. */}
        <div className="disc-search__wrap">
        <form className="disc-search__bar disc-search__bar--top" onSubmit={runSearch} role="search">
          <span className="disc-search__icon" aria-hidden="true"><SearchIcon /></span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => { if (acSuggestions.length > 0) setAcOpen(true); }}
            onBlur={() => window.setTimeout(() => setAcOpen(false), 120)}
            role="combobox"
            aria-expanded={acOpen}
            aria-autocomplete="list"
            placeholder="Try beaches, mountains, Japan, temples..."
            aria-label="Search places"
          />
          <button type="submit" className="cta disc-search__cta">Search</button>
        </form>
          {acOpen && acSuggestions.length > 0 && (
            <ul className="disc-ac" role="listbox" aria-label="Place suggestions">
              {acSuggestions.map((s) => (
                <li key={s.placeId} className="disc-ac__item" role="option" aria-selected={false}>
                  <button type="button" className="disc-ac__btn" onMouseDown={(ev) => ev.preventDefault()} onClick={() => chooseSuggestion(s.primary + (s.secondary ? ", " + s.secondary : ""))}>
                    <span className="disc-ac__icon" aria-hidden="true"><PinIcon /></span>
                    <span className="disc-ac__text">
                      <span className="disc-ac__primary">{s.primary}</span>
                      {s.secondary ? <span className="disc-ac__secondary">{s.secondary}</span> : null}
                    </span>
                  </button>
                </li>
              ))}
              <li className="disc-ac__brand" aria-hidden="true">Powered by Google</li>
            </ul>
          )}
        </div>

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

      {/* Collections rail - the existing horizontal auto-scrolling carousel,
          kept and refined as a curated "collections" strip. */}
      <section className="disc-carousel" aria-label="Featured collections">
        <h2 className="section-title disc__h2 disc__h2--rail">Featured collections</h2>
        <div className="disc-carousel__track" ref={railRef}>
          {featured.map((p, i) => (
            <PlaceCard key={p.id} place={p} slot={i} onOpen={onOpen} />
          ))}
        </div>
      </section>

      {/* Varied image-led mosaic: ONE large featured tile + several medium tiles
          via CSS grid spanning, so no two tiles read identically. */}
      <section className="disc-gallery" aria-label="More places to explore">
        <h2 className="section-title disc__h2">Explore more</h2>
        <div className="disc-mosaic">
          {places.slice(8).map((p, i) => (
            <MosaicTile
              key={p.id}
              place={p}
              slot={i + 8}
              variant={i === 0 ? "feature" : "medium"}
              onOpen={onOpen}
            />
          ))}
        </div>
      </section>

      {open && <PlaceDetail place={open} onClose={() => setOpen(null)} />}
    </main>
  );
}
