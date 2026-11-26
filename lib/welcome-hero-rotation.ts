/**
 * Pure helpers for the welcome-screen hero backdrop rotation.
 *
 * Query wording matters: /api/image resolves a destination through
 * lib/destination-image.ts, which tries (1) Google Places "top tourist
 * attractions in <query>", (2) the Wikipedia page "Tourism in <query>", and
 * (3) the images of the Wikipedia page titled <query>. Each entry below is
 * therefore a plain place name that has its own Wikipedia article (and, for
 * most, a "Tourism in ..." article), not a descriptive phrase such as
 * "Kerala backwaters houseboat", which matches neither page and would
 * resolve to no image.
 */
export const WELCOME_HERO_QUERIES = [
  "Kerala",
  "Ladakh",
  "Udaipur",
  "Goa",
  "Santorini",
  "Switzerland",
] as const;

export const ROTATION_INTERVAL_MS = 10000;

/** Pure: index -> query. Always a member of WELCOME_HERO_QUERIES. */
export function queryForIndex(index: number): string {
  const n = WELCOME_HERO_QUERIES.length;
  const raw = Number.isFinite(index) ? Math.trunc(index) : 0;
  const i = ((raw % n) + n) % n;
  return WELCOME_HERO_QUERIES[i];
}

/**
 * Pure: next index after a load failure. Always advances, so the failed
 * query is not retried immediately when the list has more than one entry.
 */
export function nextIndexOnFailure(currentIndex: number): number {
  const n = WELCOME_HERO_QUERIES.length;
  if (n <= 1) return currentIndex;
  return (((currentIndex + 1) % n) + n) % n;
}

/**
 * Pure: should the rotation advance now? True exactly when
 * elapsedMs >= ROTATION_INTERVAL_MS && loaded && !reducedMotion.
 */
export function shouldAdvance(input: {
  elapsedMs: number;
  loaded: boolean;
  reducedMotion: boolean;
}): boolean {
  return input.elapsedMs >= ROTATION_INTERVAL_MS && input.loaded && !input.reducedMotion;
}
