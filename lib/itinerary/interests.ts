// Pure interest planning: trip interests to a bounded Text and Nearby query plan.
import { DEFAULT_ROW, interestRow } from "./place-categories";

// Local copies of the planned constants (design: TEXT_QUERIES_PER_BATCH, NEARBY_*).
const TEXT_QUERIES_PER_BATCH = 4;
const NEARBY_BASE_RADIUS_M = 6_000;
const NEARBY_MAX_RADIUS_M = 50_000;
const MAX_INTERESTS = 4;
const MAX_NEARBY_TYPES = 8;

export interface CandidatePlan {
  textQueries: string[];
  nearbyTypes: string[];
  nearbyRadiusM: number;
}

interface Selected {
  phrases: readonly string[];
  types: readonly string[];
}

function cleanInterests(interests: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(interests)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of interests) {
    if (typeof raw !== "string") continue;
    const t = raw.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length === MAX_INTERESTS) break;
  }
  return out;
}

function select(interests: readonly unknown[] | undefined): Selected[] {
  const cleaned = cleanInterests(interests);
  if (cleaned.length === 0) return [DEFAULT_ROW];
  return cleaned.map((t) => {
    const row = interestRow(t.toLowerCase());
    return row ? { phrases: row.phrases, types: row.types } : { phrases: [t], types: [] };
  });
}

function roundRobin(rows: readonly Selected[]): string[] {
  const out: string[] = [];
  const longest = Math.max(0, ...rows.map((r) => r.phrases.length));
  for (let round = 0; round < longest; round++) {
    for (const r of rows) if (round < r.phrases.length) out.push(r.phrases[round]);
  }
  return out;
}

function unionTypes(rows: readonly Selected[]): string[] {
  const out: string[] = [];
  for (const r of rows) for (const t of r.types) if (!out.includes(t)) out.push(t);
  const types = out.length > 0 ? out : [...DEFAULT_ROW.types];
  return types.slice(0, MAX_NEARBY_TYPES);
}

export function planCandidateQueries(i: {
  destination: string;
  interests: readonly unknown[] | undefined;
  batchIndex: number;
}): CandidatePlan {
  const batchIndex = Number.isFinite(i.batchIndex) ? Math.max(0, Math.floor(i.batchIndex)) : 0;
  const rows = select(i.interests);
  const list = roundRobin(rows);
  const n = Math.min(TEXT_QUERIES_PER_BATCH, list.length);
  const textQueries: string[] = [];
  for (let k = 0; k < n; k++) {
    textQueries.push(`${list[(batchIndex * TEXT_QUERIES_PER_BATCH + k) % list.length]} in ${i.destination}`);
  }
  return {
    textQueries,
    nearbyTypes: unionTypes(rows),
    nearbyRadiusM: Math.min(NEARBY_MAX_RADIUS_M, NEARBY_BASE_RADIUS_M * 2 ** Math.min(batchIndex, 10)),
  };
}

/** The two widening steps: Nearby at twice the radius, then one combined Text Search. */
export function widenPlan(
  p: CandidatePlan,
  interests: readonly unknown[] | undefined,
  destination: string,
): { nearby: { radiusM: number; types: string[] }; text: string } {
  const phrases: string[] = [];
  for (const ph of [...DEFAULT_ROW.phrases, ...roundRobin(select(interests))]) {
    if (!phrases.includes(ph)) phrases.push(ph);
  }
  return {
    nearby: { radiusM: Math.min(NEARBY_MAX_RADIUS_M, 2 * p.nearbyRadiusM), types: [...p.nearbyTypes] },
    text: `${phrases.join(" or ")} in ${destination}`,
  };
}
