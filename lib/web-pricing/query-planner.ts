/**
 * Query planner for web-grounded pricing. Pure and total: builds the capped,
 * prioritised list of SearXNG queries for a pricing request. No React, Next,
 * AWS or network imports.
 */

import type { CostBasis, CostClass } from "@/lib/cost-caps";
import { cleanText } from "@/lib/grounding/queries";

export type PriceKind = "entry-fee" | "meal" | "cab-fare" | "route-fare";
export type ResearchKind = PriceKind | "misc";
export type PlaceKey = string;

export const MAX_RESEARCH_QUERIES = 10;
export const MAX_MEAL_QUERIES = 3;
export const MAX_QUERY_CHARS = 120;

export interface ResearchActivity {
  id: string;
  title: string;
  costClass: CostClass;
  costBasis: CostBasis;
}
export interface MiscEntry {
  id: string;
  label: string;
  hint: string;
}
/** Price research without misc items. Plans built from it only carry PriceKind queries. */
export interface ResearchInput {
  destination: string;
  origin?: string;
  routeFare?: boolean;
  activities: ResearchActivity[];
  misc?: undefined;
}
/** Price research that may also carry misc items. Plans built from it may carry "misc" queries. */
export interface MiscResearchInput extends Omit<ResearchInput, "misc"> {
  misc?: MiscEntry[];
}
export interface ResearchTarget {
  key: PlaceKey;
  kind: ResearchKind;
  name: string;
}
export interface PlannedQuery<K extends ResearchKind = PriceKind> {
  key: PlaceKey;
  kind: K;
  query: string;
  attempt: 1 | 2;
  variant?: "bus" | "train";
}
export interface ResearchPlan<K extends ResearchKind = PriceKind> {
  /** activity id -> the Evidence_Set it may cite. Cached keys stay here. */
  targets: Record<string, ResearchTarget>;
  /** Cache misses only, in priority order, at most `max`. First attempts only. */
  queries: PlannedQuery<K>[];
  /** Second-attempt entry-fee query per Place_Key. */
  retries: Record<PlaceKey, string>;
  /** Route Evidence_Set keys by mode when routeFare was requested. */
  route: { bus?: PlaceKey; train?: PlaceKey };
}

/** Lower-case, diacritics folded, whitespace collapsed. */
export function normalizeForKey(s: string): string {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

export function placeKeyOf(kind: ResearchKind, name: string, destination: string, variant?: string): PlaceKey {
  return `${kind}|${variant ?? ""}|${normalizeForKey(name)}|${normalizeForKey(destination)}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const LEADING_WORDS =
  /^(?:visit(?:ing)?|explor(?:e|ing|ation)(?:\s+of)?|tour\s+of|sunset\s+at|sunrise\s+at|walk\s+around|morning|afternoon|evening)\s+/i;
const TRAILING_WORDS = /\s+(?:exploration|visit|tour|walk)$/i;

/**
 * Place name from an activity title. For meals this is the text after " at " or
 * " in ", or the destination when there is none. Empty string means no query.
 */
export function cleanPlaceName(title: string, destination: string): string {
  const dest = cleanText(destination);
  let t = cleanText(title);
  if (!t) return "";
  const meal = /^(?:breakfast|brunch|lunch|dinner|supper|snacks?|meal|tea|coffee)\b/i.test(t);
  if (meal) {
    const m = /\b(?:at|in)\s+(.+)$/i.exec(t);
    return m ? cleanText(m[1]) : dest;
  }
  for (let i = 0; i < 4 && LEADING_WORDS.test(t); i++) t = t.replace(LEADING_WORDS, "");
  for (let i = 0; i < 3 && TRAILING_WORDS.test(t); i++) t = t.replace(TRAILING_WORDS, "");
  if (dest) {
    const tail = new RegExp(`(?:\\s+(?:in|at|of))?\\s+${escapeRe(dest)}$`, "i");
    const stripped = t.replace(tail, "").trim();
    if (stripped) t = stripped;
  }
  return cleanText(t);
}

/** Drop the last word, or the last character of a single word. */
function shrink(s: string): string {
  const i = s.lastIndexOf(" ");
  if (i > 0) return s.slice(0, i).trim();
  return Array.from(s).slice(0, -1).join("").trim();
}

const len = (s: string) => Array.from(s).length;

/**
 * Build a query within MAX_QUERY_CHARS. Fixed words are never cut; the first
 * part (the place) is shortened first, then the second. Empty when the place
 * is empty.
 */
function compose(fmt: (a: string, b: string) => string, a: string, b: string): string {
  let x = a;
  let y = b;
  if (!x) return "";
  let q = fmt(x, y).replace(/\s+/gu, " ").trim();
  // Shorten the place first, but never to nothing: an over-long second part
  // (destination) must still be shortened rather than dropping the query.
  while (len(q) > MAX_QUERY_CHARS) {
    const next = shrink(x);
    if (!next) break;
    x = next;
    q = fmt(x, y).replace(/\s+/gu, " ").trim();
  }
  while (len(q) > MAX_QUERY_CHARS && y) {
    y = shrink(y);
    q = fmt(x, y).replace(/\s+/gu, " ").trim();
  }
  return len(q) > MAX_QUERY_CHARS ? "" : q;
}

const VEHICLE_PREFIX =
  /^(?:private\s+)?(?:cab|taxi|auto(?:-?rickshaw)?|car|driver)(?:\s+(?:ride|transfer|hire|rental|service))?\s+/i;

/** Parse "from X to Y", "X to Y" or "to Y" out of a transfer title. */
function parseRoute(title: string, dest: string): { from: string; to: string } | null {
  const t = cleanText(title);
  let m = /\bfrom\s+(.+?)\s+to\s+(.+)$/i.exec(t);
  if (m) return pair(m[1], m[2]);
  m = /^(.+?)\s+to\s+(.+)$/i.exec(t);
  if (m) return pair(m[1].replace(VEHICLE_PREFIX, ""), m[2]);
  m = /\b(?:to|at|around)\s+(.+)$/i.exec(t);
  if (m) return pair(dest, m[1]);
  return null;
  function pair(a: string, b: string) {
    const from = cleanText(a);
    const to = cleanText(b);
    if (!from || !to || normalizeForKey(from) === normalizeForKey(to)) return null;
    return { from, to };
  }
}

const emptyPlan = (): ResearchPlan<ResearchKind> => ({ targets: {}, queries: [], retries: {}, route: {} });

type PlanOpts = { isCached?: (key: PlaceKey) => boolean; max?: number };

export function planQueries(input: ResearchInput, opts?: PlanOpts): ResearchPlan;
export function planQueries(input: MiscResearchInput, opts?: PlanOpts): ResearchPlan<ResearchKind>;
export function planQueries(input: MiscResearchInput, opts?: PlanOpts): ResearchPlan<ResearchKind> {
  try {
    const dest = cleanText(input?.destination);
    if (!dest) return emptyPlan();
    const origin = cleanText(input?.origin);
    const activities = Array.isArray(input?.activities) ? input.activities : [];
    const rawMax = opts?.max;
    const max =
      typeof rawMax === "number" && Number.isFinite(rawMax)
        ? Math.max(0, Math.min(MAX_RESEARCH_QUERIES, Math.floor(rawMax)))
        : MAX_RESEARCH_QUERIES;
    const isCached = (k: PlaceKey): boolean => {
      try {
        return opts?.isCached ? opts.isCached(k) === true : false;
      } catch {
        return false;
      }
    };

    const targets: Record<string, ResearchTarget> = {};
    const entry: PlannedQuery<ResearchKind>[] = [];
    const retries: Record<PlaceKey, string> = {};
    const seen = new Set<PlaceKey>();
    let cab: PlannedQuery<ResearchKind> | null = null;
    let cabTarget: ResearchTarget | null = null;
    const cabIds: string[] = [];
    const meals: PlannedQuery<ResearchKind>[] = [];
    const mealKeys = new Set<PlaceKey>();

    for (const a of activities) {
      if (!a || typeof a.id !== "string") continue;
      const cls = a.costClass;
      if (cls === "paid-sight" || cls === "free-sight") {
        const name = cleanPlaceName(a.title, dest);
        if (!name) continue;
        const key = placeKeyOf("entry-fee", name, dest);
        const q1 = compose((p, c) => `${p} entry fee ${c}`, name, dest);
        if (!q1) continue;
        targets[a.id] = { key, kind: "entry-fee", name };
        if (!seen.has(key)) {
          seen.add(key);
          entry.push({ key, kind: "entry-fee", query: q1, attempt: 1 });
          const q2 = compose((p, c) => `${p} ticket price ${c}`, name, dest);
          if (q2) retries[key] = q2;
        }
      } else if (cls === "local-transfer" && a.costBasis === "group") {
        if (cab === null && cabTarget === null) {
          const r = parseRoute(a.title, dest);
          if (r) {
            const q = compose((f, t) => `cab fare ${f} to ${t}`, r.from, r.to);
            if (q) {
              const name = `${r.from}>${r.to}`;
              const key = placeKeyOf("cab-fare", name, dest);
              cabTarget = { key, kind: "cab-fare", name };
              cab = { key, kind: "cab-fare", query: q, attempt: 1 };
            }
          }
        }
        if (cabTarget) cabIds.push(a.id);
      } else if (cls === "meal") {
        const area = cleanPlaceName(a.title, dest) || dest;
        const name = normalizeForKey(area) === normalizeForKey(dest) ? dest : area;
        const key = placeKeyOf("meal", name, dest);
        if (!mealKeys.has(key)) {
          if (mealKeys.size >= MAX_MEAL_QUERIES) continue;
          const generic = name === dest;
          const q = generic
            ? compose((c) => `average meal cost ${c}`, dest, "")
            : compose((p, c) => `average meal cost ${p} ${c}`, name, dest);
          if (!q) continue;
          mealKeys.add(key);
          meals.push({ key, kind: "meal", query: q, attempt: 1 });
        }
        targets[a.id] = { key, kind: "meal", name };
      }
    }
    if (cabTarget) for (const id of cabIds) targets[id] = cabTarget;

    const route: ResearchPlan["route"] = {};
    const routeQ: PlannedQuery<ResearchKind>[] = [];
    if (input.routeFare === true && origin) {
      for (const variant of ["bus", "train"] as const) {
        const q = compose((f, t) => `${variant} fare ${f} to ${t}`, origin, dest);
        if (!q) continue;
        const key = placeKeyOf("route-fare", `${origin}>${dest}`, dest, variant);
        route[variant] = key;
        routeQ.push({ key, kind: "route-fare", query: q, attempt: 1, variant });
      }
    }

    const miscQ: PlannedQuery<ResearchKind>[] = [];
    const miscKeys = new Set<PlaceKey>();
    for (const m of Array.isArray(input.misc) ? input.misc : []) {
      if (!m || typeof m.id !== "string") continue;
      const label = cleanText(m.label);
      if (!label) continue;
      const hint = cleanText(m.hint);
      const key = placeKeyOf("misc", label, dest);
      const q = compose((p, c) => `${p} ${c}`, [label, hint].filter(Boolean).join(" "), dest);
      if (!q) continue;
      targets[m.id] = { key, kind: "misc", name: label };
      if (!miscKeys.has(key)) {
        miscKeys.add(key);
        miscQ.push({ key, kind: "misc", query: q, attempt: 1 });
      }
    }

    const ordered = [...entry, ...(cab ? [cab] : []), ...routeQ, ...meals, ...miscQ];
    const queries = ordered.filter((q) => !isCached(q.key)).slice(0, max);

    // Keep only targets that have a query or a cached set.
    const live = new Set<PlaceKey>(queries.map((q) => q.key));
    for (const q of ordered) if (isCached(q.key)) live.add(q.key);
    for (const id of Object.keys(targets)) if (!live.has(targets[id].key)) delete targets[id];
    for (const k of Object.keys(retries)) if (!live.has(k)) delete retries[k];
    for (const v of ["bus", "train"] as const) {
      const k = route[v];
      if (k && !live.has(k)) delete route[v];
    }
    return { targets, queries, retries, route };
  } catch {
    return emptyPlan();
  }
}
