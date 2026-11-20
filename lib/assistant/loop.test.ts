import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  FAILED_REPLY,
  MAX_MODEL_CALLS,
  MAX_TOOLS_PER_ROUND,
  PARTIAL_REPLY,
  TOTAL_BUDGET_MS,
  UNAVAILABLE_REPLY,
  runAssistantLoop,
  type LoopDeps,
  type LoopInput,
} from "./loop";
import { NEUTRAL_REPLY } from "./honesty";
import type { ConverseFn, ConverseRequestArgs, ConverseTurn } from "./bedrock-tools";
import type { AssistantContext, EditProposal, SourceLink, WireItinerary } from "./types";

const TOOL_TIMEOUT_MS = 8_000;

const itinerary: WireItinerary = { title: "Trip", totalCost: 0, days: [] };
const context = {
  origin: "Delhi",
  destination: "Goa",
  durationDays: 3,
  travellers: 2,
  budgetLevel: "mid",
  diet: "any",
  pace: "balanced",
  interests: [],
} as unknown as AssistantContext;

function input(message = "hello"): LoopInput {
  return { message, history: [], itinerary, context };
}

function toolTurn(round: number, names: string[]): ConverseTurn {
  const toolUses = names.map((name, i) => ({ toolUseId: `t${round}-${i}`, name, input: {} }));
  return {
    message: {
      role: "assistant",
      content: toolUses.map((u) => ({ toolUse: { toolUseId: u.toolUseId, name: u.name, input: {} } })) as never,
    },
    stopReason: "tool_use",
    toolUses,
    text: "",
  };
}

function textTurn(text: string): ConverseTurn {
  return { message: { role: "assistant", content: [{ text }] }, stopReason: "end_turn", toolUses: [], text };
}

function proposal(id: string): EditProposal {
  return {
    version: 1,
    id,
    summary: "Remove a stop",
    edit: { op: "remove", day: 1, index: 0, expectTitle: "x" },
  };
}

describe("runAssistantLoop", () => {
  // Feature: trip-assistant-chat, Property 11: The tool loop is bounded
  it("Property 11: bounded calls, tools, proposals and time for a model that always requests tools", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(fc.string({ minLength: 0, maxLength: 12 }), { minLength: 1, maxLength: 8 }), {
          minLength: 5,
          maxLength: 5,
        }),
        fc.array(fc.integer({ min: 0, max: 20_000 }), { minLength: 5, maxLength: 5 }),
        fc.array(fc.integer({ min: 0, max: TOOL_TIMEOUT_MS }), { minLength: 8, maxLength: 8 }),
        fc.integer({ min: 0, max: 3 }),
        async (rounds, callMs, toolMs, proposalsPerTool) => {
          let clock = 1_000_000;
          const t0 = clock;
          let roundBase = clock;
          let modelCalls = 0;
          let toolsThisRound = 0;
          const maxToolsInRound: number[] = [];
          const snapshots: ConverseRequestArgs["messages"][] = [];
          let pid = 0;

          const converse: ConverseFn = async (req) => {
            const round = modelCalls;
            modelCalls++;
            snapshots.push(JSON.parse(JSON.stringify(req.messages)));
            clock += Math.min(callMs[round % 5], req.timeoutMs);
            roundBase = clock;
            toolsThisRound = 0;
            maxToolsInRound.push(0);
            return toolTurn(round, rounds[round % 5]);
          };
          const deps: LoopDeps = {
            converse,
            now: () => clock,
            dispatch: async (_name, _in, ctx) => {
              toolsThisRound++;
              maxToolsInRound[maxToolsInRound.length - 1] = toolsThisRound;
              const d = toolMs[(toolsThisRound - 1) % 8];
              clock = Math.max(clock, roundBase + d); // tools of a round run in parallel
              for (let k = 0; k < proposalsPerTool; k++) ctx.proposals.push(proposal(`p${pid++}`));
              return { ok: true };
            },
          };

          const { response, counters } = await runAssistantLoop(deps, input());

          expect(modelCalls).toBeLessThanOrEqual(MAX_MODEL_CALLS);
          expect(counters.modelCalls).toBe(modelCalls);
          for (const n of maxToolsInRound) expect(n).toBeLessThanOrEqual(MAX_TOOLS_PER_ROUND);
          expect(response.reply.trim()).not.toBe("");
          expect(response.proposals.length).toBeLessThanOrEqual(5);
          expect(clock - t0).toBeLessThanOrEqual(TOTAL_BUDGET_MS + TOOL_TIMEOUT_MS);
          // The model never stops asking for tools, so the reply is always a fallback.
          expect(response.status).not.toBe("ok");
          expect([PARTIAL_REPLY, UNAVAILABLE_REPLY, FAILED_REPLY]).toContain(response.reply);

          // Every toolUse in a round has a toolResult in the next message sent.
          for (let i = 1; i < snapshots.length; i++) {
            const msgs = snapshots[i];
            const results = msgs[msgs.length - 1];
            const prev = msgs[msgs.length - 2];
            const useIds = prev.content.map((b) => (b as { toolUse?: { toolUseId: string } }).toolUse?.toolUseId);
            const resIds = results.content.map(
              (b) => (b as { toolResult?: { toolUseId: string } }).toolResult?.toolUseId,
            );
            expect(results.role).toBe("user");
            expect(resIds).toEqual(useIds);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns a fallback when the budget is exhausted by slow calls", async () => {
    let clock = 0;
    let calls = 0;
    const converse: ConverseFn = async (req) => {
      calls++;
      clock += req.timeoutMs;
      return toolTurn(calls, ["a"]);
    };
    const { response } = await runAssistantLoop(
      { converse, now: () => clock, dispatch: async () => ({ ok: true }) },
      input(),
    );
    expect(response.status).toBe("partial");
    expect(response.reply).toBe(PARTIAL_REPLY);
    expect(calls).toBeLessThan(MAX_MODEL_CALLS + 1);
    expect(clock).toBeLessThanOrEqual(TOTAL_BUDGET_MS);
  });

  it("one tool round then final text gives ok", async () => {
    let calls = 0;
    const converse: ConverseFn = async () => (++calls === 1 ? toolTurn(1, ["get_itinerary_summary"]) : textTurn("All set."));
    const { response, counters } = await runAssistantLoop(
      { converse, dispatch: async () => ({ ok: true }) },
      input(),
    );
    expect(response.status).toBe("ok");
    expect(response.reply).toBe("All set.");
    expect(counters.modelCalls).toBe(2);
    expect(counters.toolCalls).toBe(1);
  });

  it("failure on call 1 gives unavailable with no proposals and no invented answer", async () => {
    const converse: ConverseFn = async () => {
      throw new Error("bedrock down");
    };
    const { response } = await runAssistantLoop({ converse }, input());
    expect(response.status).toBe("unavailable");
    expect(response.reply).toBe(UNAVAILABLE_REPLY);
    expect(response.proposals).toEqual([]);
    expect(response.degraded).toContain("bedrock");
  });

  it("failure on call 3 gives partial and keeps earlier proposals", async () => {
    let calls = 0;
    let pid = 0;
    const converse: ConverseFn = async () => {
      calls++;
      if (calls === 3) throw new Error("boom");
      return toolTurn(calls, ["propose_edit"]);
    };
    const { response } = await runAssistantLoop(
      {
        converse,
        dispatch: async (_n, _i, ctx) => {
          ctx.proposals.push(proposal(`p${pid++}`));
          return { ok: true };
        },
      },
      input(),
    );
    expect(response.status).toBe("partial");
    expect(response.reply).toBe(FAILED_REPLY);
    expect(response.proposals.map((p) => p.id)).toEqual(["p0", "p1"]);
  });

  it("replaces a banned phrase in the reply", async () => {
    const converse: ConverseFn = async () => textTurn("Your table is confirmed and guaranteed.");
    const { response } = await runAssistantLoop({ converse }, input());
    expect(response.reply).toBe(NEUTRAL_REPLY);
  });

  it("maps [S#] markers to cited https sources only", async () => {
    let calls = 0;
    const converse: ConverseFn = async () =>
      ++calls === 1 ? toolTurn(1, ["web_search"]) : textTurn("Entry is cheap [S1] and open late [S2] today [S9].");
    const sources: SourceLink[] = [
      { ref: "S1", host: "a.com", url: "https://a.com/x" },
      { ref: "S2", host: "b.com", url: "http://b.com/y" },
      { ref: "S3", host: "c.com", url: "https://c.com/z" },
    ];
    const { response } = await runAssistantLoop(
      {
        converse,
        dispatch: async (_n, _i, ctx) => {
          ctx.sources.push(...sources);
          return { ok: true };
        },
      },
      input(),
    );
    expect(response.status).toBe("ok");
    expect(response.sources.map((s) => s.ref)).toEqual(["S1"]);
    expect(response.reply).toContain("[S1]");
    expect(response.reply).not.toContain("[S2]");
    expect(response.reply).not.toContain("[S9]");
  });
});
