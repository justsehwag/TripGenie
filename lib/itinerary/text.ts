/**
 * Display text sanitising (pure, client-safe, total: never throws).
 *
 * Every string from the model or from Google that reaches a response goes
 * through sanitizeDisplayText.
 */

import { MAX_NAME_CHARS } from "./constants";

/** Control characters that act as whitespace become a space. */
const WHITESPACE_CONTROLS = /[\t\n\v\f\r\u0085\u2028\u2029]/g;

/**
 * Removed outright: other C0/C1 controls, DEL, `<`, `>`, and invisible
 * format characters (zero-width, bidi controls, BOM).
 */
const REMOVED =
  /[\u0000-\u001f\u007f-\u009f<>\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** Any run of whitespace (including Unicode spaces). */
const WHITESPACE_RUN = /\s+/g;

/** Drop lone surrogates; keep valid pairs. */
function dropLoneSurrogates(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
      }
    } else if (c < 0xdc00 || c > 0xdfff) {
      out += s[i];
    }
  }
  return out;
}

function normalise(s: string): string {
  return s.replace(WHITESPACE_RUN, " ").trim();
}

/**
 * Returns text with no control character, `<` or `>`, collapsed single-space
 * whitespace, no leading or trailing space, and at most `maxChars` code points.
 * A non-string gives "". Idempotent.
 */
export function sanitizeDisplayText(raw: unknown, maxChars: number): string {
  if (typeof raw !== "string") return "";
  const limit =
    typeof maxChars === "number" && !Number.isNaN(maxChars)
      ? Math.floor(maxChars)
      : 0;
  if (limit <= 0) return "";

  let text = dropLoneSurrogates(raw)
    .replace(WHITESPACE_CONTROLS, " ")
    .replace(REMOVED, "");
  text = normalise(text);

  if (Number.isFinite(limit) && text.length > limit) {
    // Array.from iterates by code point, so a surrogate pair is never split.
    text = Array.from(text).slice(0, limit).join("");
    // The cut can leave a trailing space; trim again to stay idempotent.
    text = normalise(text);
  }
  return text;
}

/** Cleans a place name sent by the client (used-places list). */
export function cleanUsedName(raw: unknown): string {
  return sanitizeDisplayText(raw, MAX_NAME_CHARS);
}
