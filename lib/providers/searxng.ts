/**
 * SearXNG client (server-only, pure adapter): one GET per grounding query
 * against a self-hosted SearXNG instance. Never throws, never logs, and never
 * reads error objects (an undici error message can contain the request URL).
 *
 * Requirements: 2.1-2.14, 11.6, 11.10, 11.11, 11.12.
 */

import { safeHttpsUrl, type AdapterOptions } from "@/lib/providers/serpapi-core";

export const QUERY_TIMEOUT_MS = 2500;
export const MAX_RESULTS_PER_QUERY = 10;

const MAX_TITLE = 200;
const MAX_CONTENT = 500;
const MAX_ENGINE = 50;
const USER_AGENT = "TripGenieGrounding/1.0";

/** Widened fetch type so `redirect: "manual"` can be passed (FetchLike has no such option). */
export type SearxngFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    redirect?: "manual" | "follow" | "error";
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface SearxngClientConfig {
  /** Already validated https base URL (see `searxngBaseUrl()`). */
  baseUrl: string;
  secretHeader: { name: string; value: string } | null;
}

export interface SearxngResult {
  title: string;
  content: string;
  url: string;
  engine: string;
}

export type SearxngOutcome =
  | { kind: "ok"; results: SearxngResult[] }
  | { kind: "failed" }
  | { kind: "redirect" };

export interface SearxngSearchOptions extends Omit<AdapterOptions, "fetchImpl"> {
  fetchImpl?: SearxngFetch;
  /** Lets the service cancel at the overall budget. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

function truncate(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join("");
}

function isHttpsBase(baseUrl: unknown): baseUrl is string {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return false;
  try {
    return new URL(baseUrl).protocol === "https:";
  } catch {
    return false;
  }
}

/** Pure: `{base}/search?q=...&format=json&language=en&safesearch=1&categories=general&pageno=1`. */
export function buildSearchUrl(baseUrl: string, query: string): string {
  const u = new URL(baseUrl);
  const path = u.pathname.replace(/\/+$/, "");
  const out = new URL(`${u.origin}${path}/search`);
  out.searchParams.set("q", query);
  out.searchParams.set("format", "json");
  out.searchParams.set("language", "en");
  out.searchParams.set("safesearch", "1");
  out.searchParams.set("categories", "general");
  out.searchParams.set("pageno", "1");
  return out.toString();
}

/** Pure: reads only title, content, url, engine. Returns null for an unusable result. */
export function mapSearxngResult(raw: unknown): SearxngResult | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === "string" ? r.title.trim() : "";
  if (!title) return null;
  const url = safeHttpsUrl(r.url);
  if (!url) return null;
  const content = typeof r.content === "string" ? r.content.trim() : "";
  const engine = typeof r.engine === "string" ? r.engine.trim() : "";
  return {
    title: truncate(title, MAX_TITLE),
    content: truncate(content, MAX_CONTENT),
    url,
    engine: truncate(engine, MAX_ENGINE),
  };
}

/** Pure: first 10 valid results in response order; null when there is no `results` array. */
export function parseSearxngResponse(body: unknown): SearxngResult[] | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const results = (body as Record<string, unknown>).results;
  if (!Array.isArray(results)) return null;
  const out: SearxngResult[] = [];
  for (const item of results) {
    const mapped = mapSearxngResult(item);
    if (mapped) {
      out.push(mapped);
      if (out.length >= MAX_RESULTS_PER_QUERY) break;
    }
  }
  return out;
}

/** Never throws. */
export async function searxngSearch(
  query: string,
  config: SearxngClientConfig,
  options: SearxngSearchOptions = {},
): Promise<SearxngOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onExternalAbort: (() => void) | undefined;
  try {
    if (!config || !isHttpsBase(config.baseUrl)) return { kind: "failed" };
    const fetchImpl: SearxngFetch =
      options.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit) as ReturnType<SearxngFetch>);
    const timeoutMs = options.timeoutMs ?? QUERY_TIMEOUT_MS;
    const url = buildSearchUrl(config.baseUrl, query);

    const controller = new AbortController();
    const external = options.signal;
    if (external) {
      if (external.aborted) return { kind: "failed" };
      onExternalAbort = () => controller.abort();
      external.addEventListener("abort", onExternalAbort, { once: true });
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    };
    if (config.secretHeader) headers[config.secretHeader.name] = config.secretHeader.value;

    // Race against the timer too, so a fetch that ignores the abort signal still ends.
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, timeoutMs);
    });

    const work = (async (): Promise<SearxngOutcome> => {
      const res = await fetchImpl(url, {
        method: "GET",
        headers,
        signal: controller.signal,
        redirect: "manual",
      });
      if (res.status >= 300 && res.status < 400) return { kind: "redirect" };
      if (!res.ok || res.status < 200 || res.status >= 300) return { kind: "failed" };
      const results = parseSearxngResponse(await res.json());
      return results ? { kind: "ok", results } : { kind: "failed" };
    })();
    // Avoid an unhandled rejection if the timer wins the race.
    work.catch(() => undefined);

    const winner = await Promise.race([work, timedOut]);
    return winner === "timeout" ? { kind: "failed" } : winner;
  } catch {
    return { kind: "failed" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onExternalAbort && options.signal) options.signal.removeEventListener("abort", onExternalAbort);
  }
}
