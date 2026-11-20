/**
 * Maps link helpers (pure, client-safe, total: never throw for any input).
 *
 * Builds and validates Google Maps links and Google Place photo references.
 * No imports, so it can be used from "use client" code.
 */

const MAPS_BASE = "https://www.google.com/maps/search/?api=1";

/**
 * Same shape as PHOTO_REF_PATTERN in app/api/place-photo/route.ts, but ids are
 * limited to URL-safe characters so whitespace/control chars never pass.
 */
const PHOTO_REF_PATTERN = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/;

/** Replace lone surrogates so encodeURIComponent cannot throw a URIError. */
function wellFormed(s: unknown): string {
  const str = typeof s === "string" ? s : "";
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += str[i] + str[i + 1];
        i++;
      } else {
        out += "\ufffd";
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out += "\ufffd";
    } else {
      out += str[i];
    }
  }
  return out;
}

function enc(s: unknown): string {
  return encodeURIComponent(wellFormed(s));
}

/**
 * Google Maps search URL for a verified place. Both inputs are percent-encoded,
 * so no `&` or `#` from them can alter the query structure.
 */
export function buildMapsUrl(placeId: string, name: string): string {
  return `${MAPS_BASE}&query=${enc(name)}&query_place_id=${enc(placeId)}`;
}

/** True only for an absolute https URL on www.google.com whose path starts with /maps. */
export function isSafeMapsUrl(url: unknown): url is string {
  if (typeof url !== "string" || !url.startsWith("https://")) return false;
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      u.hostname === "www.google.com" &&
      u.port === "" &&
      u.username === "" &&
      u.password === "" &&
      u.pathname.startsWith("/maps")
    );
  } catch {
    return false;
  }
}

/** True only for a Google photo resource name "places/<id>/photos/<id>". */
export function isValidPhotoRef(ref: unknown): ref is string {
  return typeof ref === "string" && PHOTO_REF_PATTERN.test(ref);
}
