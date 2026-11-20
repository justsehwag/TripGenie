/**
 * Grounding_Service: builds queries, calls SearXNG in parallel within a time
 * budget, sanitizes, de-duplicates and caches the result. Never throws.
 *
 * Server-only pure module: no react, next or AWS SDK imports. Never touches
 * SerpApi or the shared providerStore. Logs one line with status, snippet
 * count and elapsed ms only (never URLs, queries, headers or error objects).
 *
 * Requirements: 3.1-3.8, 6.9, 9.2-9.4, 10.2, 10.6, 11.5, 11.8, 11.9, 12.4, 14.1, 14.2, 14.7-14.9.
 */
import { searxngBaseUrl, searxngEnabled, searxngSecretHeader } from "@/lib/config";
import { searxngSearch, type SearxngFetch, type SearxngOutcome, type SearxngResult } from "@/lib/providers/searxng";
import { dedupeAndTrim } from "@/lib/grounding/bundle";
import { createGroundingCache, groundingCacheKey, type GroundingCache } from "@/lib/grounding/cache";
import { searxngLimiter, type Limiter } from "@/lib/grounding/limiter";
import { buildGroundingQueries } from "@/lib/grounding/queries";
import { sanitizeSnippets } from "@/lib/grounding/sanitize";
import { EMPTY_BUNDLE, type GroundingBundle, type GroundingInput } from "@/lib/grounding/types";

export const GROUNDING_BUDGET_MS = 3000;
export const LOG_TAG = "[searxng-grounding]";

export interface GroundingConfig {
  enabled: boolean;
  baseUrl: string;
  secretHeader: { name: string; value: string } | null;
}

export interface GroundingDeps {
  fetchImpl?: SearxngFetch;
  /** Clock in ms; default Date.now. */
  now?: () => number;
  /** Config override; default reads env via lib/config on every call. */
  config?: GroundingConfig;
  cache?: GroundingCache;
  limiter?: Limiter;
  budgetMs?: number;
  /** Receives the single log line; default console.info. */
  logger?: (line: string) => void;
}

/** Module-level default cache so bundles survive across requests. */
let defaultCache: GroundingCache | null = null;
function getDefaultCache(): GroundingCache {
  if (!defaultCache) defaultCache = createGroundingCache();
  return defaultCache;
}

function readConfig(): GroundingConfig {
  return { enabled: searxngEnabled(), baseUrl: searxngBaseUrl(), secretHeader: searxngSecretHeader() };
}

export async function groundItinerary(
  input: GroundingInput,
  deps: GroundingDeps = {},
): Promise<GroundingBundle> {
  const now = deps.now ?? Date.now;
  const started = safeNow(now);
  let bundle: GroundingBundle = EMPTY_BUNDLE("unavailable");
  try {
    bundle = await ground(input, deps, now);
  } catch {
    bundle = EMPTY_BUNDLE("unavailable"); // Req 9.2: never throw
  }
  try {
    const line = `${LOG_TAG} status=${bundle.status} snippets=${bundle.snippets.length} ms=${Math.max(0, safeNow(now) - started)}`;
    (deps.logger ?? ((l: string) => console.info(l)))(line);
  } catch {
    // logging must never affect the result
  }
  return bundle;
}

function safeNow(now: () => number): number {
  try {
    const n = now();
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

async function ground(input: GroundingInput, deps: GroundingDeps, now: () => number): Promise<GroundingBundle> {
  const config = deps.config ?? readConfig();
  if (!config.enabled || !config.baseUrl) return EMPTY_BUNDLE("disabled");

  const queries = buildGroundingQueries(input);
  if (queries.length === 0) return EMPTY_BUNDLE("empty");

  const cache = deps.cache ?? getDefaultCache();
  const key = groundingCacheKey(input.destination ?? "", input.vibe ?? "");
  const hit = cache.get(key, safeNow(now));
  if (hit) return hit;

  const limiter = deps.limiter ?? searxngLimiter;
  const budgetMs = deps.budgetMs ?? GROUNDING_BUDGET_MS;

  return cache.dedupe(key, async () => {
    const bundle = await run(queries, config, { fetchImpl: deps.fetchImpl, limiter, budgetMs });
    cache.set(key, bundle, safeNow(now)); // set() skips unavailable and disabled
    return bundle;
  });
}

async function run(
  queries: string[],
  config: GroundingConfig,
  opts: { fetchImpl?: SearxngFetch; limiter: Limiter; budgetMs: number },
): Promise<GroundingBundle> {
  // One slot per query, taken synchronously; queries without a slot count as failed.
  const slots: Array<(() => void) | null> = queries.map(() => opts.limiter.tryAcquire());
  const active = slots.filter((s): s is () => void => s !== null);
  if (active.length === 0) return EMPTY_BUNDLE("unavailable"); // Req 14.8

  const controller = new AbortController();
  const outcomes: Array<SearxngOutcome | undefined> = queries.map(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const client = { baseUrl: config.baseUrl, secretHeader: config.secretHeader };
    const running = queries.map((q, i) => {
      if (!slots[i]) return Promise.resolve();
      return searxngSearch(q, client, { fetchImpl: opts.fetchImpl, signal: controller.signal })
        .then((o) => {
          outcomes[i] = o;
        })
        .catch(() => {
          outcomes[i] = { kind: "failed" };
        });
    });
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, opts.budgetMs);
    });
    await Promise.race([Promise.allSettled(running), budget]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
    for (const release of active) release(); // idempotent
  }

  // Snapshot: anything not recorded by now counts as failed.
  const final = outcomes.slice();
  if (final.some((o) => o?.kind === "redirect")) return EMPTY_BUNDLE("unavailable");

  let failed = 0;
  const raw: SearxngResult[] = [];
  for (const o of final) {
    if (o && o.kind === "ok") raw.push(...o.results);
    else failed += 1;
  }

  const { kept, droppedCount } = sanitizeSnippets(raw);
  const snippets = dedupeAndTrim(kept);

  let status: GroundingBundle["status"];
  if (snippets.length > 0) status = failed > 0 ? "partial" : "ok";
  else status = failed > 0 ? "unavailable" : "empty";

  return { status, snippets: status === "ok" || status === "partial" ? snippets : [], droppedCount };
}
