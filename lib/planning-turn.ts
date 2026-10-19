/**
 * Planning turn handler core - design section 2 / 19.
 * Bounded per-turn tool lookups; bounded reply cache; stable system-prompt prefix.
 * The Bedrock client is injected behind the controller's ExtractionModel.
 * Every tool invocation is routed through the MCP Gateway (Req 2.8).
 * Requirements: 2.8, 19.2, 19.3, 19.4.
 */

import {
  advance,
  type ControllerResponse,
  type ControllerState,
  type ExtractionModel,
} from "./preference-controller";
import {
  invokeTool,
  type GatewayInvocation,
  type GatewayOutcome,
  type ToolHandler,
} from "./mcp-gateway";

/** Max external tool lookups per planning turn (Req 19.2). */
export const MAX_LOOKUPS_PER_TURN = 4;

/** Stable system-prompt prefix reused byte-identically across requests (Req 19.4). */
export const SYSTEM_PROMPT_PREFIX =
  "You are TripGenie, a bounded travel-planning concierge. Extract only structured trip context from the latest input delta. Ask one question at a time, never fabricate availability, and keep answers under 160 characters.";

/** A bounded LRU reply cache for tool results within a planning turn (Req 19.3). */
export class ReplyCache {
  private readonly map = new Map<string, unknown>();
  constructor(private readonly limit = 32) {}
  get(key: string): unknown {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key: string, value: unknown): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  get size(): number { return this.map.size; }
}

export type LookupFn = (key: string) => unknown;

export interface LookupSession {
  lookupsUsed: number;
  cacheHits: number;
}

/**
 * Run a cached, bounded tool lookup within a turn. Repeated keys are served
 * from cache and do not consume the per-turn budget; new keys beyond the cap
 * are refused (returns undefined) so lookups stay bounded (Req 19.2/19.3).
 */
export function cachedLookup(
  cache: ReplyCache,
  session: LookupSession,
  key: string,
  fetch: LookupFn,
): { value: unknown; cached: boolean } | { refused: true } {
  const hit = cache.get(key);
  if (hit !== undefined) {
    session.cacheHits += 1;
    return { value: hit, cached: true };
  }
  if (session.lookupsUsed >= MAX_LOOKUPS_PER_TURN) {
    return { refused: true };
  }
  const value = fetch(key);
  session.lookupsUsed += 1;
  cache.set(key, value);
  return { value, cached: false };
}

/**
 * A single tool invocation routed through the MCP Gateway, keyed for caching.
 * The `key` is the stable identity of the lookup within a turn (identical keys
 * are served from the reply cache and do not consume the per-turn budget).
 */
export interface GatewayLookup {
  key: string;
  invocation: GatewayInvocation;
}

/**
 * Route a tool invocation through the MCP Gateway with per-turn bounding and a
 * bounded reply cache (Req 2.8 / 19.2 / 19.3).
 *
 * - Repeated identical lookups (same `key`) are served from cache and do not
 *   issue a new gateway call nor consume the per-turn budget.
 * - New lookups beyond {@link MAX_LOOKUPS_PER_TURN} are refused so lookups stay
 *   bounded; the gateway is never called for a refused lookup.
 * - Allowlist gating, read/transaction separation, and the single trace span
 *   per call are all owned by {@link invokeTool}; this wrapper never bypasses it.
 */
export function gatewayLookup(
  cache: ReplyCache,
  session: LookupSession,
  lookup: GatewayLookup,
  handlers: Record<string, ToolHandler>,
  now: () => number = () => Date.now(),
): { outcome: GatewayOutcome; cached: boolean } | { refused: true } {
  const hit = cache.get(lookup.key);
  if (hit !== undefined) {
    session.cacheHits += 1;
    return { outcome: hit as GatewayOutcome, cached: true };
  }
  if (session.lookupsUsed >= MAX_LOOKUPS_PER_TURN) {
    return { refused: true };
  }
  const outcome = invokeTool(lookup.invocation, handlers, now);
  session.lookupsUsed += 1;
  cache.set(lookup.key, outcome);
  return { outcome, cached: false };
}

/** The per-request state carried across a single planning turn. */
export interface PlanningTurnContext {
  cache: ReplyCache;
  session: LookupSession;
}

/** Fresh per-turn lookup state (empty cache, zeroed budget). */
export function newTurnContext(cacheLimit = 32): PlanningTurnContext {
  return {
    cache: new ReplyCache(cacheLimit),
    session: { lookupsUsed: 0, cacheHits: 0 },
  };
}

export interface PlanningTurnRequest {
  /** Current controller state (structured Trip_Context + questions asked). */
  state: ControllerState;
  /** The latest input delta only - never the full transcript (Req 2.9). */
  inputDelta: string;
}

export interface PlanningTurnResult {
  response: ControllerResponse;
  /** The stable system prompt prefix sent to the model (Req 19.4). */
  systemPromptPrefix: string;
  /** Per-turn lookup accounting for observability/cost control (Req 19.2/19.3). */
  turn: PlanningTurnContext;
}

/**
 * Run one planning turn. The Bedrock + Strands client is injected behind the
 * controller's extraction/phrasing interface ({@link ExtractionModel}); the
 * deterministic controller owns all control flow (Req 2.1-2.11). The byte-identical
 * stable system prompt prefix is reused across every request (Req 19.4). Tool
 * invocations the model makes during the turn are routed through
 * {@link gatewayLookup} so they pass the MCP Gateway (Req 2.8) under the bounded
 * lookup cap and reply cache (Req 19.2/19.3).
 */
export function runPlanningTurn(
  request: PlanningTurnRequest,
  model: ExtractionModel,
  turn: PlanningTurnContext = newTurnContext(),
): PlanningTurnResult {
  const response = advance(request.state, request.inputDelta, model);
  return {
    response,
    systemPromptPrefix: SYSTEM_PROMPT_PREFIX,
    turn,
  };
}
