"use client";

/**
 * Destination_Panel (realtime-ai-integration spec, tasks 9.2 + 9.4 — design
 * "Live-data surfacing").
 *
 * An ADDITIVE, presentational client panel for the Home / Discover surface. It
 * is mounted BELOW the existing "Popular destinations" rail (task 9.2/9.4) and
 * rendered only once a destination is chosen — it adds no new homepage section,
 * removes/restyles nothing, and renders exclusively through EXISTING class names
 * (`card`, `section-title`, `section-sub`, `eyebrow`, `lead`, `results__empty`,
 * `results__error`, `results__partial`) plus the already-built
 * {@link FreshnessIndicator}. It introduces NO new design token, `:root` var, or
 * styled class of its own, and adds NO runtime dependency.
 *
 * Given a destination name it issues GET-only reads (Req 5.7) against the
 * existing read-only adapters:
 *   - `/api/destination` → `LiveResult<DestinationInfo { name, summary, places }>`
 *   - `/api/weather`     → `LiveResult<WeatherInfo { destination, tempC, summary }>`
 * surfacing destination details + a short attractions/places list (Req 5.1, 7.3),
 * current weather (Req 5.2), the destination's current local time where a
 * timezone resolves (Req 5.4), and a couple of short, clearly-generic travel
 * tips (Req 7.3). Each live reading carries a Freshness_Indicator (Req 5.5/5.6);
 * a fallback reading is shown labelled and never dressed up as a live reading.
 *
 * States (Req 10.1–10.4), all through existing classes and with no layout
 * change:
 *   - Empty_State  — no destination chosen yet → prompt to pick one.
 *   - Loading_State — a `card` + `results__partial` "Loading…" line while a read
 *     is pending.
 *   - Error_State  — a `card results__error` message that preserves any data
 *     already shown.
 */

import { useEffect, useMemo, useState } from "react";
import {
  type DestinationInfo,
  type WeatherInfo,
  type LiveResult,
} from "@/lib/live-data";
import { FreshnessIndicator } from "@/components/freshness-indicator";

// ---------------------------------------------------------------------------
// Local time (Req 5.4) — resolvable via a deterministic IANA-timezone lookup.
// ---------------------------------------------------------------------------

/**
 * Deterministic city → IANA timezone lookup for destinations whose timezone we
 * can resolve WITHOUT a live call. This is a fixed, offline mapping (not live
 * data): when a destination is present here the panel renders the destination's
 * current local time via the browser's `Intl.DateTimeFormat`; otherwise it shows
 * the labelled "local time unavailable" state (Req 5.4 — "where resolvable").
 * Keys are matched case-insensitively against the chosen/returned name.
 */
const TIMEZONE_BY_CITY: Record<string, string> = {
  santorini: "Europe/Athens",
  athens: "Europe/Athens",
  bali: "Asia/Makassar",
  denpasar: "Asia/Makassar",
  tokyo: "Asia/Tokyo",
  dubai: "Asia/Dubai",
  paris: "Europe/Paris",
  "new york": "America/New_York",
  "new york city": "America/New_York",
  london: "Europe/London",
  rome: "Europe/Rome",
  barcelona: "Europe/Madrid",
  madrid: "Europe/Madrid",
  sydney: "Australia/Sydney",
  singapore: "Asia/Singapore",
  bangkok: "Asia/Bangkok",
  "hong kong": "Asia/Hong_Kong",
  istanbul: "Europe/Istanbul",
  "los angeles": "America/Los_Angeles",
  "san francisco": "America/Los_Angeles",
};

/** Resolve an IANA timezone for a destination name, or `null` when unknown. */
function resolveTimezone(name: string): string | null {
  const key = name.trim().toLowerCase();
  if (key in TIMEZONE_BY_CITY) return TIMEZONE_BY_CITY[key];
  // Also try the leading token (e.g. "Paris, France" → "paris").
  const head = key.split(/[,(]/)[0].trim();
  return head in TIMEZONE_BY_CITY ? TIMEZONE_BY_CITY[head] : null;
}

/**
 * Format the current local time + timezone for a resolvable destination, or
 * `null` when the timezone could not be resolved or formatting failed. Pure read
 * of the browser clock through `Intl` — no network, no fabrication.
 */
function formatLocalTime(name: string, now: Date): string | null {
  const tz = resolveTimezone(name);
  if (!tz) return null;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
      weekday: "short",
      timeZoneName: "short",
    });
    return fmt.format(now);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Travel tips (Req 7.3) — short, clearly-generic guidance, NOT live facts.
// ---------------------------------------------------------------------------

/**
 * A couple of short, clearly-generic travel tips. These are explicitly labelled
 * as general guidance (not live or destination-specific facts) so the panel
 * never presents fabricated live data (Req 5.6 honesty, 7.3 travel tips).
 */
const GENERIC_TRAVEL_TIPS: string[] = [
  "Check entry requirements and travel advisories before you book.",
  "Carry a little local currency for small purchases on arrival.",
  "Confirm the weather forecast closer to your dates and pack accordingly.",
];

// ---------------------------------------------------------------------------
// Fetch helpers — GET only (Req 5.7), AbortController-bounded.
// ---------------------------------------------------------------------------

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { method: "GET", signal });
  if (!res.ok) throw new Error(`request failed (${res.status})`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface DestinationPanelProps {
  /** The chosen destination name, or empty/undefined for the Empty_State. */
  destination?: string;
}

interface PanelData {
  destination: LiveResult<DestinationInfo> | null;
  weather: LiveResult<WeatherInfo> | null;
}

/**
 * Surface real destination details + attractions, weather, local time, and
 * short travel tips for a chosen destination. Renders the Empty_State until a
 * destination is provided.
 */
export default function DestinationPanel({ destination }: DestinationPanelProps) {
  const name = (destination ?? "").trim();

  const [data, setData] = useState<PanelData>({ destination: null, weather: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A once-per-mount/update clock read so local time is computed on the client
  // only (avoids an SSR/client hydration mismatch).
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    // No destination selected yet → Empty_State; clear any prior reading.
    if (!name) {
      setData({ destination: null, weather: null });
      setError(null);
      setLoading(false);
      setNow(null);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNow(new Date());

    const q = `?destination=${encodeURIComponent(name)}`;
    Promise.all([
      getJson<LiveResult<DestinationInfo>>(`/api/destination${q}`, controller.signal),
      getJson<LiveResult<WeatherInfo>>(`/api/weather${q}`, controller.signal),
    ])
      .then(([dest, weather]) => {
        if (cancelled) return;
        setData({ destination: dest, weather });
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled || (err instanceof DOMException && err.name === "AbortError")) return;
        // Error_State: show a message but PRESERVE any data already shown
        // (Req 10.3) — we deliberately do NOT clear `data` here.
        setError("We couldn't load live destination details right now.");
        setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [name]);

  const localTime = useMemo(() => {
    if (!name || !now) return null;
    // Prefer the adapter-returned name (more canonical) when available.
    const resolvedName = data.destination?.data.name || name;
    return formatLocalTime(resolvedName, now);
  }, [name, now, data.destination]);

  // ---- Empty_State (Req 10.2): nothing chosen yet. ------------------------
  if (!name) {
    return (
      <div className="card results__empty" aria-live="polite">
        <p className="eyebrow">Discover a destination</p>
        <p>Pick a destination above to see details, attractions, weather, and local time.</p>
      </div>
    );
  }

  const dest = data.destination;
  const weather = data.weather;
  const places = dest?.data.places ?? [];
  const hasAnyData = dest !== null || weather !== null;

  return (
    <div className="card" aria-busy={loading} aria-live="polite">
      <header className="section-head">
        <div>
          <p className="eyebrow">Destination details</p>
          <h3 className="section-title">{dest?.data.name || name}</h3>
          {dest ? (
            <FreshnessIndicator mode={dest.mode} provider={dest.provider} />
          ) : null}
        </div>
      </header>

      {/* Loading_State (Req 10.1) — existing-class in-progress line. */}
      {loading && !hasAnyData ? (
        <p className="results__partial">Loading destination details…</p>
      ) : null}

      {/* Error_State (Req 10.3) — preserves any data already shown below. */}
      {error ? (
        <div className="results__error" role="alert">
          <p>{error}</p>
        </div>
      ) : null}

      {/* Destination summary (Req 5.1). */}
      {dest ? <p className="lead">{dest.data.summary}</p> : null}

      {/* Attractions / places (Req 5.1, 7.3). */}
      {dest ? (
        places.length > 0 ? (
          <div>
            <p className="eyebrow">Attractions &amp; places</p>
            <ul>
              {places.map((place) => (
                <li key={place}>{place}</li>
              ))}
            </ul>
          </div>
        ) : (
          // Empty_State for the places sub-section specifically (Req 10.2).
          <p className="section-sub">No notable places are available for this destination yet.</p>
        )
      ) : null}

      {/* Weather (Req 5.2) with its own freshness label. */}
      {weather ? (
        <div>
          <p className="eyebrow">Weather</p>
          <p className="section-sub">
            {weather.mode === "fallback" || Number.isNaN(weather.data.tempC)
              ? weather.data.summary
              : `${weather.data.summary} · ${weather.data.tempC}°C`}
          </p>
          <FreshnessIndicator mode={weather.mode} provider={weather.provider} />
        </div>
      ) : null}

      {/* Local time (Req 5.4) — rendered only where a timezone resolves. */}
      <div>
        <p className="eyebrow">Local time</p>
        {localTime ? (
          <p className="section-sub">{localTime}</p>
        ) : (
          <p className="section-sub">Local time unavailable for this destination.</p>
        )}
      </div>

      {/* Travel tips (Req 7.3) — short, clearly-generic guidance. */}
      <div>
        <p className="eyebrow">Travel tips (general guidance)</p>
        <ul>
          {GENERIC_TRAVEL_TIPS.map((tip) => (
            <li key={tip}>{tip}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
