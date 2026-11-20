/**
 * Trip Assistant tool loop (SERVER-ONLY).
 *
 * `runAssistantLoop(deps, input)` drives the Bedrock Converse tool-use loop:
 * at most 5 model calls, at most 4 tools per round, a 25 s total budget and a
 * 12 s cap per call (never more than the time left). Providers and the clock
 * are injected, so tests run it with fakes.
 *
 * Failure handling: call 1 failing gives `unavailable`; any later failure, a
 * spent budget or the call cap gives `partial` and keeps the proposals already
 * accepted. The reply and proposal summaries pass the honesty screen. Only
 * cited `[S#]` markers become source links (https only).
 *
 * Nothing is logged here. The output carries counters (calls, tools, ms,
 * status) and never content, so the route can log without leaking
 * (Requirement 13.5).
 *
 * Requirements: 4.2, 4.3, 4.4, 4.7, 4.8, 4.10, 6.7, 7.10, 12.2, 13.5
 */
import type { Activity, Itinerary, TripDay } from "@/lib/types";
import {
  buildToolResultMessage,
  type ConverseFn,
  type ConverseMessage,
  type ConverseToolUse,
  type ConverseTurn,
} from "./bedrock-tools";
import { NEUTRAL_SUMMARY, screenReply, screenSummary } from "./honesty";
import { buildSystemPrompt } from "./prompt";
import {
  TOOL_SPECS,
  buildAllowList,
  dispatchTool,
  type ToolContext,
  type ToolDeps,
  type ToolResult,
} from "./tools";
import type {
  AssistantContext,
  AssistantResponse,
  ChatTurn,
  EditProposal,
  OfferedPlace,
  ProfileSubset,
  SourceLink,
  WireItinerary,
} from "./types";
import { MAX_HISTORY_TURNS as WIRE_MAX_HISTORY, MAX_OFFERED, MAX_PROPOSALS, MAX_SUMMARY_CHARS, trimHistory } from "./wire";

/* ------------------------------ limits ------------------------------ */
export const MAX_MODEL_CALLS = 5;
export const MAX_TOOLS_PER_ROUND = 4;
export const TOTAL_BUDGET_MS = 25_000;
export const PER_CALL_MAX_MS = 12_000;
export const MAX_OUTPUT_TOKENS = 1024;
export const MAX_HISTORY_TURNS = WIRE_MAX_HISTORY;
/** Stop starting a model call with less than this left. */
const MIN_CALL_BUDGET_MS = 1_500;
/** Kept back from the per-call timeout so the loop can still answer. */
const CALL_RESERVE_MS = 500;

export const UNAVAILABLE_REPLY = "The assistant is temporarily unavailable. Please try again in a moment.";
export const PARTIAL_REPLY = "I ran out of time before I could finish. Here is what I have so far.";
export const FAILED_REPLY = "I could not complete that answer. Here is what I have so far.";
export const TOO_MANY_TOOLS_ERROR = "too many tool calls in one step";

/* ------------------------------- shapes ----------------------------- */
export interface LoopDeps {
  converse: ConverseFn;
  /** Tool dispatcher; defaults to `dispatchTool`. */
  dispatch?: (name: string, input: unknown, ctx: ToolContext) => Promise<ToolResult>;
  /** Clock in ms; defaults to `Date.now`. */
  now?: () => number;
  /** Provider fakes handed to the tools (`ToolContext.deps`). */
  toolDeps?: ToolDeps;
}

export interface LoopInput {
  message: string;
  history: readonly ChatTurn[];
  /** Wire projection from the request (parseRequest output). */
  itinerary: WireItinerary;
  context: AssistantContext;
  profile?: ProfileSubset;
  offered?: readonly OfferedPlace[];
  signal?: AbortSignal;
}

/** Counters only. Never content. */
export interface LoopCounters {
  modelCalls: number;
  toolCalls: number;
  ms: number;
  status: AssistantResponse["status"];
}

export interface LoopOutput {
  response: AssistantResponse;
  counters: LoopCounters;
}

/* ------------------------- wire -> Itinerary ------------------------ */
/**
 * Rebuilds the Itinerary that proposals are validated against from the
 * request's wire projection. Wire fields are a subset of Itinerary fields,
 * so this copies them one to one. Never throws; copies the arrays.
 */
export function fromWireItinerary(wire: WireItinerary): Itinerary {
  const days: TripDay[] = (Array.isArray(wire?.days) ? wire.days : []).map((d) => ({
    ...d,
    activities: (Array.isArray(d.activities) ? d.activities : []).map((a) => ({
      ...a,
      ...(a.location ? { location: { ...a.location } } : {}),
    })) as Activity[],
  }));
  return { title: wire?.title ?? "", totalCost: wire?.totalCost ?? 0, days };
}

/* ------------------------------ helpers ----------------------------- */
function toMessages(history: readonly ChatTurn[], message: string): ConverseMessage[] {
  const out: ConverseMessage[] = [];
  const push = (role: "user" | "assistant", text: string) => {
    const t = typeof text === "string" ? text : "";
    if (t.trim() === "") return;
    const last = out[out.length - 1];
    if (last && last.role === role && last.content.length === 1 && typeof last.content[0].text === "string") {
      last.content = [{ text: `${last.content[0].text}\n${t}` }];
    } else if (out.length === 0 && role === "assistant") {
      // Converse requires the first message to be from the user.
    } else {
      out.push({ role, content: [{ text: t }] });
    }
  };
  for (const turn of trimHistory(history, MAX_HISTORY_TURNS)) {
    if (turn && (turn.role === "user" || turn.role === "assistant")) push(turn.role, turn.text);
  }
  push("user", message);
  return out;
}

const MARKER_RE = /\[S(\d{1,3})\]/g;

/** Keeps the cited sources (https only) in citation order; strips markers with no source. */
function mapSources(reply: string, sources: readonly SourceLink[]): { reply: string; sources: SourceLink[] } {
  const byRef = new Map<string, SourceLink>();
  for (const s of sources) {
    if (typeof s.url === "string" && s.url.startsWith("https://") && !byRef.has(s.ref)) byRef.set(s.ref, s);
  }
  const cited: SourceLink[] = [];
  const text = reply
    .replace(MARKER_RE, (m, n: string) => {
      const link = byRef.get(`S${n}`);
      if (!link) return "";
      if (!cited.includes(link)) cited.push(link);
      return m;
    })
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([.,;:!?])/g, "$1")
    .trim();
  return { reply: text, sources: cited };
}

function safeProposals(list: readonly EditProposal[]): EditProposal[] {
  return list.slice(0, MAX_PROPOSALS).map((p) => {
    const s = screenSummary(p.summary, NEUTRAL_SUMMARY).text.slice(0, MAX_SUMMARY_CHARS);
    return s === p.summary ? p : { ...p, summary: s };
  });
}

/* -------------------------------- loop ------------------------------ */
export async function runAssistantLoop(deps: LoopDeps, input: LoopInput): Promise<LoopOutput> {
  const now = deps.now ?? Date.now;
  const dispatch = deps.dispatch ?? dispatchTool;
  const start = now();
  const deadline = start + TOTAL_BUDGET_MS;
  const left = () => deadline - now();

  const offeredSeed = [...(input.offered ?? [])].slice(-MAX_OFFERED);
  const ctx: ToolContext = {
    itinerary: fromWireItinerary(input.itinerary),
    wire: input.itinerary,
    profile: input.profile,
    context: input.context,
    allowList: buildAllowList(input.itinerary, offeredSeed),
    proposals: [],
    offered: [...offeredSeed],
    sources: [],
    degraded: new Set(),
    remainingMs: left,
    signal: input.signal,
    deps: deps.toolDeps,
  };

  const system = buildSystemPrompt({
    context: input.context,
    profile: input.profile,
    offered: offeredSeed,
    itinerary: input.itinerary,
  });
  const messages = toMessages(input.history, input.message);

  let modelCalls = 0;
  let toolCalls = 0;

  const finish = (
    status: AssistantResponse["status"],
    replyText: string,
    extraDegraded: Array<"bedrock"> = [],
  ): LoopOutput => {
    const screened = screenReply(replyText).text;
    const mapped = mapSources(screened, ctx.sources);
    const reply = mapped.reply !== "" ? mapped.reply : status === "ok" ? PARTIAL_REPLY : replyText || PARTIAL_REPLY;
    const degraded = [...extraDegraded, ...ctx.degraded] as AssistantResponse["degraded"];
    const response: AssistantResponse = {
      reply,
      proposals: status === "unavailable" ? [] : safeProposals(ctx.proposals),
      sources: mapped.reply !== "" ? mapped.sources : [],
      offered: ctx.offered.slice(-MAX_OFFERED),
      status,
      degraded: [...new Set(degraded)],
    };
    return { response, counters: { modelCalls, toolCalls, ms: Math.max(0, now() - start), status } };
  };

  const fail = (): LoopOutput =>
    modelCalls <= 1
      ? finish("unavailable", UNAVAILABLE_REPLY, ["bedrock"])
      : finish("partial", FAILED_REPLY, ["bedrock"]);

  for (let call = 1; call <= MAX_MODEL_CALLS; call++) {
    if (left() < MIN_CALL_BUDGET_MS || input.signal?.aborted) {
      return call === 1 ? finish("unavailable", UNAVAILABLE_REPLY, ["bedrock"]) : finish("partial", PARTIAL_REPLY);
    }
    const timeoutMs = Math.max(1, Math.min(PER_CALL_MAX_MS, left() - CALL_RESERVE_MS));

    let turn: ConverseTurn;
    modelCalls = call;
    try {
      turn = await deps.converse({
        system,
        messages,
        tools: TOOL_SPECS,
        maxTokens: MAX_OUTPUT_TOKENS,
        timeoutMs,
        signal: input.signal,
      });
    } catch {
      return fail();
    }

    const uses: ConverseToolUse[] = Array.isArray(turn?.toolUses) ? turn.toolUses : [];
    if (turn?.stopReason !== "tool_use" || uses.length === 0) {
      const text = typeof turn?.text === "string" ? turn.text.trim() : "";
      if (text === "") return finish("partial", FAILED_REPLY);
      return finish("ok", text);
    }

    // The model wants tools but the call cap is spent: answer without another call.
    if (call === MAX_MODEL_CALLS) return finish("partial", PARTIAL_REPLY);

    messages.push({ role: "assistant", content: turn.message.content });
    const results = await Promise.all(
      uses.map(async (use, i): Promise<{ toolUseId: string; result: unknown }> => {
        if (i >= MAX_TOOLS_PER_ROUND) {
          return { toolUseId: use.toolUseId, result: { ok: false, error: TOO_MANY_TOOLS_ERROR } };
        }
        toolCalls++;
        try {
          return { toolUseId: use.toolUseId, result: await dispatch(use.name, use.input, ctx) };
        } catch {
          return { toolUseId: use.toolUseId, result: { ok: false, error: "tool failed" } };
        }
      }),
    );
    messages.push(buildToolResultMessage(results));
  }

  return finish("partial", PARTIAL_REPLY);
}
