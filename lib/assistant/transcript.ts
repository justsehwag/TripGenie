/**
 * Pure transcript reducer for the assistant panel. Client-safe, immutable.
 */
import { MAX_OFFERED } from "./wire";
import type { AssistantResponse, EditProposal, OfferedPlace, SourceLink } from "./types";

export type ProposalStatus = "pending" | "applied" | "dismissed" | "stale";

export interface TranscriptProposal {
  proposal: EditProposal;
  status: ProposalStatus;
}

export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  sources?: SourceLink[];
  proposals?: TranscriptProposal[];
  /** Response status for assistant messages. */
  status?: AssistantResponse["status"];
}

export interface TranscriptError {
  message: string;
  retryAfterSec?: number;
}

export interface TranscriptState {
  messages: TranscriptMessage[];
  pending: boolean;
  error: TranscriptError | null;
  /** Last user text, used by retry. */
  lastUserText: string | null;
  offered: OfferedPlace[];
}

export type TranscriptAction =
  | { type: "send"; id: string; text: string }
  | { type: "receive"; id: string; response: AssistantResponse }
  | { type: "fail"; message: string; retryAfterSec?: number }
  | { type: "retry" }
  | { type: "proposal"; messageId: string; proposalId: string; status: ProposalStatus }
  | { type: "note"; id: string; text: string }
  | { type: "reset" };

export function initialTranscript(): TranscriptState {
  return { messages: [], pending: false, error: null, lastUserText: null, offered: [] };
}

/** Merges offered places: dedupe by placeId (newest wins position), keep the latest MAX_OFFERED. */
export function mergeOffered(
  existing: readonly OfferedPlace[],
  incoming: readonly OfferedPlace[],
): OfferedPlace[] {
  const map = new Map<string, OfferedPlace>();
  for (const p of [...existing, ...incoming]) {
    if (!p || typeof p.placeId !== "string" || !p.placeId) continue;
    map.delete(p.placeId);
    map.set(p.placeId, { placeId: p.placeId, name: p.name });
  }
  const all = [...map.values()];
  return all.length > MAX_OFFERED ? all.slice(all.length - MAX_OFFERED) : all;
}

export function transcriptReducer(state: TranscriptState, action: TranscriptAction): TranscriptState {
  switch (action.type) {
    case "send": {
      if (state.pending) return state;
      return {
        ...state,
        messages: [...state.messages, { id: action.id, role: "user", text: action.text }],
        pending: true,
        error: null,
        lastUserText: action.text,
      };
    }
    case "receive": {
      const r = action.response;
      const msg: TranscriptMessage = {
        id: action.id,
        role: "assistant",
        text: r.reply,
        status: r.status,
        ...(r.sources.length ? { sources: r.sources } : {}),
        ...(r.proposals.length
          ? { proposals: r.proposals.map((proposal) => ({ proposal, status: "pending" as const })) }
          : {}),
      };
      return {
        ...state,
        messages: [...state.messages, msg],
        pending: false,
        error: null,
        offered: mergeOffered(state.offered, r.offered),
      };
    }
    case "fail":
      return {
        ...state,
        pending: false,
        error: {
          message: action.message,
          ...(action.retryAfterSec !== undefined ? { retryAfterSec: action.retryAfterSec } : {}),
        },
      };
    case "retry":
      // The user message is already in the transcript; re-send is done by the caller using lastUserText.
      if (state.pending || !state.error || state.lastUserText === null) return state;
      return { ...state, pending: true, error: null };
    case "proposal": {
      let changed = false;
      const messages = state.messages.map((m) => {
        if (m.id !== action.messageId || !m.proposals) return m;
        const proposals = m.proposals.map((p) => {
          if (p.proposal.id !== action.proposalId || p.status === action.status) return p;
          // An applied proposal never goes back to another state through this action.
          if (p.status === "applied") return p;
          changed = true;
          return { ...p, status: action.status };
        });
        return changed ? { ...m, proposals } : m;
      });
      return changed ? { ...state, messages } : state;
    }
    case "note":
      return { ...state, messages: [...state.messages, { id: action.id, role: "assistant", text: action.text }] };
    case "reset":
      return initialTranscript();
    default:
      return state;
  }
}
