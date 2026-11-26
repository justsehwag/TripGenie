/**
 * Typo-tolerant place matching. Pure, no I/O.
 *
 * Distance is Damerau-Levenshtein in its optimal string alignment form:
 * insertion, deletion, substitution and adjacent transposition each cost 1.
 */

/** Lowercase, strip diacritics, turn punctuation into spaces, collapse spaces. */
export function normalizePlace(s: string): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Optimal string alignment distance between a and b, compared as given. */
function osa(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  const d: number[][] = [];
  for (let i = 0; i <= n; i++) {
    d.push(new Array<number>(m + 1).fill(0));
    d[i][0] = i;
  }
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, d[i - 2][j - 2] + 1);
      }
      d[i][j] = v;
    }
  }
  return d[n][m];
}

/** Distance between two place strings after normalization. 0 means equal. */
export function damerauLevenshtein(a: string, b: string): number {
  return osa(normalizePlace(a), normalizePlace(b));
}

/** Largest allowed distance for a normalized query length. */
export function maxDistanceFor(normalizedLength: number): number {
  if (normalizedLength < 4) return 0;
  if (normalizedLength <= 5) return 1;
  return 2;
}

export interface FuzzyCandidate {
  id: string;
  label: string;
  aliases?: string[];
}

export interface FuzzyHit {
  id: string;
  label: string;
  distance: number;
  /** The label or alias that produced the best match. */
  viaAlias: string;
  prefix: boolean;
}

function bestForCandidate(nq: string, c: FuzzyCandidate): FuzzyHit | null {
  const limit = maxDistanceFor(nq.length);
  let best: FuzzyHit | null = null;
  for (const form of [c.label, ...(c.aliases ?? [])]) {
    const nf = normalizePlace(form);
    if (!nf) continue;
    let distance: number;
    let prefix = false;
    if (nf === nq) {
      distance = 0;
      prefix = true;
    } else if (nf.startsWith(nq)) {
      distance = 0;
      prefix = true;
    } else {
      if (limit === 0) continue;
      distance = osa(nq, nf);
      if (distance > limit) continue;
    }
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance && prefix && !best.prefix)
    ) {
      best = { id: c.id, label: c.label, distance, viaAlias: form, prefix };
    }
  }
  return best;
}

/**
 * Candidates close to the query, best first: distance ascending, prefix
 * matches first at equal distance, then label. Queries under 4 characters
 * match exactly or by prefix only.
 */
export function fuzzyMatch(
  query: string,
  candidates: readonly FuzzyCandidate[],
  limit = 5,
): FuzzyHit[] {
  const nq = normalizePlace(query);
  if (!nq) return [];
  const hits: FuzzyHit[] = [];
  for (const c of candidates) {
    const h = bestForCandidate(nq, c);
    if (h) hits.push(h);
  }
  hits.sort(
    (x, y) =>
      x.distance - y.distance ||
      Number(y.prefix) - Number(x.prefix) ||
      x.label.localeCompare(y.label),
  );
  return hits.slice(0, Math.max(0, limit));
}

/**
 * The closest correction for a misspelled query, or null when the query
 * already equals a candidate, is only a prefix of one, or nothing is close.
 */
export function didYouMean(
  query: string,
  candidates: readonly FuzzyCandidate[],
): FuzzyHit | null {
  const nq = normalizePlace(query);
  if (!nq) return null;
  for (const c of candidates) {
    for (const form of [c.label, ...(c.aliases ?? [])]) {
      if (normalizePlace(form) === nq) return null;
    }
  }
  const hits = fuzzyMatch(query, candidates, candidates.length);
  return hits.find((h) => h.distance > 0) ?? null;
}
