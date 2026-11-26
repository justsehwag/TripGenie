"use client";

import {
  useCallback,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChatText } from "@/components/chat-text";
import { PreviewCard } from "@/components/preview-card";
import TripAssistant, { type TripAssistantProps } from "@/components/trip-assistant";
import { WELCOME_CHROME_ATTR } from "@/lib/welcome-chrome";
import { getMergedContext, subscribe, type MergedContext } from "@/lib/site-assistant/registry";
import { sanitizeContext } from "@/lib/site-assistant/sanitize";
import { actionReducer, type ActionState } from "@/lib/site-assistant/action-reducer";
import {
  appendSessionMessage,
  readSessionHistory,
  toWireHistory,
} from "@/lib/site-assistant/session-history";
import { GOTO_ROUTES } from "@/lib/site-assistant/tools";
import type {
  ActionProposal,
  PageId,
  SiteAssistantResponse,
} from "@/lib/site-assistant/types";

const REQUEST_TIMEOUT_MS = 35_000;
const MAX_INPUT_CHARS = 1000;
const DOCK_QUERY = "(min-width: 1024px)";

/** Map a pathname to a PageId. Pure and total; `/`, `/discover` and `/sights` share "discover". */
export function pageIdFor(pathname: string | null | undefined): PageId {
  const path = typeof pathname === "string" ? pathname : "";
  const first = path.split(/[?#]/)[0].split("/").filter(Boolean)[0] ?? "";
  switch (first.toLowerCase()) {
    case "":
    case "discover":
    case "sights":
      return "discover";
    case "flights":
      return "flights";
    case "stays":
      return "stays";
    case "cars":
      return "cars";
    case "trips":
      return "trips";
    case "account":
      return "account";
    case "deals":
      return "deals";
    case "itinerary":
    case "trip":
      return "itinerary";
    default:
      return "general";
  }
}

const PAGE_LABEL: Record<PageId, string> = {
  discover: "Discover",
  flights: "Flights",
  stays: "Stays",
  cars: "Cars",
  trips: "My trips",
  account: "Account",
  itinerary: "Itinerary",
  deals: "Deals",
  general: "Trip Saathi",
};

const GREETING: Record<PageId, string> = {
  discover: "Hi! I can help you find places to see and things to do. What are you curious about?",
  flights: "Hi! I can help you narrow down these flights or change your search.",
  stays: "Hi! I can help you compare these stays or change your search.",
  cars: "Hi! I can help with car rentals. What do you need?",
  trips: "Hi! I can help you find your way around your saved trips.",
  account: "Hi! I can help you find your way around your account.",
  itinerary: "Hi! I can help you adjust your itinerary.",
  deals: "Hi! I can help you pick out a deal that suits you.",
  general: "Hi! Ask me anything about planning your trip.",
};

const CHIPS: Record<PageId, string[]> = {
  discover: ["Suggest places to visit", "Find something family-friendly", "Search for a place"],
  flights: ["Find the cheapest option", "Show only non-stop", "Change dates"],
  stays: ["Find the cheapest stay", "Sort by rating", "Change dates"],
  cars: ["What should I look for?", "Take me to flights", "Take me to stays"],
  trips: ["What can I do here?", "Plan a new trip", "Take me to deals"],
  account: ["What can I change here?", "Take me to my trips", "Plan a new trip"],
  itinerary: ["Make day 1 lighter", "Add a rest day", "What does this cost?"],
  deals: ["Which deal is cheapest?", "Show deals for flights", "Plan a new trip"],
  general: ["Plan a new trip", "Find flights", "Find stays"],
};

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  proposalIds?: string[];
}

type Failure = { kind: "network" | "timeout" | "rate"; message: string; retryText: string };

let messageCounter = 0;
function nextId(): string {
  messageCounter += 1;
  return `m${Date.now().toString(36)}${messageCounter}`;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/** Tracks whether <html> carries the welcome gate attribute. `null` until first read. */
function useWelcomeGate(): boolean | null {
  const [gated, setGated] = useState<boolean | null>(null);
  useEffect(() => {
    const el = document.documentElement;
    const read = () => setGated(el.hasAttribute(WELCOME_CHROME_ATTR));
    read();
    const observer = new MutationObserver(read);
    observer.observe(el, { attributes: true, attributeFilter: [WELCOME_CHROME_ATTR] });
    return () => observer.disconnect();
  }, []);
  return gated;
}

/** Pure visibility decision: hidden on /plan, while the welcome gate is set, and until the gate state is read. */
export function shouldShowAssistant(pathname: string | null | undefined, gated: boolean | null): boolean {
  const path = pathname ?? "";
  const onPlan = path.split(/[?#]/)[0].replace(/\/+$/, "") === "/plan" || path.startsWith("/plan/");
  return gated === false && !onPlan;
}

export default function SiteAssistant() {
  const pathname = usePathname();
  const gated = useWelcomeGate();
  if (!shouldShowAssistant(pathname, gated)) return null;
  return <AssistantUi pageId={pageIdFor(pathname)} />;
}

/** Reads the itinerary "planner" slot from merged context; null when absent or itinerary empty. */
function readPlannerProps(merged: MergedContext): TripAssistantProps | null {
  const slot = (merged.data as Record<string, unknown> | null | undefined)?.planner;
  if (!slot || typeof slot !== "object") return null;
  const d = slot as Record<string, unknown>;
  const itinerary = d.itinerary as TripAssistantProps["itinerary"] | undefined;
  if (!itinerary || !Array.isArray(itinerary.days) || itinerary.days.length === 0) return null;

  // Handlers come from the registry actions (proxied to the latest closure,
  // single-parameter), falling back to functions carried in data.
  const applyAction = merged.actions.onApply;
  const restoreAction = merged.actions.onRestore;
  const onApply: TripAssistantProps["onApply"] | undefined =
    typeof applyAction === "function"
      ? (next, inverse) => void applyAction({ next, inverse })
      : typeof d.onApply === "function"
        ? (d.onApply as TripAssistantProps["onApply"])
        : undefined;
  const onRestore: TripAssistantProps["onRestore"] | undefined =
    typeof restoreAction === "function"
      ? (prev) => void restoreAction(prev)
      : typeof d.onRestore === "function"
        ? (d.onRestore as TripAssistantProps["onRestore"])
        : undefined;
  if (!onApply || !onRestore) return null;

  return {
    itinerary,
    context: (d.context ?? {}) as TripAssistantProps["context"],
    resetKey: (d.resetKey ?? 0) as TripAssistantProps["resetKey"],
    estimate: d.estimate as TripAssistantProps["estimate"],
    profile: d.profile as TripAssistantProps["profile"],
    onApply,
    onRestore,
  };
}

function AssistantUi({ pageId: routePage }: { pageId: PageId }) {
  const router = useRouter();
  const panelId = useId();
  const logId = `${panelId}-log`;
  const isDock = useMediaQuery(DOCK_QUERY);

  const routeMerged = useSyncExternalStore(
    subscribe,
    () => getMergedContext(routePage),
    () => getMergedContext(routePage),
  );
  const planner = routePage === "itinerary" ? readPlannerProps(routeMerged) : null;
  // On /itinerary without a usable planner slot, use the generic panel with the general tool list.
  const pageId: PageId = routePage === "itinerary" && !planner ? "general" : routePage;

  const merged = useSyncExternalStore(
    subscribe,
    () => getMergedContext(pageId),
    () => getMergedContext(pageId),
  );

  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [actions, dispatch] = useReducer(actionReducer, [] as ActionState[]);
  const [undoable, setUndoable] = useState<ReadonlySet<string>>(new Set());

  const launcherRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const undoRefs = useRef(new Map<string, () => void>());
  const abortRef = useRef<AbortController | null>(null);
  const pageRef = useRef(pageId);
  pageRef.current = pageId;

  // Restore session history once on mount.
  useEffect(() => {
    const stored = readSessionHistory();
    if (stored.length > 0) {
      setMessages(stored.map((t) => ({ id: nextId(), role: t.role, text: t.text })));
    }
    return () => abortRef.current?.abort();
  }, []);

  // Focus the input when the panel opens.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Keep the newest message in view.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, loading, failure, actions]);

  const closePanel = useCallback(() => {
    setOpen(false);
    launcherRef.current?.focus();
  }, []);

  const send = useCallback(
    async (rawText: string, retry = false) => {
      const text = rawText.trim().slice(0, MAX_INPUT_CHARS);
      if (!text || loading) return;
      setFailure(null);

      let prior = readSessionHistory();
      if (retry) {
        const last = prior[prior.length - 1];
        if (last && last.role === "user" && last.text === text) prior = prior.slice(0, -1);
      } else {
        appendSessionMessage({ role: "user", text });
        setMessages((m) => [...m, { id: nextId(), role: "user", text }]);
      }

      const page = pageRef.current;
      const wire = sanitizeContext(page, merged.summary, merged.data);
      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, REQUEST_TIMEOUT_MS);
      setLoading(true);

      try {
        const res = await fetch("/api/site-assistant", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            page,
            history: toWireHistory(prior),
            context: { summary: wire.summary, data: wire.data },
          }),
          signal: controller.signal,
        });
        if (res.status === 429) {
          setFailure({ kind: "rate", message: "You're sending messages too quickly. Wait a moment, then try again.", retryText: text });
          return;
        }
        if (!res.ok) throw new Error(`status ${res.status}`);
        const body = (await res.json()) as Partial<SiteAssistantResponse>;
        const reply = typeof body.reply === "string" ? body.reply : "";
        if (!reply) throw new Error("empty reply");
        const proposals: ActionProposal[] =
          body.status === "unavailable" || !Array.isArray(body.proposals) ? [] : body.proposals;
        for (const proposal of proposals) dispatch({ type: "receive", proposal });
        appendSessionMessage({ role: "assistant", text: reply });
        setMessages((m) => [
          ...m,
          { id: nextId(), role: "assistant", text: reply, proposalIds: proposals.map((p) => p.id) },
        ]);
      } catch {
        if (controller.signal.aborted && !timedOut) return; // unmounted or superseded
        setFailure(
          timedOut
            ? { kind: "timeout", message: "The assistant took too long to answer.", retryText: text }
            : { kind: "network", message: "Couldn't reach the assistant. Check your connection and try again.", retryText: text },
        );
      } finally {
        clearTimeout(timer);
        if (abortRef.current === controller) abortRef.current = null;
        setLoading(false);
      }
    },
    [loading, merged],
  );

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft;
    setDraft("");
    void send(text);
  };

  const addAssistantNote = (text: string) =>
    setMessages((m) => [...m, { id: nextId(), role: "assistant", text }]);

  const applyProposal = useCallback(
    async (proposal: ActionProposal) => {
      const current = pageRef.current;
      if (proposal.page !== current) {
        dispatch({ type: "apply", id: proposal.id, currentPage: current });
        return;
      }
      if (proposal.tool === "goTo") {
        const route = proposal.params.route;
        if (typeof route !== "string" || !(GOTO_ROUTES as readonly string[]).includes(route)) {
          dispatch({ type: "cancel", id: proposal.id });
          addAssistantNote("I can't open that page.");
          return;
        }
        dispatch({ type: "apply", id: proposal.id, currentPage: current });
        router.push(route);
        return;
      }
      const handler = getMergedContext(current).actions[proposal.tool];
      if (typeof handler !== "function") {
        dispatch({ type: "cancel", id: proposal.id });
        addAssistantNote("That change isn't available on this page any more.");
        return;
      }
      dispatch({ type: "apply", id: proposal.id, currentPage: current });
      try {
        const result = await handler(proposal.params);
        if (result && typeof result === "object" && typeof result.undo === "function") {
          undoRefs.current.set(proposal.id, result.undo);
          setUndoable((s) => new Set(s).add(proposal.id));
        }
      } catch {
        addAssistantNote("Something went wrong applying that change.");
      }
    },
    [router],
  );

  const cancelProposal = useCallback((id: string) => dispatch({ type: "cancel", id }), []);

  const undoProposal = useCallback((id: string) => {
    const undo = undoRefs.current.get(id);
    undoRefs.current.delete(id);
    try {
      undo?.();
    } catch {
      /* undo is best-effort */
    }
    dispatch({ type: "undo", id });
    setUndoable((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }, []);

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closePanel();
      return;
    }
    if (event.key !== "Tab" || isDock) return; // focus trap only in the sheet variant
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !panel.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  if (planner) return <TripAssistant {...planner} />;

  const label = PAGE_LABEL[pageId];
  const showIntro = messages.length === 0;
  const stateById = new Map(actions.map((a) => [a.proposal.id, a]));

  return (
    <div className="site-assistant" data-page={pageId}>
      <button
        ref={launcherRef}
        type="button"
        className="site-assistant__launcher"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? "Close Trip Saathi" : "Open Trip Saathi"}
        onClick={() => (open ? closePanel() : setOpen(true))}
      >
        <span className="site-assistant__launcher-icon" aria-hidden="true">
          {open ? "\u00d7" : "\u2728"}
        </span>
        <span className="site-assistant__launcher-label">Ask Trip Saathi</span>
      </button>

      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          className={`site-assistant__panel ${isDock ? "site-assistant__panel--dock" : "site-assistant__panel--sheet"}`}
          role="dialog"
          aria-modal={isDock ? undefined : true}
          aria-label={`Trip Saathi, ${label} page`}
          onKeyDown={onPanelKeyDown}
        >
          <header className="site-assistant__header">
            <h2 className="site-assistant__title">Trip Saathi</h2>
            <span className="site-assistant__page">{label}</span>
            <button
              type="button"
              className="site-assistant__close"
              aria-label="Close assistant"
              onClick={closePanel}
            >
              <span aria-hidden="true">{"\u00d7"}</span>
            </button>
          </header>

          <div
            ref={logRef}
            id={logId}
            className="site-assistant__log"
            role="log"
            aria-live="polite"
            aria-relevant="additions"
          >
            {showIntro ? (
              <div className="site-assistant__message site-assistant__message--assistant site-assistant__greeting">
                <ChatText text={GREETING[pageId]} />
              </div>
            ) : null}

            {messages.map((m) => (
              <div
                key={m.id}
                className={`site-assistant__message site-assistant__message--${m.role}`}
              >
                {m.role === "assistant" ? <ChatText text={m.text} /> : <p>{m.text}</p>}
                {m.proposalIds?.map((id) => {
                  const entry = stateById.get(id);
                  if (!entry) return null;
                  return (
                    <PreviewCard
                      key={id}
                      proposal={entry.proposal}
                      status={entry.status}
                      canUndo={undoable.has(id)}
                      onApply={applyProposal}
                      onCancel={cancelProposal}
                      onUndo={undoProposal}
                    />
                  );
                })}
              </div>
            ))}

            {loading ? (
              <div className="site-assistant__message site-assistant__message--assistant site-assistant__loading" role="status">
                <span className="site-assistant__typing" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                <span className="site-assistant__loading-text">Thinking{"\u2026"}</span>
              </div>
            ) : null}

            {failure ? (
              <div className="site-assistant__error" role="alert">
                <p className="site-assistant__error-text">{failure.message}</p>
                <button
                  type="button"
                  className="btn site-assistant__retry"
                  onClick={() => void send(failure.retryText, true)}
                >
                  Retry
                </button>
              </div>
            ) : null}
          </div>

          {showIntro && !loading ? (
            <ul className="site-assistant__chips" aria-label="Suggestions">
              {CHIPS[pageId].map((chip) => (
                <li key={chip}>
                  <button
                    type="button"
                    className="site-assistant__chip"
                    onClick={() => void send(chip)}
                  >
                    {chip}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <form className="site-assistant__form" onSubmit={onSubmit}>
            <label className="sr-only" htmlFor={`${panelId}-input`}>
              Message Trip Saathi
            </label>
            <input
              ref={inputRef}
              id={`${panelId}-input`}
              className="site-assistant__input"
              type="text"
              value={draft}
              maxLength={MAX_INPUT_CHARS}
              placeholder="Ask about this page…"
              autoComplete="off"
              onChange={(e) => setDraft(e.target.value)}
            />
            <button
              type="submit"
              className="btn btn--primary site-assistant__send"
              aria-label="Send message"
              disabled={loading || draft.trim().length === 0}
            >
              <span aria-hidden="true">{"\u2192"}</span>
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
