/**
 * Evidence sets for web-grounded pricing: sanitised, bounded, https-only
 * search snippets for one Place_Key. Pure and total.
 */
import { normalizeUrlForCompare } from "@/lib/grounding/bundle";
import { sanitizeSnippets, type RawSearchResult } from "@/lib/grounding/sanitize";
import { extractPrices } from "@/lib/price-extractor";
import type { PlaceKey, ResearchKind } from "@/lib/web-pricing/query-planner";

export interface EvidenceSnippet {
  title: string;
  text: string;
  url: string;
  host: string;
}
export interface EvidenceSet {
  key: PlaceKey;
  kind: ResearchKind;
  snippets: EvidenceSnippet[];
  /** Time of the search; becomes checkedAt of a Web_Price. */
  checkedAtMs: number;
}

export const MAX_SNIPPETS_PER_SET = 4;
export const MAX_PER_HOST = 2;
export const MAX_SNIPPET_CHARS = 240;
export const MAX_TITLE_CHARS = 120;

/** The only text the extractor and the validator read for a snippet. */
export function evidenceText(s: EvidenceSnippet): string {
  return `${s.title} ${s.text}`;
}

/**
 * Cut to at most `max` code points. When the cut falls inside a word, back
 * off to the last whitespace so a number is never split. Returns "" when no
 * whitespace exists to back off to.
 */
export function trimOnWordBoundary(s: string, max: number): string {
  const chars = Array.from(String(s ?? "").trim());
  if (chars.length <= max) return chars.join("");
  const cut = chars.slice(0, max);
  if (/\s/u.test(chars[max])) return cut.join("").trim();
  let i = cut.length - 1;
  while (i >= 0 && !/\s/u.test(cut[i])) i--;
  if (i < 0) return "";
  return cut.slice(0, i).join("").trim();
}

function hasCandidate(s: EvidenceSnippet): boolean {
  try {
    const r = extractPrices(evidenceText(s));
    return r.candidates.length > 0 || r.freeEntry;
  } catch {
    return false;
  }
}

export function buildEvidenceSet(
  key: PlaceKey,
  kind: ResearchKind,
  results: readonly RawSearchResult[],
  nowMs: number,
): EvidenceSet {
  const set: EvidenceSet = { key, kind, snippets: [], checkedAtMs: nowMs };
  try {
    const { kept } = sanitizeSnippets(results);
    const seen = new Set<string>();
    const cleaned: EvidenceSnippet[] = [];
    for (const k of kept) {
      let u: URL;
      try {
        u = new URL(k.url);
      } catch {
        continue;
      }
      if (u.protocol !== "https:") continue;
      const norm = normalizeUrlForCompare(u.href);
      if (seen.has(norm)) continue;
      const title = trimOnWordBoundary(k.title, MAX_TITLE_CHARS);
      const text = trimOnWordBoundary(k.snippet, MAX_SNIPPET_CHARS);
      if (!title || !text) continue;
      seen.add(norm);
      cleaned.push({ title, text, url: u.href, host: u.hostname });
    }
    const withPrice = cleaned.filter(hasCandidate);
    const without = cleaned.filter((s) => !withPrice.includes(s));
    const perHost = new Map<string, number>();
    for (const s of [...withPrice, ...without]) {
      if (set.snippets.length >= MAX_SNIPPETS_PER_SET) break;
      const n = perHost.get(s.host) ?? 0;
      if (n >= MAX_PER_HOST) continue;
      perHost.set(s.host, n + 1);
      set.snippets.push(s);
    }
  } catch {
    // total: return what we have
  }
  return set;
}
