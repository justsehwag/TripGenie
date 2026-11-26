/**
 * Enrichment_Service (server). Looks up web evidence for the Stops of a batch
 * through researchPricing and turns it into prices and verbatim excerpts.
 *
 * - Prices come only from extractPrices and are kept only when checkWebCitation passes.
 * - Tip, booking and best-time values are verbatim snippet texts (at most 240 characters).
 * - Bedrock is never called. The function never throws.
 */
import { searxngBaseUrl, searxngSecretHeader, webPricingEnabled } from "@/lib/config";
import { resolveBudgetLevel, resolveCityTier, type CostClass } from "@/lib/cost-caps";
import { MAX_SOURCES } from "@/lib/grounding/sources";
import { extractPrices } from "@/lib/price-extractor";
import type { SourceLink, WebDetail, WebDetails } from "@/lib/types";
import { isValidWebFields } from "@/lib/web-price-sources";
import { checkWebCitation, type WebAccepted, type WebCheckContext } from "@/lib/web-pricing/citation";
import { assessWebPrice } from "@/lib/web-pricing/plausibility";
import { evidenceText, MAX_SNIPPET_CHARS, type EvidenceSet } from "@/lib/web-pricing/evidence";
import { MAX_RESEARCH_QUERIES, type ResearchActivity } from "@/lib/web-pricing/query-planner";
import {
  RESEARCH_BUDGET_MS,
  researchPricing,
  type ResearchConfig,
  type ResearchDeps,
} from "@/lib/web-pricing/service";

export interface EnrichInput {
  placeId: string;
  name: string;
  primaryType: string | null;
  kind: "sight" | "meal";
}
export interface AcceptedPrice extends WebAccepted {
  kind: "entry" | "typical";
}
export interface EnrichedStop {
  placeId: string;
  webDetails: WebDetails;
  price?: AcceptedPrice;
  /** The accepted web price with the cross-check flag, for the price fallback service. */
  candidate?: { price: AcceptedPrice; needsReference: boolean };
}
export type EnrichmentStatus = "ok" | "partial" | "not-checked";
export interface EnrichmentResult {
  status: EnrichmentStatus;
  /** One entry per input. Stops that were not checked have `webDetails: { checked: false }`. */
  stops: Map<string, EnrichedStop>;
  /** SearXNG searches actually sent. */
  queries: number;
  /** Distinct accepted sources, at most MAX_SOURCES. */
  sources: SourceLink[];
  /** True only when enrichment is configured, searches were sent and every one failed. */
  unavailable: boolean;
}
export interface EnrichmentDeps {
  /** Receives the one counts-only `[searxng-health]` line. Defaults to console.info. */
  healthLogger?: (line: string) => void;
  research?: typeof researchPricing;
  now?: () => number;
  /** Remaining batch budget in ms. The effective budget is min(this, RESEARCH_BUDGET_MS). */
  budgetMs?: number;
  fetchImpl?: ResearchDeps["fetchImpl"];
  config?: ResearchConfig;
  cache?: ResearchDeps["cache"];
  limiter?: ResearchDeps["limiter"];
}

export type DetailKind = "tip" | "booking" | "bestTime";

const FREE_PLACE_TYPES = new Set(["park", "beach", "natural_feature", "hiking_area"]);
const FORBIDDEN = /confirmed|bookable|guaranteed|100%\s*accurate/i;
const PATTERNS: Record<DetailKind, RegExp> = {
  bestTime: /\b(best time|ideal time|visit (early|in the morning)|sunrise|sunset|off-?season|peak season)\b/i,
  booking: /\b(book(ing)?|reserv(e|ation)|in advance|pre-?book|tickets? online)\b/i,
  tip: /\b(tip|avoid|crowds?|arrive early|dress code|closed on|carry|wear)\b/i,
};

function isoOf(ms: number): string | null {
  try {
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Place identity used by the plausibility check. When absent, the check is skipped. */
export interface PlausibilityContext {
  placeName: string;
  primaryType?: string | null;
}

export interface PickedWebPrice {
  price: WebAccepted;
  /** True when the plausibility check asks for a Google or AI reference. */
  needsReference: boolean;
}

/** Pure. Like pickWebPrice, but also reports `needsReference` for the accepted candidate. */
export function pickWebPriceChecked(
  set: EvidenceSet | undefined,
  ctx: WebCheckContext,
  place?: PlausibilityContext,
): PickedWebPrice | undefined {
  try {
    if (!set || !Array.isArray(set.snippets) || set.snippets.length === 0) return undefined;
    const c: WebCheckContext = { ...ctx, evidence: set };
    const allowFree = ctx.kind === "entry-fee";
    // Returns null when the candidate is rejected as implausible.
    const plausible = (snip: EvidenceSet["snippets"][number], inr: number): { needsReference: boolean } | null => {
      if (!place) return { needsReference: false };
      const r = assessWebPrice({
        inr,
        snippet: { title: snip.title, text: snip.text },
        placeName: place.placeName,
        costClass: ctx.costClass,
        primaryType: place.primaryType ?? null,
        costBasis: ctx.costBasis === "group" ? "group" : "person",
      });
      return r.verdict === "reject" ? null : { needsReference: r.needsReference };
    };
    let freeSnippet: EvidenceSet["snippets"][number] | undefined;
    for (const snip of set.snippets) {
      const ex = extractPrices(evidenceText(snip));
      let hasPlain = false;
      for (const cand of ex.candidates) {
        if (!(cand.max > 0 && (cand.audience === "indian" || cand.audience === "unspecified"))) continue;
        hasPlain = true;
        if (cand.unit === "vehicle") continue;
        const v = checkWebCitation({ source: "web", sourceUrl: snip.url, inr: cand.min }, c);
        if (!v.ok) continue;
        const p = plausible(snip, v.price.inr);
        if (p) return { price: v.price, needsReference: p.needsReference };
      }
      if (allowFree && ex.freeEntry && !hasPlain && freeSnippet === undefined) freeSnippet = snip;
    }
    if (freeSnippet !== undefined) {
      const v = checkWebCitation({ source: "web", sourceUrl: freeSnippet.url, inr: 0 }, c);
      if (v.ok) {
        const p = plausible(freeSnippet, 0);
        if (p) return { price: v.price, needsReference: p.needsReference };
      }
    }
  } catch {
    // fall through
  }
  return undefined;
}

/** Pure. Accepts a price only through checkWebCitation (and assessWebPrice when `place` is given). */
export function pickWebPrice(
  set: EvidenceSet | undefined,
  ctx: WebCheckContext,
  place?: PlausibilityContext,
): WebAccepted | undefined {
  return pickWebPriceChecked(set, ctx, place)?.price;
}

/** Pure. One verbatim snippet text of at most MAX_SNIPPET_CHARS, with its source. No rewriting. */
export function extractExcerpt(
  kind: DetailKind,
  set: EvidenceSet | undefined,
  checkedAt: string,
): (WebDetail & { title: string }) | undefined {
  try {
    if (!set || !Array.isArray(set.snippets)) return undefined;
    const re = PATTERNS[kind];
    for (const snip of set.snippets) {
      const text = snip.text;
      if (typeof text !== "string" || text.length < 1 || text.length > MAX_SNIPPET_CHARS) continue;
      if (!re.test(text) || FORBIDDEN.test(text)) continue;
      const sourceHost = hostOf(snip.url);
      if (!isValidWebFields({ sourceUrl: snip.url, sourceHost, checkedAt })) continue;
      return { text, sourceUrl: snip.url, sourceHost, checkedAt, title: snip.title };
    }
  } catch {
    // fall through
  }
  return undefined;
}

function unchecked(stops: readonly EnrichInput[], queries = 0): EnrichmentResult {
  const map = new Map<string, EnrichedStop>();
  for (const s of stops) map.set(s.placeId, { placeId: s.placeId, webDetails: { checked: false } });
  return { status: "not-checked", stops: map, queries, sources: [], unavailable: false };
}

let healthReported = false;

/** Clears the once-per-process flag. Used by tests. */
export function resetSearxngHealth(): void {
  healthReported = false;
}

/** Counts only. Never receives a URL, host, query or error text. */
export function reportSearxngHealth(
  stats: { queries: number; failed: number },
  logger: (line: string) => void = (line) => console.info(line),
): void {
  try {
    if (!(stats.queries > 0)) return;
    if (stats.failed === 0) {
      healthReported = false;
      return;
    }
    if (healthReported) return;
    healthReported = true;
    const status = stats.failed >= stats.queries ? "unreachable" : "degraded";
    logger(`[searxng-health] status=${status} queries=${stats.queries} failed=${stats.failed}`);
  } catch {
    // logging never affects the result
  }
}

function defaultConfig(): ResearchConfig {
  return { enabled: webPricingEnabled(), baseUrl: searxngBaseUrl(), secretHeader: searxngSecretHeader() };
}

export async function enrichStops(
  stops: readonly EnrichInput[],
  ctx: { destination: string; budgetLevel?: unknown },
  deps: EnrichmentDeps = {},
): Promise<EnrichmentResult> {
  const list = Array.isArray(stops) ? stops.filter((s) => s && typeof s.placeId === "string") : [];
  try {
    if (list.length === 0) return unchecked(list);
    const config = deps.config ?? defaultConfig();
    if (!config.enabled || !config.baseUrl) return unchecked(list);

    const cap = typeof deps.budgetMs === "number" && Number.isFinite(deps.budgetMs) ? deps.budgetMs : Infinity;
    const budgetMs = Math.min(RESEARCH_BUDGET_MS, cap);
    if (!(budgetMs > 0)) return unchecked(list);

    // Sights before meals; input (day, time) order is kept inside each group.
    const ordered = [...list.filter((s) => s.kind !== "meal"), ...list.filter((s) => s.kind === "meal")];
    const activities: ResearchActivity[] = ordered.map((s) => {
      const meal = s.kind === "meal";
      const costClass: CostClass = meal
        ? "meal"
        : s.primaryType && FREE_PLACE_TYPES.has(s.primaryType)
          ? "free-sight"
          : "paid-sight";
      return { id: s.placeId, title: meal ? `Lunch at ${s.name}` : s.name, costClass, costBasis: "person" };
    });
    const classOf = new Map(activities.map((a) => [a.id, a.costClass]));

    const research = deps.research ?? researchPricing;
    const r = await research(
      { destination: ctx.destination, activities },
      {
        budgetMs,
        maxQueries: MAX_RESEARCH_QUERIES,
        logger: () => undefined,
        config,
        now: deps.now,
        fetchImpl: deps.fetchImpl,
        cache: deps.cache,
        limiter: deps.limiter,
      },
    );

    reportSearxngHealth({ queries: r.stats.queries, failed: r.stats.failed }, deps.healthLogger);
    const unavailable = r.stats.queries > 0 && r.stats.failed === r.stats.queries;

    const budget = resolveBudgetLevel(ctx.budgetLevel);
    const tier = resolveCityTier(ctx.destination);
    const out = new Map<string, EnrichedStop>();
    const sources: SourceLink[] = [];
    const seenUrls = new Set<string>();
    const addSource = (title: string, url: string, host: string) => {
      if (sources.length >= MAX_SOURCES || seenUrls.has(url)) return;
      const t = (title || host).trim().slice(0, 200);
      if (!t) return;
      seenUrls.add(url);
      sources.push({ title: t, url, host });
    };
    const answeredEmpty = r.stats.failed === 0;
    let checkedCount = 0;

    for (const s of list) {
      if (out.has(s.placeId)) continue;
      const target = r.plan.targets[s.placeId];
      const set = target ? r.sets[target.key] : undefined;
      if (!target || !set || (set.snippets.length === 0 && !answeredEmpty)) {
        out.set(s.placeId, { placeId: s.placeId, webDetails: { checked: false } });
        continue;
      }
      checkedCount += 1;
      const details: WebDetails = { checked: true };
      let price: AcceptedPrice | undefined;
      const picked = pickWebPriceChecked(
        set,
        {
          evidence: set,
          kind: target.kind,
          costClass: classOf.get(s.placeId) ?? "paid-sight",
          costBasis: "person",
          budget,
          tier,
        },
        { placeName: s.name, primaryType: s.primaryType },
      );
      const accepted = picked?.price;
      let candidate: EnrichedStop["candidate"];
      if (picked && accepted && isValidWebFields(accepted)) {
        candidate = {
          price: { ...accepted, kind: target.kind === "meal" ? "typical" : "entry" },
          needsReference: picked.needsReference,
        };
      }
      if (accepted && isValidWebFields(accepted)) {
        const kind = target.kind === "meal" ? "typical" : "entry";
        price = { ...accepted, kind };
        details.priceKind = kind;
        const title = set.snippets.find((x) => x.url === accepted.sourceUrl)?.title ?? accepted.sourceHost;
        addSource(title, accepted.sourceUrl, accepted.sourceHost);
      }
      const checkedAt = isoOf(set.checkedAtMs);
      if (checkedAt) {
        for (const kind of ["tip", "booking", "bestTime"] as const) {
          const ex = extractExcerpt(kind, set, checkedAt);
          if (!ex) continue;
          const { title, ...detail } = ex;
          details[kind] = detail;
          addSource(title, detail.sourceUrl, detail.sourceHost);
        }
      }
      const stop: EnrichedStop = price
        ? { placeId: s.placeId, webDetails: details, price }
        : { placeId: s.placeId, webDetails: details };
      if (candidate) stop.candidate = candidate;
      out.set(s.placeId, stop);
    }

    const status: EnrichmentStatus =
      checkedCount === 0 ? "not-checked" : checkedCount === out.size ? "ok" : "partial";
    return { status, stops: out, queries: r.stats.queries, sources, unavailable };
  } catch {
    return unchecked(list);
  }
}
