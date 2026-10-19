/**
 * Live Data Adapters (read-only) - design section 12.
 * Destination/places, weather, currency from configured public sources;
 * labelled fallback on failure/timeout; only read operations.
 * Requirements: 10.1-10.5.
 */

export type LiveMode = "live" | "cached" | "fallback";

export interface LiveResult<T> {
  data: T;
  mode: LiveMode;
  provider: string;
}

export type LiveKind = "destination" | "weather" | "currency";

/**
 * A read-only fetcher. It must never mutate state; the adapter only issues
 * GET requests through it and is modelled as a pure read.
 */
export type ReadFetcher<T> = () => Promise<T>;

/** The HMTP method an adapter is allowed to use (Req 10.5 makes this always GET). */
export const ADAPTER_METHOD = "GET" as const;

/**
 * Resolve a live read. On any failure or timeout the result is a labelled
 * fallback (mode = "fallback") with the supplied default data (Req 10.4).
 */
export async function resolveLive<T>(
  provider: string,
  fetcher: ReadFetcher<T>,
  fallbackData: T,
): Promise<LiveResult<T>> {
  try {
    const data = await fetcher();
    if (data === undefined || data === null) throw new Error("empty");
    return { data, mode: "live", provider };
  } catch {
    return { data: fallbackData, mode: "fallback", provider };
  }
}

export interface DestinationInfo { name: string; summary: string; places: string[] }
export interface WeatherInfo { destination: string; tempC: number; summary: string }
export interface CurrencyInfo { from: string; to: string; rate: number }

export function destinationFallback(dest: string): DestinationInfo {
  return { name: dest, summary: `Details for ${dest} are temporarily unavailable.`, places: [] };
}
export function weatherFallback(dest: string): WeatherInfo {
  return { destination: dest, tempC: NaN, summary: "Weather unavailable" };
}
export function currencyFallback(from: string, to: string): CurrencyInfo {
  return { from, to, rate: 1 };
}

/**
 * Configured public sources (design section 12). These are the only endpoints
 * the adapters read from; a contracted replacement can be swapped behind the
 * same adapter contract with no caller change.
 */
export const LIVE_SOURCES = {
  destination: "Wikipedia",
  weather: "MET Norway",
  currency: "Frankfurter / ECB",
} as const;

/** Minimal shape of the DOM fetch; injectable so adapters stay testable as pure reads. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const DEFAULT_TIMEOUT_MS = 5000;
const USER_AGENT = "TripGenie/1.0 (travel-planning-concierge)";

/**
 * Issue a single read-only (GET) request with a hard timeout. Any non-OK
 * response, network error, or timeout throws so the caller's {@link resolveLive}
 * wrapper produces a labelled fallback (Req 10.4). Only GET is ever used so the
 * adapter performs read operations exclusively (Req 10.5).
 */
async function readJson(
  url: string,
  fetchImpl: FetchLike,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: ADAPTER_METHOD,
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`source returned ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve the global fetch, erroring clearly when none is available. */
function defaultFetch(): FetchLike {
  const f = (globalThis as { fetch?: unknown }).fetch;
  if (typeof f !== "function") throw new Error("no fetch available");
  return f as FetchLike;
}

/**
 * Destination + prominent places from the configured public source (Wikipedia).
 * Returns a labelled fallback on failure/timeout (Req 10.1, 10.4).
 */
export async function fetchDestination(
  dest: string,
  fetchImpl: FetchLike = defaultFetch(),
): Promise<LiveResult<DestinationInfo>> {
  const city = dest.trim();
  return resolveLive<DestinationInfo>(
    LIVE_SOURCES.destination,
    async () => {
      const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(city)}`;
      const data = (await readJson(summaryUrl, fetchImpl)) as {
        title?: string;
        extract?: string;
      };

      const placesUrl = new URL("https://en.wikipedia.org/w/api.php");
      placesUrl.search = new URLSearchParams({
        action: "query",
        generator: "search",
        gsrsearch: `${city} landmarks attractions tourism`,
        gsrlimit: "6",
        prop: "info",
        format: "json",
        origin: "*",
      }).toString();
      let places: string[] = [];
      try {
        const placesData = (await readJson(placesUrl.toString(), fetchImpl)) as {
          query?: { pages?: Record<string, { title?: string }> };
        };
        places = Object.values(placesData.query?.pages ?? {})
          .map((p) => (p.title ?? "").trim())
          .filter((t) => t.length > 0)
          .slice(0, 6);
      } catch {
        // Places are best-effort; the destination summary still counts as a live read.
        places = [];
      }

      return {
        name: data.title?.trim() || city,
        summary: data.extract?.slice(0, 360) || `Explore ${city}.`,
        places,
      };
    },
    destinationFallback(city),
  );
}

/**
 * Current weather for a destination from the configured public source
 * (MET Norway), geocoded via the public coordinates source. Returns a labelled
 * fallback on failure/timeout (Req 10.2, 10.4).
 */
export async function fetchWeather(
  dest: string,
  fetchImpl: FetchLike = defaultFetch(),
): Promise<LiveResult<WeatherInfo>> {
  const city = dest.trim();
  return resolveLive<WeatherInfo>(
    LIVE_SOURCES.weather,
    async () => {
      const geoUrl = `https://en.wikipedia.org/w/api.php?action=query&prop=coordinates&titles=${encodeURIComponent(city)}&format=json&origin=*`;
      const geoData = (await readJson(geoUrl, fetchImpl)) as {
        query?: { pages?: Record<string, { coordinates?: Array<{ lat: number; lon: number }> }> };
      };
      const point = Object.values(geoData.query?.pages ?? {})[0]?.coordinates?.[0];
      if (!point) throw new Error("coordinates unavailable");

      const wxUrl = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${point.lat}&lon=${point.lon}`;
      const wx = (await readJson(wxUrl, fetchImpl)) as {
        properties?: {
          timeseries?: Array<{ data?: { instant?: { details?: { air_temperature?: number } } } }>;
        };
      };
      const temp = wx.properties?.timeseries?.[0]?.data?.instant?.details?.air_temperature;
      if (typeof temp !== "number") throw new Error("weather unavailable");

      return {
        destination: city,
        tempC: Math.round(temp),
        summary: "Current destination conditions",
      };
    },
    weatherFallback(city),
  );
}

/**
 * Currency conversion rate from the configured public source (Frankfurter/ECB).
 * Returns a labelled fallback (rate = 1) on failure/timeout (Req 10.3, 10.4).
 */
export async function fetchCurrency(
  from: string,
  to: string,
  fetchImpl: FetchLike = defaultFetch(),
): Promise<LiveResult<CurrencyInfo>> {
  const base = from.trim().toUpperCase();
  const quote = to.trim().toUpperCase();
  return resolveLive<CurrencyInfo>(
    LIVE_SOURCES.currency,
    async () => {
      const url = `https://api.frankfurter.dev/v2/rate/${encodeURIComponent(base)}/${encodeURIComponent(quote)}`;
      const data = (await readJson(url, fetchImpl, 4000)) as { rate?: number };
      const rate = Number(data.rate);
      if (!Number.isFinite(rate) || rate <= 0) throw new Error("fx unavailable");
      return { from: base, to: quote, rate };
    },
    currencyFallback(base, quote),
  );
}
