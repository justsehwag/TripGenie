/**
 * Web research for pricing (server-only). Plans queries, runs them through
 * SearXNG in parallel inside a time budget, builds Evidence_Sets and caches
 * the complete ones. Never throws. Logs one line with counts only.
 *
 * Follows the pattern of lib/grounding/service.ts. No react, next or AWS imports.
 */
import { searxngBaseUrl, searxngSecretHeader, webPricingEnabled } from "@/lib/config";
import { searxngLimiter, type Limiter } from "@/lib/grounding/limiter";
import { extractPrices } from "@/lib/price-extractor";
import { searxngSearch, type SearxngFetch, type SearxngResult } from "@/lib/providers/searxng";
import { buildEvidenceSet, evidenceText, type EvidenceSet } from "@/lib/web-pricing/evidence";
import { createEvidenceCache, type EvidenceCache } from "@/lib/web-pricing/evidence-cache";
import {
  MAX_RESEARCH_QUERIES,
  planQueries,
  type PlaceKey,
  type MiscResearchInput,
  type PlannedQuery,
  type ResearchKind,
  type ResearchPlan,
} from "@/lib/web-pricing/query-planner";

export const RESEARCH_BUDGET_MS = 8000;
export const LOG_TAG = "[web-pricing]";
/** Poll interval while waiting for a limiter slot. */
const SLOT_POLL_MS = 25;
/** A second-attempt query needs at least this much budget left. */
const RETRY_MIN_REMAINING_MS = 600;
/** Max wait for tasks to settle after the budget abort. */
const SETTLE_MS = 200;

export interface ResearchConfig {
  enabled: boolean;
  baseUrl: string;
  secretHeader: { name: string; value: string } | null;
}

export interface ResearchDeps {
  fetchImpl?: SearxngFetch;
  now?: () => number;
  config?: ResearchConfig;
  cache?: EvidenceCache;
  limiter?: Limiter;
  budgetMs?: number;
  maxQueries?: number;
  logger?: (line: string) => void;
}

export type ResearchStatus = "off" | "none" | "partial" | "ok";

export interface ResearchResult {
  status: ResearchStatus;
  plan: ResearchPlan<ResearchKind>;
  sets: Record<PlaceKey, EvidenceSet>;
  stats: { queries: number; failed: number; snippets: number; candidates: number; ms: number };
}

let defaultCache: EvidenceCache | null = null;
function getDefaultCache(): EvidenceCache {
  if (!defaultCache) defaultCache = createEvidenceCache();
  return defaultCache;
}

function readConfig(): ResearchConfig {
  return { enabled: webPricingEnabled(), baseUrl: searxngBaseUrl(), secretHeader: searxngSecretHeader() };
}

function safeNow(now: () => number): number {
  try {
    const n = now();
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

const emptyPlan = (): ResearchPlan<ResearchKind> => ({ targets: {}, queries: [], retries: {}, route: {} });
const zeroStats = () => ({ queries: 0, failed: 0, snippets: 0, candidates: 0, ms: 0 });

export async function researchPricing(input: MiscResearchInput, deps: ResearchDeps = {}): Promise<ResearchResult> {
  const now = deps.now ?? Date.now;
  const started = safeNow(now);
  let result: ResearchResult;
  try {
    const config = deps.config ?? readConfig();
    if (!config.enabled || !config.baseUrl) {
      return { status: "off", plan: emptyPlan(), sets: {}, stats: zeroStats() };
    }
    result = await run(input, config, deps, now, started);
  } catch {
    result = { status: "none", plan: emptyPlan(), sets: {}, stats: zeroStats() };
  }
  result.stats.ms = Math.max(0, safeNow(now) - started);
  try {
    const s = result.stats;
    const line = `${LOG_TAG} status=${result.status} queries=${s.queries} snippets=${s.snippets} candidates=${s.candidates} ms=${s.ms}`;
    (deps.logger ?? ((l: string) => console.info(l)))(line);
  } catch {
    // logging must never affect the result
  }
  return result;
}

interface TaskOutcome {
  set?: EvidenceSet;
  /** True when the set is complete and failure-free (safe to cache). */
  complete: boolean;
}

function hasCandidate(results: readonly SearxngResult[]): boolean {
  try {
    for (const r of results) {
      const e = extractPrices(`${r.title} ${r.content}`);
      if (e.candidates.length > 0 || e.freeEntry) return true;
    }
  } catch {
    // treat as none
  }
  return false;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    let t: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Poll for a limiter slot until one is free or the signal aborts. */
async function waitForSlot(limiter: Limiter, signal: AbortSignal): Promise<(() => void) | null> {
  while (!signal.aborted) {
    const release = limiter.tryAcquire();
    if (release) {
      if (signal.aborted) {
        release();
        return null;
      }
      return release;
    }
    await sleep(SLOT_POLL_MS, signal);
  }
  return null;
}

async function run(
  input: MiscResearchInput,
  config: ResearchConfig,
  deps: ResearchDeps,
  now: () => number,
  started: number,
): Promise<ResearchResult> {
  const cache = deps.cache ?? getDefaultCache();
  const limiter = deps.limiter ?? searxngLimiter;
  const budgetMs = deps.budgetMs ?? RESEARCH_BUDGET_MS;
  const maxQueries = deps.maxQueries ?? MAX_RESEARCH_QUERIES;

  const plan = planQueries(input, {
    isCached: (k) => cache.get(k, safeNow(now)) !== undefined,
    max: maxQueries,
  });

  const sets: Record<PlaceKey, EvidenceSet> = {};
  // Cached sets for every target key (including route keys).
  const wanted = new Set<PlaceKey>([
    ...Object.values(plan.targets).map((t) => t.key),
    ...(plan.route.bus ? [plan.route.bus] : []),
    ...(plan.route.train ? [plan.route.train] : []),
  ]);
  for (const k of wanted) {
    const hit = cache.get(k, safeNow(now));
    if (hit) sets[k] = hit;
  }

  const stats = zeroStats();
  if (plan.queries.length === 0) {
    return { status: statusOf(sets, true), plan, sets, stats: finish(stats, sets) };
  }

  const controller = new AbortController();
  const client = { baseUrl: config.baseUrl, secretHeader: config.secretHeader };
  let tokens = Math.max(0, maxQueries - plan.queries.length);
  let redirect = false;
  let finished = false;
  let incomplete = false;

  /** One search with a limiter slot. Counts only searches actually sent. */
  async function search(query: string): Promise<SearxngResult[] | null> {
    const release = await waitForSlot(limiter, controller.signal);
    if (!release) return null;
    let onAbort: (() => void) | undefined;
    try {
      stats.queries += 1;
      // A fetch that ignores the abort signal must not keep the slot past the budget.
      const aborted = new Promise<null>((resolve) => {
        onAbort = () => resolve(null);
        if (controller.signal.aborted) onAbort();
        else controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      const search1 = searxngSearch(query, client, { fetchImpl: deps.fetchImpl, signal: controller.signal });
      search1.catch(() => undefined);
      const o = await Promise.race([search1, aborted]);
      if (o === null) return null;
      if (o.kind === "redirect") {
        redirect = true;
        controller.abort();
        return null;
      }
      return o.kind === "ok" ? o.results : null;
    } catch {
      return null;
    } finally {
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      release();
    }
  }

  async function runKey(q: PlannedQuery<ResearchKind>): Promise<TaskOutcome> {
    let complete = true;
    let results: SearxngResult[] = [];
    const first = await search(q.query);
    if (first === null) {
      stats.failed += 1;
      complete = false;
    } else {
      results = first;
      const retryQuery = q.kind === "entry-fee" ? plan.retries[q.key] : undefined;
      if (retryQuery && !hasCandidate(results)) {
        const remaining = started + budgetMs - safeNow(now);
        if (tokens > 0 && remaining >= RETRY_MIN_REMAINING_MS) {
          tokens -= 1;
          const second = await search(retryQuery);
          if (second === null) {
            stats.failed += 1;
            complete = false;
          } else {
            results = [...results, ...second];
          }
        } else {
          complete = false; // retry skipped for lack of a token or time
        }
      }
    }
    if (finished || redirect || controller.signal.aborted) return { complete: false };
    const set = buildEvidenceSet(q.key, q.kind, results, safeNow(now));
    return { set, complete };
  }

  const tasks = plan.queries.map((q) =>
    cache
      .dedupe(q.key, () => runKey(q))
      .then((out) => {
        if (finished) return;
        if (out.set) {
          sets[q.key] = out.set;
          if (out.complete) cache.set(out.set, safeNow(now));
        }
        if (!out.complete) incomplete = true;
      })
      .catch(() => {
        incomplete = true;
      }),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, budgetMs);
    });
    await Promise.race([Promise.allSettled(tasks), budget]);
    if (timedOut) {
      controller.abort();
      await Promise.race([Promise.allSettled(tasks), sleep(SETTLE_MS)]);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
    finished = true;
  }

  if (redirect) return { status: "none", plan, sets: {}, stats: finish(stats, {}) };
  const unfinished = plan.queries.some((q) => !sets[q.key]);
  return {
    status: statusOf(sets, !incomplete && !timedOut && !unfinished),
    plan,
    sets,
    stats: finish(stats, sets),
  };
}

function finish(stats: ResearchResult["stats"], sets: Record<PlaceKey, EvidenceSet>): ResearchResult["stats"] {
  let snippets = 0;
  let candidates = 0;
  for (const s of Object.values(sets)) {
    for (const sn of s.snippets) {
      snippets += 1;
      try {
        candidates += extractPrices(evidenceText(sn)).candidates.length;
      } catch {
        // ignore
      }
    }
  }
  stats.snippets = snippets;
  stats.candidates = candidates;
  return stats;
}

function statusOf(sets: Record<PlaceKey, EvidenceSet>, clean: boolean): ResearchStatus {
  const any = Object.values(sets).some((s) => s.snippets.length > 0);
  if (!any) return "none";
  return clean ? "ok" : "partial";
}
