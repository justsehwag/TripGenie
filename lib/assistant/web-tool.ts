/**
 * Trip Assistant web_search tool (server-only). Wraps the SearXNG client,
 * drops hostile snippets, sanitises the rest and wraps them as untrusted data.
 * Never throws. Never logs. The secret header is read only to be passed to the
 * client and is never returned.
 *
 * Requirements: 6.2, 6.3, 6.8, 13.2, 4.9.
 */
import { searxngBaseUrl, searxngEnabled, searxngSecretHeader, webPricingEnabled } from "@/lib/config";
import {
  GROUNDING_CLOSE,
  GROUNDING_OPEN,
  removeDelimiters,
  sanitizeSnippets,
  sanitizeText,
} from "@/lib/grounding/sanitize";
import { QUERY_TIMEOUT_MS, searxngSearch, type SearxngOutcome } from "@/lib/providers/searxng";

export const MAX_WEB_RESULTS = 10;
export const MAX_QUERY_CHARS = 120;
const MAX_TEXT_CHARS = 300;

export interface WebSnippet {
  /** "S1", "S2", ... The only way the model can cite a source. */
  ref: string;
  title: string;
  url: string;
  host: string;
  text: string;
}

export type WebSearchResult =
  | { status: "unavailable" }
  | {
      status: "ok";
      snippets: WebSnippet[];
      /** Snippets as lines inside GROUNDING_OPEN / GROUNDING_CLOSE; this is what the model sees. */
      wrapped: string;
    };

export interface WebSearchDeps {
  search?: (
    query: string,
    config: { baseUrl: string; secretHeader: { name: string; value: string } | null },
    options: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<SearxngOutcome>;
  searxngEnabled?: () => boolean;
  webPricingEnabled?: () => boolean;
  baseUrl?: () => string;
  secretHeader?: () => { name: string; value: string } | null;
}

export interface WebSearchOptions {
  /** Remaining overall budget in ms; the call uses the smaller of this and QUERY_TIMEOUT_MS. */
  remainingMs?: number;
  signal?: AbortSignal;
}

const UNAVAILABLE: WebSearchResult = { status: "unavailable" };

/** Never throws. */
export async function webSearchForAssistant(
  query: string,
  deps: WebSearchDeps = {},
  options: WebSearchOptions = {},
): Promise<WebSearchResult> {
  try {
    const enabled = (deps.searxngEnabled ?? searxngEnabled)();
    const pricing = (deps.webPricingEnabled ?? webPricingEnabled)();
    const baseUrl = (deps.baseUrl ?? searxngBaseUrl)();
    if (!enabled || !pricing || !baseUrl) return UNAVAILABLE;

    const q = removeDelimiters(String(query ?? "")).slice(0, MAX_QUERY_CHARS).trim();
    if (!q) return UNAVAILABLE;

    let timeoutMs = QUERY_TIMEOUT_MS;
    if (typeof options.remainingMs === "number" && Number.isFinite(options.remainingMs)) {
      timeoutMs = Math.min(QUERY_TIMEOUT_MS, Math.floor(options.remainingMs));
      if (timeoutMs <= 0) return UNAVAILABLE;
    }

    const secretHeader = (deps.secretHeader ?? searxngSecretHeader)();
    const search = deps.search ?? searxngSearch;
    const outcome = await search(q, { baseUrl, secretHeader }, { timeoutMs, signal: options.signal });
    if (!outcome || outcome.kind !== "ok") return UNAVAILABLE;

    const { kept } = sanitizeSnippets(outcome.results);
    const snippets: WebSnippet[] = [];
    for (const s of kept) {
      if (snippets.length >= MAX_WEB_RESULTS) break;
      let url: URL;
      try {
        url = new URL(s.url);
      } catch {
        continue;
      }
      if (url.protocol !== "https:") continue;
      const title = removeDelimiters(sanitizeText(s.title));
      const text = removeDelimiters(sanitizeText(s.snippet)).slice(0, MAX_TEXT_CHARS).trim();
      if (!title || !text) continue;
      snippets.push({
        ref: `S${snippets.length + 1}`,
        title,
        url: url.toString(),
        host: url.hostname,
        text,
      });
    }

    const lines = snippets.map((s) => `[${s.ref}] ${s.title} (${s.host}): ${s.text}`);
    const wrapped = [GROUNDING_OPEN, ...lines, GROUNDING_CLOSE].join("\n");
    return { status: "ok", snippets, wrapped };
  } catch {
    return UNAVAILABLE;
  }
}
