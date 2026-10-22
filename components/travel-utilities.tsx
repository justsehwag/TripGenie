"use client";

/**
 * Travel_Utilities surface (realtime-ai-integration spec, task 9.3 — design
 * "Live-data surfacing + Freshness_Indicator", Req 5.2/5.3/5.4/5.5/5.6/5.7,
 * 7.9, 10.1–10.4).
 *
 * A compact, read-only utilities panel that surfaces three already-real
 * free-tier live readings — current weather, a currency conversion rate, and
 * local time — on an EXISTING surface. Task 9.3 mounts it on the account /
 * profile surface (`app/account/page.tsx`, below the existing `AuthLanding`),
 * the design's pairing of Travel Utilities with the account/profile area
 * (Req 7.9). Mounting there changes none of that page's existing content: the
 * panel is appended after the existing component.
 *
 * HARD CONSTRAINT compliance: this component introduces NO new token, NO new
 * `:root` var, NO new nav entry, and NO new runtime dependency. Every element
 * renders through EXISTING class names only (`.shell`, `.card`, `.eyebrow`,
 * `.section-title`, `.section-sub`, `.lead`, `.field`, `.cta`, `.notice`,
 * `.results__empty`, `.results__partial`, and the shared provenance classes via
 * `<FreshnessIndicator/>`). Local time uses the browser's own
 * `Intl.DateTimeFormat` — no library, no network call.
 *
 * Honesty (Req 5.6, 10.4): every live reading is rendered with a
 * `<FreshnessIndicator/>` that labels `live | cached | fallback`; a fallback is
 * NEVER dressed up as a live reading. For local time we can only honestly show
 * the viewer's OWN local time (resolved from the browser), because neither the
 * weather nor the currency adapter returns a destination timezone — so the
 * destination's local time is rendered as a clearly-labelled
 * "local time unavailable" state rather than a fabricated clock.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import FreshnessIndicator from "@/components/freshness-indicator";
import { useTripContext } from "@/components/trip-context";
import type {
  CurrencyInfo,
  LiveResult,
  WeatherInfo,
} from "@/lib/live-data";

/** A tiny async lifecycle used by each utility (Loading/Empty/Error states). */
type Phase = "empty" | "loading" | "ready" | "error";

/** Default currency pair — a labelled example, replaced on first lookup. */
const DEFAULT_FROM = "USD";
const DEFAULT_TO = "EUR";

/** Read a JSON `LiveResult<T>` from one of the read-only live routes. */
async function readLive<T>(url: string): Promise<LiveResult<T>> {
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    // A 4xx (e.g. missing params) is a genuine lookup failure for the panel;
    // surface it through the Error_State rather than faking a reading.
    throw new Error(`Lookup failed (${response.status}).`);
  }
  return (await response.json()) as LiveResult<T>;
}

export default function TravelUtilities() {
  const { context } = useTripContext();

  // ── Viewer's local time (browser-resolved; never fabricated) ────────────
  // Resolved only on the client after mount to avoid any hydration mismatch.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const viewerTimeZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch {
      return "";
    }
  }, []);
  const viewerLocalTime = useMemo(() => {
    if (!now) return "";
    try {
      return new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(now);
    } catch {
      return "";
    }
  }, [now]);

  // ── Weather ─────────────────────────────────────────────────────────────
  const [weatherQuery, setWeatherQuery] = useState<string>(
    () => context.destination ?? "",
  );
  // Prefill the destination from the shared context if it arrives after mount,
  // but never clobber something the visitor has typed.
  const [weatherTouched, setWeatherTouched] = useState(false);
  useEffect(() => {
    if (!weatherTouched && context.destination && !weatherQuery) {
      setWeatherQuery(context.destination);
    }
  }, [context.destination, weatherQuery, weatherTouched]);

  const [weatherPhase, setWeatherPhase] = useState<Phase>("empty");
  const [weather, setWeather] = useState<LiveResult<WeatherInfo> | null>(null);
  const [weatherError, setWeatherError] = useState<string>("");

  const lookupWeather = useCallback(async () => {
    const dest = weatherQuery.trim();
    if (!dest) {
      setWeatherPhase("empty");
      return;
    }
    setWeatherPhase("loading");
    setWeatherError("");
    try {
      const result = await readLive<WeatherInfo>(
        `/api/weather?destination=${encodeURIComponent(dest)}`,
      );
      setWeather(result);
      setWeatherPhase("ready");
    } catch (error) {
      // Preserve any previously shown reading; just surface the error.
      setWeatherError(
        error instanceof Error ? error.message : "Could not load weather.",
      );
      setWeatherPhase("error");
    }
  }, [weatherQuery]);

  // ── Currency ──────────────────────────────────────────────────────────────
  const [from, setFrom] = useState<string>(DEFAULT_FROM);
  const [to, setTo] = useState<string>(DEFAULT_TO);
  const [fxPhase, setFxPhase] = useState<Phase>("empty");
  const [fx, setFx] = useState<LiveResult<CurrencyInfo> | null>(null);
  const [fxError, setFxError] = useState<string>("");

  const lookupCurrency = useCallback(async () => {
    const base = from.trim().toUpperCase();
    const quote = to.trim().toUpperCase();
    if (!base || !quote) {
      setFxPhase("empty");
      return;
    }
    setFxPhase("loading");
    setFxError("");
    try {
      const result = await readLive<CurrencyInfo>(
        `/api/currency?from=${encodeURIComponent(base)}&to=${encodeURIComponent(quote)}`,
      );
      setFx(result);
      setFxPhase("ready");
    } catch (error) {
      setFxError(
        error instanceof Error ? error.message : "Could not load the rate.",
      );
      setFxPhase("error");
    }
  }, [from, to]);

  // A finite temperature means we have a real reading; the fallback carries
  // NaN, which the FreshnessIndicator already labels as a fallback.
  const hasTemp =
    weather != null && Number.isFinite(weather.data.tempC);

  return (
    <section className="shell" aria-labelledby="travel-utilities-heading">
      <p className="eyebrow">Travel utilities</p>
      <h2 id="travel-utilities-heading" className="section-title">
        Live travel helpers
      </h2>
      <p className="section-sub">
        Check current conditions, a currency rate, and local time. Each reading
        shows its source and freshness, and falls back honestly when a source is
        unavailable.
      </p>

      {/* ── Weather ─────────────────────────────────────────────────────── */}
      <div className="card" aria-labelledby="tu-weather-heading">
        <p className="eyebrow">Weather</p>
        <h3 id="tu-weather-heading" className="section-title">
          Current conditions
        </h3>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void lookupWeather();
          }}
        >
          <label className="field">
            <span>Destination</span>
            <input
              type="text"
              name="destination"
              value={weatherQuery}
              placeholder="e.g. Lisbon"
              autoComplete="off"
              onChange={(event) => {
                setWeatherTouched(true);
                setWeatherQuery(event.target.value);
              }}
            />
          </label>
          <button
            type="submit"
            className="cta"
            disabled={weatherPhase === "loading" || !weatherQuery.trim()}
          >
            {weatherPhase === "loading" ? "Checking…" : "Check weather"}
          </button>
        </form>

        {weatherPhase === "empty" && (
          <p className="results__empty">
            Enter a destination to see current conditions.
          </p>
        )}
        {weatherPhase === "loading" && (
          <p className="results__partial" aria-live="polite">
            Loading current conditions…
          </p>
        )}
        {weatherPhase === "error" && (
          <p className="notice notice--error" role="alert">
            {weatherError || "Could not load weather."}
            {weather && (
              <>
                {" "}
                Showing the last result below.
              </>
            )}
          </p>
        )}
        {weather && (weatherPhase === "ready" || weatherPhase === "error") && (
          <div aria-live="polite">
            <p className="lead">
              {hasTemp ? (
                <>
                  {weather.data.tempC}°C · {weather.data.summary}
                </>
              ) : (
                <>Weather unavailable for {weather.data.destination}.</>
              )}
            </p>
            <FreshnessIndicator
              mode={weather.mode}
              provider={weather.provider}
            />
          </div>
        )}
      </div>

      {/* ── Currency ────────────────────────────────────────────────────── */}
      <div className="card" aria-labelledby="tu-currency-heading">
        <p className="eyebrow">Currency</p>
        <h3 id="tu-currency-heading" className="section-title">
          Conversion rate
        </h3>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void lookupCurrency();
          }}
        >
          <div className="field-row">
            <label className="field">
              <span>From</span>
              <input
                type="text"
                name="from"
                value={from}
                maxLength={3}
                placeholder="USD"
                autoComplete="off"
                onChange={(event) => setFrom(event.target.value.toUpperCase())}
              />
            </label>
            <label className="field">
              <span>To</span>
              <input
                type="text"
                name="to"
                value={to}
                maxLength={3}
                placeholder="EUR"
                autoComplete="off"
                onChange={(event) => setTo(event.target.value.toUpperCase())}
              />
            </label>
          </div>
          <button
            type="submit"
            className="cta"
            disabled={
              fxPhase === "loading" || !from.trim() || !to.trim()
            }
          >
            {fxPhase === "loading" ? "Checking…" : "Check rate"}
          </button>
        </form>

        {fxPhase === "empty" && (
          <p className="results__empty">
            Enter two currency codes (e.g. {DEFAULT_FROM} → {DEFAULT_TO}) to see
            the rate.
          </p>
        )}
        {fxPhase === "loading" && (
          <p className="results__partial" aria-live="polite">
            Loading the conversion rate…
          </p>
        )}
        {fxPhase === "error" && (
          <p className="notice notice--error" role="alert">
            {fxError || "Could not load the rate."}
            {fx && <> Showing the last result below.</>}
          </p>
        )}
        {fx && (fxPhase === "ready" || fxPhase === "error") && (
          <div aria-live="polite">
            <p className="lead">
              1 {fx.data.from} = {fx.data.rate} {fx.data.to}
            </p>
            <FreshnessIndicator mode={fx.mode} provider={fx.provider} />
          </div>
        )}
      </div>

      {/* ── Local time ──────────────────────────────────────────────────── */}
      <div className="card" aria-labelledby="tu-time-heading">
        <p className="eyebrow">Local time</p>
        <h3 id="tu-time-heading" className="section-title">
          Clocks
        </h3>

        {viewerLocalTime ? (
          <p className="lead" aria-live="polite">
            Your local time: {viewerLocalTime}
            {viewerTimeZone ? ` (${viewerTimeZone})` : ""}
          </p>
        ) : (
          <p className="results__partial">Reading your local time…</p>
        )}

        {/* We cannot resolve the destination's timezone from the weather or
            currency adapters, so we label its local time as unavailable rather
            than fabricating a clock (Req 5.4 honesty). */}
        <p className="section-sub">
          {weatherQuery.trim()
            ? `Destination local time for ${weatherQuery.trim()} is unavailable — we don't have a reliable timezone for it.`
            : "Destination local time is unavailable until a reliable timezone is known."}
        </p>
      </div>
    </section>
  );
}
