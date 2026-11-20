/**
 * Pure place-name helpers for Places verification. No React, Next or AWS imports.
 * None of these functions throw.
 */

/** NFD, strip combining marks, lower-case, punctuation/symbols to space, collapse, trim. */
export function normalizePlaceText(s: string): string {
  try {
    return String(s ?? "")
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[\p{P}\p{S}]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

/**
 * True when the normalized place name is a substring of any normalized text.
 * An empty normalized name never matches. Substring (not token) matching is
 * deliberate: it guarantees every verbatim name matches.
 */
export function placeMatches(placeName: string, texts: readonly string[] | string): boolean {
  try {
    const name = normalizePlaceText(placeName);
    if (!name) return false;
    const list = typeof texts === "string" ? [texts] : texts;
    for (const t of list) {
      if (normalizePlaceText(t).includes(name)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

const HONORIFICS = new Set(["shri", "shree", "sri", "sree", "st", "saint"]);
const FILLER = new Set(["the", "of", "de", "do", "da", "and", "at", "in"]);
const GENERIC_WORDS = new Set([
  "fort", "temple", "beach", "church", "museum", "market", "palace", "park", "garden",
  "gardens", "cathedral", "basilica", "chapel", "mosque", "lake", "hill", "point",
  "quarter", "old", "new", "restaurant", "cafe", "bar", "shack", "square", "bridge",
  "monument", "waterfall", "falls", "island", "view", "viewpoint", "sanctuary",
  "latin", "national", "heritage", "town", "city", "road",
]);

function significantTokens(s: string): string[] {
  return normalizePlaceText(s)
    .split(" ")
    .filter((t) => t.length > 0 && !HONORIFICS.has(t) && !FILLER.has(t));
}

/**
 * Order- and honorific-tolerant name match used by the verifier in addition to
 * `placeMatches`. Accepts when the significant token sets are equal in any order,
 * or when the Google name's tokens are a subset of the model's name and include
 * at least one distinctive token (not a generic place word, not a destination word).
 * Never throws.
 */
export function placeMatchesTolerant(
  placeName: string,
  googleName: string,
  destination = "",
): boolean {
  try {
    const model = new Set(significantTokens(placeName));
    const google = new Set(significantTokens(googleName));
    if (model.size === 0 || google.size === 0) return false;
    const dest = new Set(normalizePlaceText(destination).split(" "));
    const subset = [...google].every((t) => model.has(t));
    if (!subset) return false;
    if (google.size === model.size) return true; // equal regardless of order
    return [...google].some((t) => !GENERIC_WORDS.has(t) && !dest.has(t));
  } catch {
    return false;
  }
}

const GENERIC =
  /\b(check[\s-]?in|check[\s-]?out|transfer|airport|departure|arrival|arrive|depart|rest|free time|leisure|downtime|hotel breakfast|breakfast at (the )?hotel|pack|packing|travel to|drive to|commute)\b/i;

const PREFIX =
  /^(?:visit|explore|discover|tour|see|admire|walk (?:through|around|along|in)|stroll (?:through|around|along|in)|sunset at|sunrise at|breakfast at|brunch at|lunch at|dinner at|coffee at|snacks at|drinks at|relax at|photo stop at|day trip to|trip to)\s+(?:the\s+)?/i;

/**
 * Best-effort extraction of a place name from an English activity title.
 * Returns "" when the activity names no place (generic activities).
 */
export function extractPlaceName(activityTitle: string): string {
  try {
    let t = String(activityTitle ?? "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    if (GENERIC.test(t)) return "";

    const stripped = t.replace(PREFIX, "");
    const hadPrefix = stripped !== t;
    t = stripped;

    // Cut at the first separator.
    const cut = t.search(/ - | – | — |,|\(| & |:/);
    if (cut >= 0) t = t.slice(0, cut);
    t = t.trim();
    if (!t) return "";

    const words = t.split(" ");
    const isCap = (w: string) => /^\p{Lu}/u.test(w);
    // Without a verb prefix, require a capitalised word after the first,
    // otherwise the title is generic ("Local street food tour").
    const hasProper = hadPrefix ? words.some(isCap) : words.slice(1).some(isCap);
    if (!hasProper) return "";
    return t;
  } catch {
    return "";
  }
}
