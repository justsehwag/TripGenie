/**
 * CSRF origin check for state-changing requests. Pure, never throws.
 * The Host header is never used (the app sits behind CloudFront).
 */

export type HeadersLike =
  | { get(name: string): string | null | undefined }
  | Record<string, string | string[] | undefined | null>;

const SAFE_METHODS = new Set(["GET", "HEAD"]);
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Normalise an origin string to `scheme://host[:port]`, or null when invalid. */
export function normalizeOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function readHeader(headers: HeadersLike | null | undefined, name: string): string | null {
  if (!headers) return null;
  try {
    if (typeof (headers as { get?: unknown }).get === "function") {
      const v = (headers as { get(n: string): string | null | undefined }).get(name);
      return typeof v === "string" ? v : null;
    }
    const record = headers as Record<string, string | string[] | undefined | null>;
    const lower = name.toLowerCase();
    for (const key of Object.keys(record)) {
      if (key.toLowerCase() !== lower) continue;
      const v = record[key];
      if (typeof v === "string") return v;
      if (Array.isArray(v) && v.length === 1 && typeof v[0] === "string") return v[0];
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

export function isAllowedOrigin(
  method: string,
  headers: HeadersLike | null | undefined,
  allowedOrigins: readonly string[] | null | undefined,
): boolean {
  try {
    const m = String(method ?? "").toUpperCase();
    if (SAFE_METHODS.has(m)) return true;
    if (!MUTATING_METHODS.has(m)) return false;

    const origin = readHeader(headers, "origin");
    if (origin === null) {
      const site = readHeader(headers, "sec-fetch-site");
      return site !== null && site.trim().toLowerCase() === "same-origin";
    }

    const normalized = normalizeOrigin(origin);
    if (!normalized || !Array.isArray(allowedOrigins)) return false;
    for (const allowed of allowedOrigins) {
      if (normalizeOrigin(allowed) === normalized) return true;
    }
    return false;
  } catch {
    return false;
  }
}
