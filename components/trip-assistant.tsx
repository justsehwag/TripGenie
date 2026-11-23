"use client";

/**
 * Trip Assistant panel: docked chat on the itinerary page.
 * Imports only pure, client-safe modules (types, wire, proposal, history, transcript).
 * The model never edits the itinerary: it proposes, the traveller applies.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { ChatText } from "@/components/chat-text";
import type { Activity, Itinerary, TripDay } from "@/lib/types";
import { formatInr } from "@/lib/itinerary-inr";
import type {
  AppliedEdit,
  AssistantContext,
  AssistantRequest,
  AssistantResponse,
  ChatTurn,
  EditProposal,
  HistoryState,
  ProfileSubset,
  SourceLink,
} from "@/lib/assistant/types";
import {
  MAX_ASSISTANT_TURN_CHARS,
  MAX_HISTORY_TURNS,
  MAX_MESSAGE_CHARS,
  MAX_OFFERED,
  parseProposal,
  toWireItinerary,
  trimHistory,
  whitelistProfile,
} from "@/lib/assistant/wire";
import { applyProposal, previewProposal, resolveTarget } from "@/lib/assistant/proposal";
import type { ApplyDeps } from "@/lib/assistant/proposal";
import { canUndo, emptyHistory, popEdit, pushEdit } from "@/lib/assistant/history";
import { initialTranscript, transcriptReducer } from "@/lib/assistant/transcript";
import type { TranscriptMessage, TranscriptProposal } from "@/lib/assistant/transcript";

export interface TripAssistantProps {
  itinerary: Itinerary;
  context: AssistantContext;
  /** Changes when a new itinerary starts: clears transcript and undo history. */
  resetKey: string | number;
  /** Called with the validated next itinerary and its undo entry. */
  onApply: (next: Itinerary, inverse: AppliedEdit) => void;
  onRestore: (prev: Itinerary) => void;
  /** Labels a new Stop's price as an estimate (applyProposal dep). */
  estimate: ApplyDeps["estimate"];
  /** Whitelisted profile subset from the signed-in profile source. Never user id or email. */
  profile?: ProfileSubset;
}

const CLIENT_TIMEOUT_MS = 35_000;
const PANEL_ID = "trip-assistant-panel";
const INPUT_ID = "trip-assistant-input";
const COUNTER_SHOW_AT = 800;

function pickContext(c: AssistantContext | undefined): AssistantContext {
  const out: AssistantContext = {};
  if (!c) return out;
  if (c.origin) out.origin = c.origin;
  if (c.destination) out.destination = c.destination;
  if (c.durationDays) out.durationDays = c.durationDays;
  if (c.travellers) out.travellers = { adults: c.travellers.adults, children: c.travellers.children };
  if (c.budgetLevel) out.budgetLevel = c.budgetLevel;
  if (c.diet) out.diet = c.diet;
  if (c.pace) out.pace = c.pace;
  if (Array.isArray(c.interests)) out.interests = [...c.interests];
  return out;
}

function httpsHost(link: SourceLink): { href: string; host: string } | null {
  try {
    const u = new URL(link.url);
    if (u.protocol !== "https:") return null;
    return { href: u.href, host: link.host || u.hostname };
  } catch {
    return null;
  }
}

function checkedDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function signed(n: number): string {
  if (!Number.isFinite(n) || n === 0) return `${formatInr(0)} (no change)`;
  return n > 0 ? `+${formatInr(n)}` : `-${formatInr(-n)}`;
}

function failureText(reason: string): string {
  switch (reason) {
    case "stale":
      return "I could not apply that change because the stop it points to has moved or changed. Nothing was changed.";
    case "revalidation-failed":
      return "I could not apply that change because the edited trip failed a validity check. Nothing was changed.";
    case "missing-place":
      return "I could not apply that change because the place details are incomplete. Nothing was changed.";
    default:
      return "I could not apply that change. Nothing was changed.";
  }
}

function normalizeResponse(raw: unknown): AssistantResponse | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.reply !== "string") return null;
  const proposals = (Array.isArray(r.proposals) ? r.proposals : [])
    .map((p) => parseProposal(p))
    .filter((p): p is EditProposal => p !== null)
    .slice(0, 5);
  const sources = (Array.isArray(r.sources) ? r.sources : []).filter(
    (s): s is SourceLink =>
      !!s && typeof s === "object" && typeof (s as SourceLink).url === "string" && typeof (s as SourceLink).host === "string",
  );
  const offered = (Array.isArray(r.offered) ? r.offered : []).filter(
    (o): o is { placeId: string; name: string } =>
      !!o && typeof o === "object" && typeof (o as { placeId?: unknown }).placeId === "string" && typeof (o as { name?: unknown }).name === "string",
  );
  const status = r.status === "partial" || r.status === "unavailable" ? r.status : "ok";
  return { reply: r.reply, proposals, sources, offered, status, degraded: [] };
}

function rowKey(a: Activity): string {
  return `${a.time}|${a.title}|${a.cost}`;
}

function DayColumn({ label, day, other }: { label: string; day: TripDay | null; other: TripDay | null }) {
  const otherKeys = new Set((other?.activities ?? []).map(rowKey));
  return (
    <div className="trip-assistant__day">
      <p className="trip-assistant__day-label">{label}</p>
      {day ? (
        <>
          <ul className="trip-assistant__rows">
            {day.activities.map((a, i) => (
              <li
                key={`${i}-${rowKey(a)}`}
                className={
                  otherKeys.has(rowKey(a)) ? "trip-assistant__row" : "trip-assistant__row trip-assistant__row--changed"
                }
              >
                <span className="trip-assistant__row-time">{a.time}</span>
                <span className="trip-assistant__row-title">{a.title}</span>
                <span className="trip-assistant__row-cost">{formatInr(a.cost)}</span>
              </li>
            ))}
            {day.activities.length === 0 ? <li className="trip-assistant__row">No stops</li> : null}
          </ul>
          <p className="trip-assistant__day-total">Day {day.day} total: {formatInr(day.total)}</p>
        </>
      ) : (
        <p className="trip-assistant__day-total">Not available</p>
      )}
    </div>
  );
}

function ProposalCard({
  messageId,
  entry,
  itinerary,
  estimate,
  onApply,
  onDismiss,
}: {
  messageId: string;
  entry: TranscriptProposal;
  itinerary: Itinerary;
  estimate: ApplyDeps["estimate"];
  onApply: (messageId: string, proposal: EditProposal) => void;
  onDismiss: (messageId: string, proposalId: string) => void;
}) {
  const { proposal, status } = entry;
  const resolvable = useMemo(() => resolveTarget(itinerary, proposal.edit) !== null, [itinerary, proposal]);
  const effective = status === "pending" && !resolvable ? "stale" : status;
  const preview = useMemo(
    () => (effective === "pending" ? previewProposal(itinerary, proposal, { estimate }) : null),
    [effective, itinerary, proposal, estimate],
  );
  return (
    <div role="group" aria-label={proposal.summary} className={`trip-assistant__proposal trip-assistant__proposal--${effective}`}>
      <p className="trip-assistant__proposal-summary">{proposal.summary}</p>
      {preview ? (
        <>
          <div className="trip-assistant__compare">
            <DayColumn label="Before" day={preview.dayBefore} other={preview.dayAfter} />
            <DayColumn label="After" day={preview.dayAfter} other={preview.dayBefore} />
          </div>
          <p className="trip-assistant__delta">
            Day total {signed(preview.dayTotalDelta)}. Trip total {signed(preview.tripTotalDelta)}.
          </p>
        </>
      ) : effective === "pending" ? (
        <p className="trip-assistant__delta">Preview not available for this change.</p>
      ) : null}
      {proposal.price ? (
        <p className="trip-assistant__price-note">
          Price {formatInr(proposal.price.inr)} from {proposal.price.sourceHost}
          {checkedDate(proposal.price.checkedAt) ? `, checked ${checkedDate(proposal.price.checkedAt)}` : ""}.
        </p>
      ) : null}
      <div className="trip-assistant__proposal-actions">
        {effective === "applied" ? <span className="trip-assistant__badge">Applied</span> : null}
        {effective === "dismissed" ? <span className="trip-assistant__badge">Dismissed</span> : null}
        {effective === "stale" ? <span className="trip-assistant__badge trip-assistant__badge--warn">Out of date</span> : null}
        {effective === "pending" || effective === "stale" ? (
          <>
            <button
              type="button"
              className="btn btn--primary trip-assistant__apply"
              disabled={effective !== "pending"}
              onClick={() => onApply(messageId, proposal)}
            >
              Apply
            </button>
            <button type="button" className="btn trip-assistant__dismiss" onClick={() => onDismiss(messageId, proposal.id)}>
              Dismiss
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

const SUGGESTIONS: Array<{ label: string; send: boolean; text: string }> = [
  { label: "What's special about Day 1's first stop?", send: true, text: "What's special about Day 1's first stop?" },
  { label: "Suggest an alternative to …", send: false, text: "Suggest an alternative to " },
  { label: "Move lunch later", send: true, text: "Move lunch later" },
];

export default function TripAssistant({
  itinerary,
  context,
  resetKey,
  onApply,
  onRestore,
  estimate,
  profile,
}: TripAssistantProps) {
  const [state, dispatch] = useReducer(transcriptReducer, undefined, initialTranscript);
  const [history, setHistory] = useState<HistoryState>(emptyHistory);
  const [open, setOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [input, setInput] = useState("");
  const [cooldown, setCooldown] = useState(0);

  const launcherRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pendingRef = useRef(false);
  const idRef = useRef(0);
  const prevKeyRef = useRef(resetKey);

  const nextId = (p: string) => `${p}${++idRef.current}`;

  /* ---- mobile breakpoint ---- */
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(max-width: 639px)");
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  /* ---- abort in-flight request on unmount ---- */
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  /* ---- reset on new itinerary ---- */
  useEffect(() => {
    if (prevKeyRef.current === resetKey) return;
    prevKeyRef.current = resetKey;
    abortRef.current?.abort();
    abortRef.current = null;
    pendingRef.current = false;
    dispatch({ type: "reset" });
    setHistory(emptyHistory());
    setInput("");
  }, [resetKey]);

  /* ---- focus the input when opened ---- */
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  /* ---- keep the newest message in view ---- */
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages, state.pending, state.error, open]);

  /* ---- 429 countdown ---- */
  useEffect(() => {
    setCooldown(state.error?.retryAfterSec ?? 0);
  }, [state.error]);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  function collapse() {
    setOpen(false);
    launcherRef.current?.focus();
  }

  function onPanelKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      collapse();
      return;
    }
    if (e.key !== "Tab" || !isMobile || !panelRef.current) return;
    const nodes = Array.from(
      panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !panelRef.current.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !panelRef.current.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }

  /** Turns that go to the model: real exchanges only (local notes carry no status), last 10. */
  function turnsBefore(messages: TranscriptMessage[]): ChatTurn[] {
    const turns: ChatTurn[] = [];
    for (const m of messages) {
      if (m.role === "assistant" && m.status === undefined) continue;
      const text = m.text.slice(0, m.role === "user" ? MAX_MESSAGE_CHARS : MAX_ASSISTANT_TURN_CHARS);
      if (text.trim()) turns.push({ role: m.role, text });
    }
    return trimHistory(turns, MAX_HISTORY_TURNS);
  }

  async function request(text: string, priorMessages: TranscriptMessage[]) {
    pendingRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, CLIENT_TIMEOUT_MS);

    const body: AssistantRequest = {
      message: text,
      history: turnsBefore(priorMessages),
      itinerary: toWireItinerary(itinerary),
      context: pickContext(context),
    };
    const safeProfile = whitelistProfile(profile);
    if (safeProfile) body.profile = safeProfile;
    if (state.offered.length > 0) body.offered = state.offered.slice(-MAX_OFFERED);

    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      if (res.status === 429) {
        const j = (json ?? {}) as { retryAfterSec?: unknown };
        const header = Number(res.headers.get("Retry-After"));
        const sec =
          typeof j.retryAfterSec === "number" && j.retryAfterSec > 0
            ? Math.ceil(j.retryAfterSec)
            : Number.isFinite(header) && header > 0
              ? Math.ceil(header)
              : 30;
        dispatch({ type: "fail", message: "Too many messages.", retryAfterSec: sec });
        return;
      }
      if (res.status === 413) {
        dispatch({ type: "fail", message: "This trip is too large for the assistant to read." });
        return;
      }
      if (!res.ok) {
        dispatch({ type: "fail", message: "The assistant could not answer. Please try again." });
        return;
      }
      const parsed = normalizeResponse(json);
      if (!parsed) {
        dispatch({ type: "fail", message: "The assistant sent a reply I could not read. Please try again." });
        return;
      }
      if (parsed.status === "unavailable") {
        dispatch({ type: "fail", message: parsed.reply || "The assistant is temporarily unavailable." });
        return;
      }
      dispatch({ type: "receive", id: nextId("a"), response: parsed });
    } catch {
      if (controller.signal.aborted && !timedOut) return; // reset or unmount: stay silent
      dispatch({
        type: "fail",
        message: timedOut ? "The assistant took too long to answer." : "Could not reach the assistant. Check your connection.",
      });
    } finally {
      clearTimeout(timer);
      if (abortRef.current === controller) {
        abortRef.current = null;
        pendingRef.current = false;
      }
    }
  }

  function send(raw: string) {
    const text = raw.trim();
    if (!text || text.length > MAX_MESSAGE_CHARS || pendingRef.current) return;
    const prior = state.messages;
    dispatch({ type: "send", id: nextId("u"), text });
    setInput("");
    void request(text, prior);
  }

  function retry() {
    if (pendingRef.current || cooldown > 0 || state.lastUserText === null || !state.error) return;
    const msgs = state.messages;
    const last = msgs[msgs.length - 1];
    const prior = last && last.role === "user" ? msgs.slice(0, -1) : msgs;
    const text = state.lastUserText;
    dispatch({ type: "retry" });
    void request(text, prior);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    send(input);
  }

  function chooseSuggestion(s: (typeof SUGGESTIONS)[number]) {
    if (s.send) {
      send(s.text);
    } else {
      setInput(s.text);
      inputRef.current?.focus();
    }
  }

  /* ---- apply, dismiss, undo ---- */
  function applyOne(messageId: string, proposal: EditProposal) {
    const r = applyProposal(itinerary, proposal, { estimate });
    if (!r.ok) {
      if (r.reason === "stale") dispatch({ type: "proposal", messageId, proposalId: proposal.id, status: "stale" });
      dispatch({ type: "note", id: nextId("n"), text: failureText(r.reason) });
      return;
    }
    onApply(r.itinerary, r.inverse);
    setHistory((h) => pushEdit(h, r.inverse));
    dispatch({ type: "proposal", messageId, proposalId: proposal.id, status: "applied" });
    const dayTotal = r.itinerary.days.find((d) => d.day === proposal.edit.day)?.total ?? 0;
    dispatch({
      type: "note",
      id: nextId("n"),
      text: `Applied: ${proposal.summary} Day ${proposal.edit.day} total is now ${formatInr(dayTotal)}.`,
    });
  }

  function dismissOne(messageId: string, proposalId: string) {
    dispatch({ type: "proposal", messageId, proposalId, status: "dismissed" });
  }

  const undoable = canUndo(history, itinerary);
  const hasHistory = history.entries.length > 0;

  function undo() {
    if (!undoable) return;
    const { history: next, edit } = popEdit(history);
    if (!edit) return;
    onRestore(edit.before);
    setHistory(next);
    dispatch({ type: "note", id: nextId("n"), text: `Reverted: ${edit.summary}` });
  }

  /* ---- render ---- */
  const count = input.length;
  const empty = state.messages.length === 0 && !state.pending && !state.error;

  return (
    <div className="trip-assistant">
      <button
        ref={launcherRef}
        type="button"
        className={open ? "btn btn--primary trip-assistant__launcher trip-assistant__launcher--open" : "btn btn--primary trip-assistant__launcher"}
        aria-expanded={open}
        aria-controls={open ? PANEL_ID : undefined}
        onClick={() => (open ? collapse() : setOpen(true))}
      >
        Trip assistant
      </button>

      {open ? (
        <div
          ref={panelRef}
          id={PANEL_ID}
          className="trip-assistant__panel card"
          role={isMobile ? "dialog" : "region"}
          aria-modal={isMobile ? true : undefined}
          aria-label="Trip assistant"
          onKeyDown={onPanelKeyDown}
        >
          <div className="trip-assistant__header">
            <div className="trip-assistant__title-block">
              <h2 className="trip-assistant__title">Trip assistant</h2>
              <span className="trip-assistant__ai-label">AI assistant</span>
            </div>
            <div className="trip-assistant__header-actions">
              {hasHistory ? (
                <button
                  type="button"
                  className="btn trip-assistant__undo"
                  disabled={!undoable}
                  title={undoable ? undefined : "Undo is not available after other changes to the trip"}
                  onClick={undo}
                >
                  Undo
                </button>
              ) : null}
              <button type="button" className="btn trip-assistant__collapse" aria-label="Collapse trip assistant" onClick={collapse}>
                Close
              </button>
            </div>
          </div>

          <div ref={logRef} className="trip-assistant__log" role="log" aria-live="polite" aria-label="Conversation">
            {empty ? (
              <div className="trip-assistant__empty">
                <p className="trip-assistant__empty-text">Ask about your trip or request a change. You review every change before it is applied.</p>
                <div className="chip-row trip-assistant__suggestions">
                  {SUGGESTIONS.map((s) => (
                    <button key={s.label} type="button" className="chip trip-assistant__suggestion" onClick={() => chooseSuggestion(s)}>
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {state.messages.map((m) => (
              <div
                key={m.id}
                className={`trip-assistant__message trip-assistant__message--${m.role}${
                  m.role === "assistant" && m.status === undefined ? " trip-assistant__message--note" : ""
                }`}
              >
                {m.role === "assistant" ? (
                  <div className="trip-assistant__text trip-assistant__rich">
                    <ChatText text={m.text} />
                  </div>
                ) : (
                  <p className="trip-assistant__text">{m.text}</p>
                )}
                {m.status === "partial" ? (
                  <p className="trip-assistant__hint">Some sources were unavailable for this answer.</p>
                ) : null}
                {m.sources && m.sources.length > 0 ? (
                  <ul className="trip-assistant__sources">
                    {m.sources.map((s) => {
                      const link = httpsHost(s);
                      if (!link) return null;
                      const date = checkedDate(s.checkedAt);
                      return (
                        <li key={`${s.ref}-${link.href}`} className="trip-assistant__source">
                          <a
                            className="chip trip-assistant__source-link"
                            href={link.href}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {link.host}
                          </a>
                          {date ? <span className="trip-assistant__source-date">checked {date}</span> : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                {m.proposals && m.proposals.length > 0 ? (
                  <div className="trip-assistant__proposals">
                    {m.proposals.map((p) => (
                      <ProposalCard
                        key={`${m.id}-${p.proposal.id}`}
                        messageId={m.id}
                        entry={p}
                        itinerary={itinerary}
                        estimate={estimate}
                        onApply={applyOne}
                        onDismiss={dismissOne}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            ))}

            {state.pending ? (
              <div className="trip-assistant__pending" role="status">
                <span className="trip-assistant__pending-bar skeleton__block" aria-hidden="true" />
                <span className="trip-assistant__pending-label">Checking sources</span>
              </div>
            ) : null}

            {state.error ? (
              <div className="trip-assistant__error" role="alert">
                <p className="trip-assistant__error-text">
                  {state.error.retryAfterSec !== undefined
                    ? cooldown > 0
                      ? `Too many messages, try again in ${cooldown} s.`
                      : "You can try again now."
                    : state.error.message}
                </p>
                <button type="button" className="btn trip-assistant__retry" disabled={cooldown > 0} onClick={retry}>
                  Retry
                </button>
              </div>
            ) : null}
          </div>

          <form className="trip-assistant__form" onSubmit={onSubmit}>
            <label className="trip-assistant__input-label" htmlFor={INPUT_ID}>
              Message the trip assistant <span className="trip-assistant__ai-label">AI assistant</span>
            </label>
            <div className="trip-assistant__input-row">
              <input
                ref={inputRef}
                id={INPUT_ID}
                className="trip-assistant__input"
                type="text"
                value={input}
                maxLength={MAX_MESSAGE_CHARS}
                autoComplete="off"
                placeholder="Ask or request a change"
                onChange={(e) => setInput(e.target.value)}
              />
              <button
                type="submit"
                className="btn btn--primary trip-assistant__send"
                aria-label="Send message"
                disabled={state.pending || input.trim().length === 0}
              >
                Send
              </button>
            </div>
            {count >= COUNTER_SHOW_AT ? (
              <span className="trip-assistant__counter" aria-hidden="true">
                {count}/{MAX_MESSAGE_CHARS}
              </span>
            ) : null}
            <p className="trip-assistant__disclaimer">
              AI assistant. Check prices and opening hours with the venue before you travel.
            </p>
          </form>
        </div>
      ) : null}
    </div>
  );
}
