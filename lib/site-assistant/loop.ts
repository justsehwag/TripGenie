/**
 * Site assistant tool loop (SERVER-ONLY).
 *
 * `runSiteLoop(deps, input)` drives the Bedrock Converse tool-use loop: at
 * most 3 model calls, a 10 s cap per call and a 20 s total budget. The
 * converse function and the clock are injected so tests run with fakes.
 *
 * Every tool call goes through `validateAction`. A name outside the page's
 * allow-list, or a call that fails validation, returns a tool error result to
 * the model and creates no proposal. The reply and proposal summaries pass the
 * honesty screen. Nothing is logged here; the output carries counters only.
 *
 * Requirements: 6.1, 6.2, 6.5, 7.5, 13.4, 13.5
 */
import {
  buildToolResultMessage,
  type ConverseFn,
  type ConverseMessage,
  type ConverseToolUse,
  type ConverseTurn,
} from "@/lib/assistant/bedrock-tools";
import { NEUTRAL_SUMMARY, screenReply, screenSummary } from "@/lib/assistant/honesty";
import type { ChatTurn } from "@/lib/assistant/types";
import { MAX_HISTORY_TURNS, trimHistory } from "@/lib/assistant/wire";
import { buildSitePrompt } from "./prompt";
import { TOOL_ALLOW_LISTS, toolSpecsFor, validateAction } from "./tools";
import type { ActionProposal, PageId, SiteAssistantResponse, WireContext } from "./types";

/* ------------------------------ limits ------------------------------ */
export const MAX_MODEL_CALLS = 3;
export const PER_CALL_MAX_MS = 10_000;
export const TOTAL_BUDGET_MS = 20_000;
export const MAX_OUTPUT_TOKENS = 1024;
export const MAX_PROPOSALS = 5;
export const MAX_TOOLS_PER_ROUND = 4;
/** Stop starting a model call with less than this left. */
const MIN_CALL_BUDGET_MS = 1_000;
/** Kept back from the per-call timeout so the loop can still answer. */
const CALL_RESERVE_MS = 300;
const MAX_SUMMARY_CHARS = 200;

export const UNAVAILABLE_REPLY = "The assistant is temporarily unavailable. Please try again in a moment.";
export const PARTIAL_REPLY = "I ran out of time before I could finish. Here is what I have so far.";
export const FAILED_REPLY = "I could not complete that answer. Here is what I have so far.";
export const TOO_MANY_TOOLS_ERROR = "too many tool calls in one step";

/* ------------------------------- shapes ----------------------------- */
export interface SiteLoopDeps {
  converse: ConverseFn;
  /** Clock in ms; defaults to `Date.now`. */
  now?: () => number;
}

export interface SiteLoopInput {
  message: string;
  page: PageId;
  history: readonly ChatTurn[];
  context: WireContext;
  signal?: AbortSignal;
}

export interface SiteLoopOutput extends SiteAssistantResponse {
  /** Model calls made. */
  calls: number;
  /** Tool calls handled (including rejected ones). */
  tools: number;
}

/* ------------------------------ helpers ----------------------------- */
function toMessages(history: readonly ChatTurn[], userContent: string): ConverseMessage[] {
  const out: ConverseMessage[] = [];
  for (const turn of trimHistory(history, MAX_HISTORY_TURNS)) {
    if (!turn || (turn.role !== "user" && turn.role !== "assistant")) continue;
    const t = typeof turn.text === "string" ? turn.text : "";
    if (t.trim() === "") continue;
    const last = out[out.length - 1];
    if (last && last.role === turn.role && last.content.length === 1 && typeof last.content[0].text === "string") {
      last.content = [{ text: `${last.content[0].text}\n${t}` }];
    } else if (out.length === 0 && turn.role === "assistant") {
      // Converse requires the first message to be from the user.
    } else {
      out.push({ role: turn.role, content: [{ text: t }] });
    }
  }
  const last = out[out.length - 1];
  if (last && last.role === "user") {
    // Two user messages in a row are not allowed: fold into one.
    last.content = [...last.content, { text: userContent }];
  } else {
    out.push({ role: "user", content: [{ text: userContent }] });
  }
  return out;
}

function safeProposal(p: ActionProposal): ActionProposal {
  const s = screenSummary(p.summary, NEUTRAL_SUMMARY).text.slice(0, MAX_SUMMARY_CHARS);
  return s === p.summary ? p : { ...p, summary: s };
}

/* -------------------------------- loop ------------------------------ */
export async function runSiteLoop(deps: SiteLoopDeps, input: SiteLoopInput): Promise<SiteLoopOutput> {
  const now = deps.now ?? Date.now;
  const start = now();
  const deadline = start + TOTAL_BUDGET_MS;
  const left = () => deadline - now();

  const page: PageId = Object.prototype.hasOwnProperty.call(TOOL_ALLOW_LISTS, input.page) ? input.page : "general";
  const prompt = buildSitePrompt(page, input.message, input.context);
  const tools = toolSpecsFor(page);
  const messages = toMessages(input.history, prompt.user);
  const proposals: ActionProposal[] = [];

  let calls = 0;
  let toolCount = 0;

  const finish = (status: SiteAssistantResponse["status"], text: string): SiteLoopOutput => {
    const screened = screenReply(text).text.trim();
    const reply = screened !== "" ? screened : status === "unavailable" ? UNAVAILABLE_REPLY : PARTIAL_REPLY;
    return {
      reply,
      proposals: status === "unavailable" ? [] : proposals.slice(0, MAX_PROPOSALS).map(safeProposal),
      status,
      calls,
      tools: toolCount,
    };
  };

  const fail = (): SiteLoopOutput =>
    calls <= 1 ? finish("unavailable", UNAVAILABLE_REPLY) : finish("partial", FAILED_REPLY);

  for (let call = 1; call <= MAX_MODEL_CALLS; call++) {
    if (left() < MIN_CALL_BUDGET_MS || input.signal?.aborted) {
      return call === 1 ? finish("unavailable", UNAVAILABLE_REPLY) : finish("partial", PARTIAL_REPLY);
    }
    const timeoutMs = Math.max(1, Math.min(PER_CALL_MAX_MS, left() - CALL_RESERVE_MS));

    let turn: ConverseTurn;
    calls = call;
    try {
      turn = await deps.converse({
        system: prompt.system,
        messages,
        tools,
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
    const results: Array<{ toolUseId: string; result: unknown }> = uses.map((use, i) => {
      if (i >= MAX_TOOLS_PER_ROUND) {
        return { toolUseId: use.toolUseId, result: { ok: false, error: TOO_MANY_TOOLS_ERROR } };
      }
      toolCount++;
      const v = validateAction(page, use.name, use.input);
      if (!v.ok) return { toolUseId: use.toolUseId, result: { ok: false, error: v.error } };
      if (proposals.length >= MAX_PROPOSALS) {
        return { toolUseId: use.toolUseId, result: { ok: false, error: "too many proposals" } };
      }
      proposals.push(v.proposal);
      return {
        toolUseId: use.toolUseId,
        result: { ok: true, proposed: v.proposal.summary, note: "Proposed only. The traveller must apply it." },
      };
    });
    messages.push(buildToolResultMessage(results));
  }

  return finish("partial", PARTIAL_REPLY);
}
