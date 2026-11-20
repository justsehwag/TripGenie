import { sanitizeText } from "@/lib/grounding/sanitize";
import type { GroundingSnippet } from "@/lib/grounding/types";

export const MAX_TITLE = 120;
export const MAX_SNIPPET = 240;
export const MAX_PER_HOST = 3;
export const MAX_SNIPPETS = 12;

/** Truncate by code points so no lone surrogate is produced. */
function truncate(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join("").trim();
}

/**
 * Normalise a URL for comparison: lower-case host, no scheme, no leading
 * "www.", no fragment, no trailing slash, no utm_*, fbclid or gclid params.
 */
export function normalizeUrlForCompare(url: string): string {
  const raw = String(url ?? "").trim();
  try {
    const u = new URL(raw);
    const host = u.host.toLowerCase().replace(/^www\./, "");
    let path = u.pathname;
    if (path.endsWith("/")) path = path.slice(0, -1);
    const kept: string[] = [];
    for (const [k, v] of u.searchParams) {
      const lk = k.toLowerCase();
      if (lk.startsWith("utm_") || lk === "fbclid" || lk === "gclid") continue;
      kept.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
    return host + path + (kept.length ? `?${kept.join("&")}` : "");
  } catch {
    return raw.toLowerCase();
  }
}

/** Lower-case, collapse whitespace, trim. */
export function normalizeTitle(t: string): string {
  return String(t ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Sanitize and trim, then de-duplicate by URL and title, cap per host and
 * overall. Pure, idempotent, never mutates input, never throws.
 */
export function dedupeAndTrim(snippets: readonly GroundingSnippet[]): GroundingSnippet[] {
  const out: GroundingSnippet[] = [];
  try {
    const seenUrls = new Set<string>();
    const seenTitles = new Set<string>();
    const perHost = new Map<string, number>();
    for (const s of Array.isArray(snippets) ? snippets : []) {
      if (out.length >= MAX_SNIPPETS) break;
      try {
        const title = truncate(sanitizeText(String(s?.title ?? "")), MAX_TITLE);
        const snippet = truncate(sanitizeText(String(s?.snippet ?? "")), MAX_SNIPPET);
        const url = String(s?.url ?? "").trim();
        if (!title || !snippet) continue;
        let host: string;
        try {
          host = new URL(url).hostname;
        } catch {
          continue;
        }
        const urlKey = normalizeUrlForCompare(url);
        const titleKey = normalizeTitle(title);
        if (seenUrls.has(urlKey) || seenTitles.has(titleKey)) continue;
        const hostKey = host.toLowerCase();
        const count = perHost.get(hostKey) ?? 0;
        if (count >= MAX_PER_HOST) continue;
        seenUrls.add(urlKey);
        seenTitles.add(titleKey);
        perHost.set(hostKey, count + 1);
        out.push({ title, snippet, url, host });
      } catch {
        // skip bad entry
      }
    }
  } catch {
    // never throw
  }
  return out;
}
