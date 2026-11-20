import { selectSnippetsForBlock } from "@/lib/grounding/prompt";
import type { GroundingSnippet } from "@/lib/grounding/types";
import type { SourceLink } from "@/lib/types";

export const MAX_SOURCES = 12;
const MAX_SOURCE_TITLE = 200;

/**
 * Local https check (same contract as safeHttpsUrl). serpapi-core imports
 * server config, so it must not be pulled into client code via this module.
 * Returns the parsed URL or null.
 */
function parseHttps(v: unknown): URL | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" || !u.hostname) return null;
    return u;
  } catch {
    return null;
  }
}

function build(title: unknown, url: unknown, host?: unknown): SourceLink | null {
  if (typeof title !== "string") return null;
  const t = title.trim().slice(0, MAX_SOURCE_TITLE);
  if (!t) return null;
  const u = parseHttps(url);
  if (!u) return null;
  if (host !== undefined && host !== u.hostname) return null;
  return { title: t, url: u.href, host: u.hostname };
}

/** Server: links for exactly the snippets that fit in the prompt block. */
export function toSourceLinks(
  input: { snippets?: readonly GroundingSnippet[] } | readonly GroundingSnippet[] | undefined,
): SourceLink[] {
  const out: SourceLink[] = [];
  try {
    const list = Array.isArray(input) ? input : (input as { snippets?: readonly GroundingSnippet[] } | undefined)?.snippets;
    if (!Array.isArray(list)) return out;
    const seen = new Set<string>();
    for (const s of selectSnippetsForBlock(list)) {
      const link = build(s.title, s.url);
      if (!link || seen.has(link.url)) continue;
      seen.add(link.url);
      out.push(link);
      if (out.length >= MAX_SOURCES) break;
    }
  } catch {
    return [];
  }
  return out;
}

/** Client: defensively re-validate a response `sources` field. */
export function parseSourceLinks(raw: unknown): SourceLink[] {
  const out: SourceLink[] = [];
  try {
    if (!Array.isArray(raw)) return out;
    const seen = new Set<string>();
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      if (typeof r.host !== "string") continue;
      const link = build(r.title, r.url, r.host);
      if (!link || seen.has(link.url)) continue;
      seen.add(link.url);
      out.push(link);
      if (out.length >= MAX_SOURCES) break;
    }
  } catch {
    return [];
  }
  return out;
}

/**
 * Re-validates `sources` on an untrusted (rehydrated or stored) itinerary.
 * Valid links are kept; an invalid or empty value removes the field entirely.
 * Returns the same object when there is nothing to change.
 */
export function sanitizeItinerarySources<T extends object>(it: T): T {
  if (!it || typeof it !== "object" || !("sources" in it)) return it;
  const { sources, ...rest } = it as T & { sources?: unknown };
  const links = parseSourceLinks(sources);
  return (links.length > 0 ? { ...rest, sources: links } : rest) as T;
}
