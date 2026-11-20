/**
 * Pure image policy: Wikimedia standard widths, size classes, URL width
 * rewriting, srcset building and the non-representative image classifier.
 * No I/O, no env access, safe on the client.
 */

/** Widths Wikimedia serves as thumbnails. Only widths up to MAX_IMAGE_WIDTH are ever returned. */
export const STANDARD_WIDTHS = [20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920, 3840] as const;
export const MAX_IMAGE_WIDTH = 1920;
export const MIN_USABLE_WIDTH = 330;

export type SizeClass = "thumb" | "card" | "hero" | "cover";
export const SIZE_WIDTHS: Record<SizeClass, { x1: number; x2: number }> = {
  thumb: { x1: 120, x2: 250 },
  card: { x1: 500, x2: 960 },
  hero: { x1: 960, x2: 1280 },
  cover: { x1: 1280, x2: 1920 },
};

/** Unknown or invalid input gives "card". */
export function parseSizeClass(v: unknown): SizeClass {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(SIZE_WIDTHS, v)
    ? (v as SizeClass)
    : "card";
}

/** Smallest standard width >= w, capped at MAX_IMAGE_WIDTH. null above the cap or for a non-finite w. */
export function smallestStandardAtLeast(w: number): number | null {
  if (typeof w !== "number" || !Number.isFinite(w)) return null;
  for (const s of STANDARD_WIDTHS) {
    if (s > MAX_IMAGE_WIDTH) break;
    if (s >= w) return s;
  }
  return null;
}

/** Largest standard width <= w, capped at MAX_IMAGE_WIDTH. null below the smallest standard width. */
export function largestStandardAtMost(w: number): number | null {
  if (typeof w !== "number" || !Number.isFinite(w)) return null;
  let best: number | null = null;
  for (const s of STANDARD_WIDTHS) {
    if (s > MAX_IMAGE_WIDTH) break;
    if (s <= w) best = s;
  }
  return best;
}

function isStandardUsable(w: number): boolean {
  return (
    Number.isFinite(w) &&
    w >= MIN_USABLE_WIDTH &&
    w <= MAX_IMAGE_WIDTH &&
    (STANDARD_WIDTHS as readonly number[]).includes(w)
  );
}

/**
 * Chosen widths for an original of known width. x2 is omitted when the
 * original is too narrow for it. null when the best width is below
 * MIN_USABLE_WIDTH. With an unknown original width only the source's own
 * thumbnail width is kept, and only when it is a usable standard width.
 */
export function chooseWidths(
  size: SizeClass,
  originalWidth: number | undefined,
  thumbWidth: number,
): { x1: number; x2?: number } | null {
  const want = SIZE_WIDTHS[size];
  if (originalWidth === undefined || !Number.isFinite(originalWidth)) {
    return isStandardUsable(thumbWidth) ? { x1: thumbWidth } : null;
  }
  if (originalWidth >= want.x1) {
    return originalWidth >= want.x2 ? { x1: want.x1, x2: want.x2 } : { x1: want.x1 };
  }
  const x1 = largestStandardAtMost(originalWidth);
  if (x1 === null || x1 < MIN_USABLE_WIDTH) return null;
  return { x1 };
}

const WIKIMEDIA_UPLOAD_HOST = "upload.wikimedia.org";

function parseUploadUrl(url: string): URL | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== WIKIMEDIA_UPLOAD_HOST) return null;
  return u;
}

/**
 * Replaces the "<n>px-" segment of a Wikimedia thumbnail URL with the smallest
 * standard width >= width. null when the URL is not an https upload.wikimedia.org
 * thumbnail, has no width segment, or the width is above MAX_IMAGE_WIDTH.
 */
export function rewriteThumbWidth(thumbUrl: string, width: number): string | null {
  const std = smallestStandardAtLeast(width);
  if (std === null) return null;
  const u = parseUploadUrl(thumbUrl);
  if (!u) return null;
  const m = /(\d+)px-([^/]+)$/.exec(u.pathname);
  if (!m) return null;
  u.pathname = `${u.pathname.slice(0, m.index)}${std}px-${m[2]}`;
  return u.toString();
}

/**
 * Builds a thumbnail URL from an original upload.wikimedia.org file URL:
 * /wikipedia/commons/a/ab/File.jpg becomes
 * /wikipedia/commons/thumb/a/ab/File.jpg/<w>px-File.jpg.
 * null for other hosts, existing thumbnails, non-raster files or a width that is not a usable standard width.
 */
export function thumbFromOriginal(originalUrl: string, width: number): string | null {
  const std = smallestStandardAtLeast(width);
  if (std === null || std !== width) return null;
  const u = parseUploadUrl(originalUrl);
  if (!u) return null;
  const m = /^\/wikipedia\/([a-z0-9-]+)\/([0-9a-f])\/([0-9a-f]{2})\/([^/]+)$/i.exec(u.pathname);
  if (!m) return null;
  const file = m[4];
  if (!/\.(jpe?g|png|webp)$/i.test(file)) return null;
  u.pathname = `/wikipedia/${m[1]}/thumb/${m[2]}/${m[3]}/${file}/${std}px-${file}`;
  return u.toString();
}

/** "<1x> 1x, <2x> 2x", or undefined when there is no 2x entry. */
export function buildSrcSet(x1Url: string, x2Url?: string): string | undefined {
  if (!x2Url) return undefined;
  return `${x1Url} 1x, ${x2Url} 2x`;
}

export type ImageVerdict = "accept" | "reject";

const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "webp"]);

/** Whole-word or whole-phrase patterns on normalised text (words separated by single spaces). */
const REJECT_PATTERNS: RegExp[] = [
  /\bflags?\b/,
  /\bcoats? of arms\b/,
  /\bemblems?\b/,
  /\bseals? of\b/,
  /\blogos?\b/,
  /\blocators?\b/,
  /\blocation maps?\b/,
  /\bmaps? of\b/,
  /\bblank maps?\b/,
  /\borthographic\b/,
  /\bglobes?\b/,
  /\bcrests?\b/,
  /\bwordmarks?\b/,
  /\bsymbols?\b/,
  /\bicons?\b/,
  /\bpictograms?\b/,
  /\bbanners?\b/,
  /\bstandards? of\b/,
];

function safeDecode(s: string): string {
  let out = s;
  for (let i = 0; i < 2; i++) {
    try {
      const d = decodeURIComponent(out);
      if (d === out) break;
      out = d;
    } catch {
      break;
    }
  }
  return out;
}

function lastSegment(path: string): string {
  const seg = path.split("/").filter(Boolean).pop() ?? "";
  return seg;
}

function normalise(s: string): string {
  return safeDecode(s)
    .toLowerCase()
    .replace(/^\d+px-/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function pathOfUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split(/[?#]/)[0];
  }
}

/**
 * Rejects flags, emblems, coats of arms, seals, locator maps, logos and SVG
 * rasterisations by file name, page title and URL. Matching is by whole
 * normalised word, so "Flagstaff" is accepted and "Flag_of_India.svg.png" is rejected.
 */
export function classifyImage(i: { fileName?: string; title?: string; url?: string }): ImageVerdict {
  const urlPath = typeof i.url === "string" && i.url !== "" ? safeDecode(pathOfUrl(i.url)).toLowerCase() : "";
  const rawFile =
    typeof i.fileName === "string" && i.fileName !== ""
      ? safeDecode(i.fileName)
      : urlPath
        ? lastSegment(urlPath)
        : "";
  const file = rawFile.toLowerCase();

  if (urlPath.includes(".svg") || file.includes(".svg")) return "reject";

  const ext = /\.([a-z][a-z0-9]{1,4})$/.exec(file);
  if (ext && !ALLOWED_EXT.has(ext[1])) return "reject";

  const texts: string[] = [];
  if (file) texts.push(normalise(file));
  if (typeof i.title === "string" && i.title !== "") texts.push(normalise(i.title));
  for (const t of texts) {
    if (REJECT_PATTERNS.some((re) => re.test(t))) return "reject";
  }
  return "accept";
}
