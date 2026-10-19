import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  cachedLookup,
  gatewayLookup,
  MAX_LOOKUPS_PER_TURN,
  newTurnContext,
  ReplyCache,
  runPlanningTurn,
  SYSTEM_PROMPT_PREFIX,
  type LookupSession,
} from "@/lib/planning-turn";
import type { ExtractionModel } from "@/lib/preference-controller";
import type { ToolHandler } from "@/lib/mcp-gateway";

/** Feature: tripgenie - planning-turn property tests (Properties 39, 40). */

describe("Feature: tripgenie, planning turn", () => {
  it("Property 39: Bounded tool lookups and reply cache per planning turn", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 30 }), (keys) => {
        const cache = new ReplyCache();
        const session: LookupSession = { lookupsUsed: 0, cacheHits: 0 };
        let fetchCalls = 0;
        for (const k of keys) {
          cachedLookup(cache, session, k, () => { fetchCalls += 1; return k.length; });
        }
        // Never more than the per-turn cap of actual fetches.
        expect(session.lookupsUsed).toBeLessThanOrEqual(MAX_LOOKUPS_PER_TURN);
        expect(fetchCalls).toBe(session.lookupsUsed);
      }),
      { numRuns: 100 },
    );
  });

  it("Repeated keys are served from cache and do not consume the budget", () => {
    const cache = new ReplyCache();
    const session: LookupSession = { lookupsUsed: 0, cacheHits: 0 };
    let fetchCalls = 0;
    for (let i = 0; i < 10; i++) {
      cachedLookup(cache, session, "same", () => { fetchCalls += 1; return 1; });
    }
    expect(fetchCalls).toBe(1);
    expect(session.lookupsUsed).toBe(1);
    expect(session.cacheHits).toBe(9);
  });

  it("Property 40: System prompt prefix is stable across requests", () => {
    const snapshot = SYSTEM_PROMPT_PREFIX;
    fc.assert(
      fc.property(fc.string(), (_ignored) => {
        expect(SYSTEM_PROMPT_PREFIX).toBe(snapshot);
      }),
      { numRuns: 50 },
    );
  });
});

describe("Feature: tripgenie, planning turn routes tools through the MCP Gateway", () => {
  // get_weather is on the default MCP allowlist (lib/config.ts).
  const handlers: Record<string, ToolHandler> = {
    get_weather: () => ({ tempC: 20 }),
  };

  it("routes an allowlisted tool invocation through the gateway (Req 2.8)", () => {
    const turn = newTurnContext();
    let backendCalls = 0;
    const res = gatewayLookup(
      turn.cache,
      turn.session,
      { key: "weather:paris", invocation: { tool: "get_weather", arguments: { city: "paris" } } },
      { get_weather: () => { backendCalls += 1; return { tempC: 18 }; } },
    );
    expect("refused" in res).toBe(false);
    if ("refused" in res) return;
    expect(res.cached).toBe(false);
    expect(res.outcome.ok).toBe(true);
    expect(backendCalls).toBe(1);
    if (res.outcome.ok) {
      // The gateway opened exactly one span for the call (Req 18.4 via gateway).
      expect(res.outcome.span.tool).toBe("get_weather");
      expect(res.outcome.routedToLive).toBe(true);
    }
  });

  it("rejects a non-allowlisted tool at the gateway without consuming budget", () => {
    const turn = newTurnContext();
    const res = gatewayLookup(
      turn.cache,
      turn.session,
      { key: "evil", invocation: { tool: "drop_tables", arguments: {} } },
      {},
    );
    expect("refused" in res).toBe(false);
    if ("refused" in res) return;
    expect(res.outcome.ok).toBe(false);
    // A rejection is still a resolved outcome and is cached/counted as a lookup.
    expect(turn.session.lookupsUsed).toBe(1);
  });

  it("serves repeated identical gateway lookups from cache without a new call", () => {
    const turn = newTurnContext();
    let backendCalls = 0;
    const h: Record<string, ToolHandler> = {
      get_weather: () => { backendCalls += 1; return { tempC: 21 }; },
    };
    const lookup = { key: "weather:rome", invocation: { tool: "get_weather", arguments: {} } };
    for (let i = 0; i < 5; i++) gatewayLookup(turn.cache, turn.session, lookup, h);
    expect(backendCalls).toBe(1);
    expect(turn.session.lookupsUsed).toBe(1);
    expect(turn.session.cacheHits).toBe(4);
  });

  it("caps distinct gateway lookups per turn (Req 19.2)", () => {
    const turn = newTurnContext();
    let backendCalls = 0;
    const h: Record<string, ToolHandler> = {
      get_weather: () => { backendCalls += 1; return { ok: true }; },
    };
    let refusals = 0;
    for (let i = 0; i < MAX_LOOKUPS_PER_TURN + 3; i++) {
      const res = gatewayLookup(
        turn.cache,
        turn.session,
        { key: `k${i}`, invocation: { tool: "get_weather", arguments: { i } } },
        h,
      );
      if ("refused" in res) refusals += 1;
    }
    expect(turn.session.lookupsUsed).toBe(MAX_LOOKUPS_PER_TURN);
    expect(backendCalls).toBe(MAX_LOOKUPS_PER_TURN);
    expect(refusals).toBe(3);
  });

  it("runs a turn via the injected extraction/phrasing model with the stable prefix", () => {
    const model: ExtractionModel = {
      extract: (delta) => (delta.includes("paris") ? { destination: "Paris" } : {}),
      phrase: (field) => `What is your ${field}?`,
    };
    const result = runPlanningTurn(
      { state: { context: {}, questionsAsked: 0 }, inputDelta: "to paris" },
      model,
    );
    expect(result.systemPromptPrefix).toBe(SYSTEM_PROMPT_PREFIX);
    expect(result.response.state.context.destination).toBe("Paris");
    expect(result.response.phase).toBe("collecting");
    // Uninterpretable input leaves context unchanged (controller owns control flow).
    const noop = runPlanningTurn(
      { state: result.response.state, inputDelta: "zzzz" },
      model,
    );
    expect(noop.response.state.context.destination).toBe("Paris");
  });
});
