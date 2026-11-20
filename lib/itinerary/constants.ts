export const BATCH_DAYS = 3;
export const MAX_TRIP_DAYS = 14;
export const MAX_BATCHES = 5; // ceil(14 / 3)

// time (ms)
export const BATCH_REQUEST_BUDGET_MS = 25_000;
export const GEN_TIMEOUT_MS = 11_600;
export const GEN_RACE_GRACE_MS = 400;
export const VERIFY_BUDGET_MS = 8_000;
export const PASS1_BUDGET_MS = 4_500;
export const LOOKUP_TIMEOUT_MS = 2_500;
export const REPAIR_TIMEOUT_MS = 2_500;
export const REPAIR_MIN_MS = 3_500;
export const MIN_STEP_MS = 800;
export const RESPONSE_MARGIN_MS = 500;

// Places budget per batch
export const MAX_VERIFY_LOOKUPS_PER_BATCH = 30;
export const HERO_LOOKUP_RESERVE = 6;
export const HERO_TRIES_PER_DAY = 2;
export const VERIFY_RESULTS_PER_LOOKUP = 3;
export const MAX_REPLACEMENTS_PER_BATCH = 9;
// concurrency uses VERIFY_CONCURRENCY (= 6) from lib/grounding/verify-places.ts

// geography
export const DESTINATION_RADIUS_KM = 60; // 30..150
export const DAY_TRIP_RADIUS_KM = 150;
export const ROAD_SPEED_KMH = 25;
export const MAX_DAY_TRAVEL_MIN = 180;
export const MAX_LEG_TRAVEL_MIN = 90;
export const MAX_DAY_TRIP_LEG_MIN = 180;
export const DAY_TRIP_PER_DAYS = 5;

// structure
export const STOP_TARGET = { relaxed: 3, balanced: 4, packed: 5 } as const;

// wire limits
export const MAX_USED_PLACES = 100;
export const MAX_NAME_CHARS = 120;

// token budget: maxTokens = clamp(TOKENS_BASE + dayCount * (TOKENS_PER_DAY + (target + 1) * TOKENS_PER_STOP), TOKENS_MIN, TOKENS_MAX)
export const TOKENS_BASE = 250;
export const TOKENS_PER_DAY = 40;
export const TOKENS_PER_STOP = 80;
export const TOKENS_MIN = 600;
export const TOKENS_MAX = 4_000; // the limit the existing itinerary prompt already used

// caches
export const VERIFY_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // well under MAX_TTL_MS (30 days)
export const VERIFY_CACHE_MAX = 500;
export const CENTRE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const GROUNDING_MEMO_TTL_MS = 30 * 60 * 1000;
export const GROUNDING_MEMO_MAX = 50;

// planner
export const AUTO_RETRY_MAX = 1; // automatic retry per batch
export const RANGE_RETRY_MAX = 2; // automatic retries per withheld range

// client wait for one batch, above BATCH_REQUEST_BUDGET_MS
export const BATCH_CLIENT_TIMEOUT_MS = 30_000;

// places-first itinerary: Places request budget
export const MAX_PLACES_REQUESTS_PER_BATCH = 8;
export const MAX_PLACES_REQUESTS_PER_TRIP = 40; // 8 x MAX_BATCHES
export const TEXT_QUERIES_PER_BATCH = 4;
export const NEARBY_BASE_RADIUS_M = 6_000; // doubled per batch index, capped
export const NEARBY_MAX_RADIUS_M = 50_000; // Places maximum
export const MAX_WIDENING_STEPS = 2;

// places-first itinerary: time budget
export const PLACES_PHASE_END_MS = 11_000; // no new Places request after this offset
export const POLISH_TIMEOUT_MS = 8_000;
export const FINALIZE_RESERVE_MS = 500; // check, reschedule, map, log

// bedrock planner: time and input caps
export const PLANNER_TIMEOUT_MS = 7_000;
export const PLANNER_REPAIR_TIMEOUT_MS = 4_000;
export const ENRICH_RESERVE_MS = 3_000;
export const PLANNER_CANDIDATES_PER_DAY = 12;
export const PLANNER_CANDIDATES_PER_BATCH = 36;

// places-first itinerary: day window, unlisted hours, meal windows (minutes from midnight)
export const DAY_WINDOW_START_MIN = 9 * 60;
export const DAY_WINDOW_END_MIN = 20 * 60;
export const UNLISTED_HOURS_START_MIN = 9 * 60;
export const UNLISTED_HOURS_END_MIN = 18 * 60;
export const LUNCH_WINDOW_MIN = [12 * 60, 14 * 60 + 30] as const;
export const DINNER_WINDOW_MIN = [18 * 60, 20 * 60] as const;

// places-first itinerary: output limits
export const MAX_PHOTOS_PER_STOP = 3;
export const TITLE_CHARS = 80;
export const DESC_CHARS = 160;
