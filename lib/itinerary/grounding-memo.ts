/**
 * Grounding memo: runs web grounding (SearXNG) at most once per trip.
 *
 * Server-only: imports lib/grounding/service.ts, which reads the environment
 * and uses the network. Never import this from client code.
 *
 * The first batch of a trip grounds and memoises the bundle. Later batches
 * return the memo, or an empty bundle when there is none (for example another
 * server instance), and never start a new search. Never throws.
 *
 * Requirements: 5.6, 16.4.
 */
import { groundingCacheKey } from "@/lib/grounding/cache";
import { groundItinerary } from "@/lib/grounding/service";
import {
  EMPTY_BUNDLE,
  groundingInputFromContext,
  type GroundingBundle,
} from "@/lib/grounding/types";
import type { TripContext } from "@/lib/types";
import { GROUNDING_MEMO_MAX, GROUNDING_MEMO_TTL_MS } from "@/lib/itinerary/constants";

export interface GroundOnceDeps {
  ground?: (ctx: TripContext) => Promise<GroundingBundle>;
  /** Clock in ms; default Date.now. */
  now?: () => number;
}

interface MemoEntry {
  bundle: GroundingBundle;
  expiresAt: number;
}

/** Insertion-ordered, so the first key is the oldest. */
const memo = new Map<string, MemoEntry>();

function clock(deps?: GroundOnceDeps): number {
  try {
    const n = (deps?.now ?? Date.now)();
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function keyFor(ctx: TripContext): string {
  const input = groundingInputFromContext(ctx);
  return groundingCacheKey(input.destination ?? "", input.vibe ?? "");
}

function read(key: string, nowMs: number): GroundingBundle | null {
  const entry = memo.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= nowMs) {
    memo.delete(key);
    return null;
  }
  return entry.bundle;
}

function write(key: string, bundle: GroundingBundle, nowMs: number): void {
  memo.delete(key);
  memo.set(key, { bundle, expiresAt: nowMs + GROUNDING_MEMO_TTL_MS });
  while (memo.size > GROUNDING_MEMO_MAX) {
    const oldest = memo.keys().next();
    if (oldest.done) break;
    memo.delete(oldest.value);
  }
}

export async function groundOnce(
  ctx: TripContext,
  isFirstBatch: boolean,
  deps?: GroundOnceDeps,
): Promise<GroundingBundle> {
  try {
    const key = keyFor(ctx);
    const nowMs = clock(deps);
    if (!isFirstBatch) {
      return read(key, nowMs) ?? EMPTY_BUNDLE("empty");
    }
    const ground =
      deps?.ground ?? ((c: TripContext) => groundItinerary(groundingInputFromContext(c)));
    const bundle = await ground(ctx);
    write(key, bundle, clock(deps));
    return bundle;
  } catch {
    return EMPTY_BUNDLE("unavailable");
  }
}

/** Test helper: empties the memo. */
export function clearGroundingMemo(): void {
  memo.clear();
}
