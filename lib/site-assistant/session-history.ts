/**
 * Site assistant session history (site-wide-assistant, task 6.2).
 *
 * Conversation is kept in `sessionStorage` for the current tab under a key
 * that starts with `tripgenie.assistant.`. When storage is unavailable or
 * throws, an in-memory array is used instead. Every access is guarded and
 * never throws.
 */

import type { ChatTurn } from "../assistant/types";

export const HISTORY_KEY_PREFIX = "tripgenie.assistant.";
export const HISTORY_KEY = `${HISTORY_KEY_PREFIX}history.v1`;
export const MAX_MESSAGES = 50;
export const MAX_MESSAGE_CHARS = 4000;
/** Maximum turns sent with each request. */
export const MAX_WIRE_TURNS = 10;
/** The route rejects user turns longer than this. */
const MAX_WIRE_USER_CHARS = 1000;

/** In-memory fallback used when sessionStorage is unavailable. */
let memoryHistory: ChatTurn[] = [];

function storage(): Storage | null {
  try {
    const s = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

/** Keep the most recent messages, each capped in length. */
export function capHistory(turns: readonly ChatTurn[]): ChatTurn[] {
  return turns
    .filter(
      (t) =>
        !!t &&
        (t.role === "user" || t.role === "assistant") &&
        typeof t.text === "string",
    )
    .slice(-MAX_MESSAGES)
    .map((t) => ({ role: t.role, text: t.text.slice(0, MAX_MESSAGE_CHARS) }));
}

/** Read the stored history. Never throws. */
export function readSessionHistory(): ChatTurn[] {
  const s = storage();
  if (s) {
    try {
      const raw = s.getItem(HISTORY_KEY);
      if (raw === null) return capHistory(memoryHistory);
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return capHistory(parsed as ChatTurn[]);
      return [];
    } catch {
      /* fall through to memory */
    }
  }
  return capHistory(memoryHistory);
}

/** Replace the stored history (capped). Returns the history as stored. */
export function writeSessionHistory(turns: readonly ChatTurn[]): ChatTurn[] {
  const capped = capHistory(turns);
  memoryHistory = capped;
  const s = storage();
  if (s) {
    try {
      s.setItem(HISTORY_KEY, JSON.stringify(capped));
    } catch {
      /* memory copy already holds it */
    }
  }
  return capped;
}

/** Append one message and persist. Returns the updated history. */
export function appendSessionMessage(turn: ChatTurn): ChatTurn[] {
  return writeSessionHistory([...readSessionHistory(), turn]);
}

/** Last 10 turns, with user turns trimmed to the route's length cap. */
export function toWireHistory(turns: readonly ChatTurn[]): ChatTurn[] {
  return capHistory(turns)
    .slice(-MAX_WIRE_TURNS)
    .map((t) => (t.role === "user" ? { role: t.role, text: t.text.slice(0, MAX_WIRE_USER_CHARS) } : t));
}

/** Delete every `tripgenie.assistant.` key from sessionStorage and the memory copy. Used on sign-out. */
export function clearSessionHistory(): void {
  memoryHistory = [];
  const s = storage();
  if (!s) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k !== null && k.startsWith(HISTORY_KEY_PREFIX)) keys.push(k);
    }
    for (const k of keys) {
      try { s.removeItem(k); } catch { /* ignore */ }
    }
  } catch {
    /* ignore */
  }
}
