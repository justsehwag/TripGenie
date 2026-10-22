/**
 * Provider reviews (pure) - TripGenie parity with TripSaathi FR-30: show
 * attributable provider reviews ONLY when a provider actually returns review
 * metadata, and a clear "no verified reviews" state otherwise. The engine never
 * fabricates a score or a count for estimated/demo inventory.
 */

/** A single attributable review from an external provider. */
export interface ProviderReview {
  author: string;
  rating: number;
  text: string;
  /** ISO timestamp the provider reported for the review. */
  publishedAt: string;
}

/** Raw review payload a provider adapter may hand us (all fields optional). */
export interface ProviderReviewPayload {
  provider?: string;
  score?: number | null;
  count?: number | null;
  verified?: boolean;
  reviews?: Array<Partial<ProviderReview>>;
  fetchedAt?: string;
}

/** The normalized summary the UI renders. */
export interface ReviewSummary {
  /** True only when a provider returned verified, attributable review data. */
  hasReviews: boolean;
  /** Average score (0-5) when present, else null - never fabricated. */
  score: number | null;
  /** Number of reviews the provider reported. */
  count: number;
  /** Provider attribution string, or the no-provider message. */
  source: string;
  verified: boolean;
  /** Up to three attributable reviews, empty when none are verified. */
  items: ProviderReview[];
  fetchedAt: string;
  /** User-facing note describing the state (reviewed vs no-verified-reviews). */
  note: string;
}

const NO_PROVIDER = "No connected review provider";
const NO_VERIFIED = "No verified reviews are available for this option yet.";

/** Clamp a numeric score into the 0-5 range, or null if not a finite number. */
function clampScore(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(5, Math.max(0, Math.round(value * 10) / 10));
}

/** A valid attributable review has an author, a finite rating and non-empty text. */
function normalizeReview(raw: Partial<ProviderReview>): ProviderReview | null {
  const author = typeof raw.author === "string" ? raw.author.trim() : "";
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  const rating = clampScore(raw.rating);
  if (!author || !text || rating === null) return null;
  const publishedAt =
    typeof raw.publishedAt === "string" && raw.publishedAt.trim()
      ? raw.publishedAt
      : new Date(0).toISOString();
  return { author, rating, text, publishedAt };
}

/**
 * The empty / no-verified-reviews summary. Used whenever a provider is absent or
 * returned nothing attributable - estimated inventory always resolves here.
 */
export function noVerifiedReviews(
  source: string = NO_PROVIDER,
  now: Date = new Date(),
): ReviewSummary {
  return {
    hasReviews: false,
    score: null,
    count: 0,
    source,
    verified: false,
    items: [],
    fetchedAt: now.toISOString(),
    note: NO_VERIFIED,
  };
}

/**
 * Normalize a provider payload into a ReviewSummary. Reviews are surfaced ONLY
 * when the payload is explicitly verified AND carries at least one valid,
 * attributable review; otherwise the result is the no-verified-reviews state
 * (FR-30). Never invents a score or count.
 */
export function summarizeReviews(
  payload: ProviderReviewPayload | null | undefined,
  now: Date = new Date(),
): ReviewSummary {
  if (!payload) return noVerifiedReviews(NO_PROVIDER, now);
  const source = payload.provider?.trim() || NO_PROVIDER;
  const items = (payload.reviews ?? [])
    .map(normalizeReview)
    .filter((r): r is ProviderReview => r !== null)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, 3);
  const verified = payload.verified === true && items.length > 0;
  if (!verified) return noVerifiedReviews(source, now);
  const count = typeof payload.count === "number" && payload.count > 0 ? Math.trunc(payload.count) : items.length;
  const score = clampScore(payload.score);
  return {
    hasReviews: true,
    score,
    count,
    source,
    verified: true,
    items,
    fetchedAt: payload.fetchedAt?.trim() || now.toISOString(),
    note: `${count} verified ${count === 1 ? "review" : "reviews"} via ${source}.`,
  };
}