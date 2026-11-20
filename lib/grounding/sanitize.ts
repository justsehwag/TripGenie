import type { GroundingSnippet } from "@/lib/grounding/types";

/** Delimiters wrapping quoted web data in the grounding block. */
export const GROUNDING_OPEN = "<untrusted_web_data>";
export const GROUNDING_CLOSE = "</untrusted_web_data>";

const MIN_CONTENT_CHARS = 20;

/** Structural shape of a SearXNG result (see lib/providers/searxng.ts). */
export interface RawSearchResult {
  title: string;
  content: string;
  url: string;
  engine?: string;
}

/**
 * Replace every "<" and ">" with a space, so no delimiter can survive or be
 * re-created by splicing. Whitespace is collapsed afterwards.
 */
export function removeDelimiters(s: string): string {
  return String(s ?? "")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip control chars, HTML tags and delimiters; collapse whitespace. */
export function sanitizeText(s: string): string {
  const noControl = String(s ?? "").replace(/\p{Cc}/gu, " ");
  const noTags = noControl.replace(/<[^>]*>/g, " ");
  return removeDelimiters(noTags);
}

const PHRASES = [
  "ignore previous instructions",
  "ignore the above",
  "system prompt",
  "you are now",
  "disregard",
  "system:",
  "assistant:",
  "user:",
  "human:",
  "javascript:",
  "vbscript:",
  "data:",
  "<script",
  "</script",
];

function fold(s: string): string {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .toLowerCase();
}

/** True when the raw text looks like prompt injection or unsafe link text. */
export function isInjectionText(s: string): boolean {
  const f = fold(s);
  for (const p of PHRASES) if (f.includes(p)) return true;
  // Any scheme:// other than https://
  const re = /([a-z][a-z0-9+.-]*):\/\//g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(f)) !== null) {
    if (m[1] !== "https") return true;
  }
  return false;
}

/**
 * Drop hostile or too-short snippets; clean the rest. Never throws and never
 * mutates its input.
 */
export function sanitizeSnippets(
  raw: readonly RawSearchResult[],
): { kept: GroundingSnippet[]; droppedCount: number } {
  const kept: GroundingSnippet[] = [];
  let droppedCount = 0;
  try {
    for (const r of Array.isArray(raw) ? raw : []) {
      try {
        const rawTitle = String(r?.title ?? "");
        const rawContent = String(r?.content ?? "");
        if (isInjectionText(rawTitle) || isInjectionText(rawContent)) {
          droppedCount++;
          continue;
        }
        const title = sanitizeText(rawTitle);
        const snippet = sanitizeText(rawContent);
        let host = "";
        try {
          host = new URL(String(r?.url ?? "")).hostname;
        } catch {
          host = "";
        }
        if (snippet.length < MIN_CONTENT_CHARS || !title || !host) {
          droppedCount++;
          continue;
        }
        kept.push({ title, snippet, url: String(r.url), host });
      } catch {
        droppedCount++;
      }
    }
  } catch {
    // never throw
  }
  return { kept, droppedCount };
}
