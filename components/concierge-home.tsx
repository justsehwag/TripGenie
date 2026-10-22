"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { parseRoute, emptyRouteState, routeConfirmed } from "@/lib/route-intake";
import { durationFromText } from "@/lib/date-intake";
import { illustration } from "@/lib/illustrations";
import type { RouteState, TripContext } from "@/lib/types";
import { advance, uncollected, REQUIRED_FIELDS, type ControllerState, type ControllerResponse, type RequiredField } from "@/lib/preference-controller";
import { syncFallbackModel } from "@/lib/intake-fallback";
import { useTripContext } from "@/components/trip-context";
import { useSpeechInput } from "@/components/use-speech-input";

/** A single conversation turn shown in the planner transcript. */
type ChatMessage = { role: "assistant" | "user"; text: string };

/**
 * Captured Live_Trip_Profile categories (Req 21.5). Each field is optional and
 * only set when the traveler actually shares it — values are never fabricated.
 */
type CapturedCategories = {
  route?: { from: string; to: string };
  dates?: string;
  flightsClass?: string;
  whosJoining?: string;
  foodDietary?: string;
  tripVibe?: string;
  specialNeeds?: string;
};

/** Seed greeting that opens every conversation (Req 21.3). */
const GREETING =
  "Namaste! Where are you travelling from and to? Example: From Delhi to Switzerland.";

/** Selectable example prompts that seed and submit the conversation (Req 21.3). */
const EXAMPLE_PROMPTS: readonly string[] = [
  "From Delhi to Switzerland",
  "From Mumbai to Singapore",
  "From Bengaluru to Bali",
];

/** Tappable suggestion answers keyed by the trip field currently being asked.
 *  Each is a valid answer the field-aware parser accepts, so a tap advances
 *  the profile. Falls back to the route examples for the opening/route turn. */
const SUGGESTIONS_BY_FIELD: Record<RequiredField, readonly string[]> = {
  origin: ["From Delhi", "From Mumbai", "From Bengaluru"],
  destination: ["To Switzerland", "To Singapore", "To Bali"],
  durationDays: ["4 days", "7 days", "10 days"],
  travellers: ["Solo", "A couple", "2 adults", "Family of 4"],
  budgetLevel: ["Budget", "Mid-range", "Luxury"],
  diet: ["No preference", "Vegetarian", "Vegan", "Halal"],
  pace: ["Relaxed", "Balanced", "Packed"],
  interests: ["Culture", "Food", "Adventure", "Nature", "Beaches"],
};

/** The six non-route categories rendered in the Live_Trip_Profile (Req 21.5). */
const CATEGORY_ROWS: ReadonlyArray<{
  key: keyof Omit<CapturedCategories, "route">;
  label: string;
  prompt: string;
}> = [
  { key: "dates", label: "Travel dates", prompt: "When are you travelling, and for how long?" },
  { key: "flightsClass", label: "Flights & class", prompt: "Which cabin class do you prefer — economy, premium, business, or first?" },
  { key: "whosJoining", label: "Who's joining", prompt: "Who's joining you — solo, a couple, family, or friends?" },
  { key: "foodDietary", label: "Food & dietary", prompt: "Any food or dietary preferences?" },
  { key: "tripVibe", label: "Trip vibe", prompt: "What's the vibe — relaxed, adventure, culture, budget, or luxury?" },
  { key: "specialNeeds", label: "Special needs", prompt: "Any special needs we should plan for — accessibility, infants, or medical?" },
];

/**
 * Best-effort keyword heuristics over a lowercased answer. Each returns the
 * matched phrase or null; callers only set a category when a value is present,
 * so nothing is ever fabricated (Req 21.4, 21.5).
 */
function detectFoodDietary(text: string): string | null {
  const m = text.match(/veg(?:etarian|an)?|vegan|halal|jain|gluten(?:-free)?/);
  return m ? m[0] : null;
}
function detectFlightsClass(text: string): string | null {
  const m = text.match(/business|economy|first class|premium/);
  return m ? m[0] : null;
}
function detectWhosJoining(text: string): string | null {
  const m = text.match(/family|couple|solo|friends|honeymoon/);
  return m ? m[0] : null;
}
function detectTripVibe(text: string): string | null {
  const m = text.match(/relaxed|adventure|culture|budget|luxury|beach/);
  return m ? m[0] : null;
}
function detectSpecialNeeds(text: string): string | null {
  const m = text.match(/wheelchair|accessib(?:le|ility)?|infant|stroller|medical/);
  return m ? m[0] : null;
}

/**
 * Build an INSTANT, local conversational acknowledgement for what the traveller
 * just typed - zero network latency. It reads the message with the same light
 * keyword heuristics the UI already uses and reflects the specific detail back
 * ("Delhi to Switzerland, lovely." / "A family of 4 - noted."). Returns "" when
 * nothing specific was detected so the caller can fall back to a neutral line.
 * Never fabricates: only mentions what the text actually contains.
 */
function instantAck(answer: string, route: RouteState): string {
  const text = answer.trim();
  if (!text) return "";
  const lower = text.toLowerCase();
  const parts: string[] = [];

  const parsed = parseRoute(text, route);
  if (parsed.origin && parsed.destination) {
    parts.push(`${parsed.origin} to ${parsed.destination} - a great pick`);
  } else if (parsed.destination) {
    parts.push(`${parsed.destination} sounds wonderful`);
  } else if (parsed.origin) {
    parts.push(`setting off from ${parsed.origin}`);
  }

  const days = durationFromText(text);
  if (days) parts.push(`${days} day${days > 1 ? "s" : ""} it is`);

  const who = detectWhosJoining(lower);
  if (who) parts.push(`travelling ${who}`);

  const cabin = detectFlightsClass(lower);
  if (cabin) parts.push(`${cabin} class, noted`);

  const food = detectFoodDietary(lower);
  if (food) parts.push(`${food} dining sorted`);

  const vibe = detectTripVibe(lower);
  if (vibe) parts.push(`a ${vibe} trip`);

  const needs = detectSpecialNeeds(lower);
  if (needs) parts.push(`we will plan for ${needs}`);

  if (parts.length === 0) return "";
  const joined = parts.slice(0, 2).join(", ");
  return joined.charAt(0).toUpperCase() + joined.slice(1) + ".";
}
/**
 * Project a canonical `TripContext` (produced by the preference controller via
 * `/api/ai`) onto the EXISTING `CapturedCategories` display shape (Req 4.x).
 *
 * This fills only the rows the Live_Trip_Profile already renders, and only when
 * the corresponding `TripContext` field is actually present — nothing is ever
 * fabricated and NO new row/category is introduced. The mapping into the fixed
 * six non-route categories is:
 *   - origin + destination → route
 *   - durationDays         → dates ("N day(s)")
 *   - travellers           → whosJoining ("N traveller(s)")
 *   - diet                 → foodDietary
 *   - budgetLevel / pace   → tripVibe (budget level preferred, else pace)
 * `flightsClass`, `specialNeeds`, and `interests` have no controller field and
 * are left untouched (they continue to be captured by the regex fallback path).
 */
function capturedFromContext(
  prev: CapturedCategories,
  ctx: TripContext,
): CapturedCategories {
  const updated: CapturedCategories = { ...prev };

  if (ctx.origin && ctx.destination) {
    updated.route = { from: ctx.origin, to: ctx.destination };
  }

  if (typeof ctx.durationDays === "number" && ctx.durationDays > 0) {
    updated.dates = `${ctx.durationDays} day${ctx.durationDays > 1 ? "s" : ""}`;
  }

  if (ctx.travellers) {
    const total =
      (Number.isFinite(ctx.travellers.adults) ? ctx.travellers.adults : 0) +
      (Number.isFinite(ctx.travellers.children) ? ctx.travellers.children : 0);
    if (total >= 1) {
      updated.whosJoining = `${total} traveller${total > 1 ? "s" : ""}`;
    }
  }

  if (ctx.diet && ctx.diet.trim()) updated.foodDietary = ctx.diet;

  // Trip vibe mirrors a single row: prefer the budget level, else the pace.
  const vibe = (ctx.budgetLevel ?? ctx.pace)?.trim();
  if (vibe) updated.tripVibe = vibe;

  return updated;
}

/** Build the summary query passed to the full planner (Req 21.10). */
function planSummary(route: RouteState, lastUserMessage: string): string {
  if (routeConfirmed(route)) return `from ${route.origin} to ${route.destination}`;
  return lastUserMessage;
}

/** Total number of Live_Trip_Profile categories tracked by the progress bar. */
const TOTAL_CATEGORIES = 7;

/**
 * Count how many of the seven categories have been captured so far (Req 21.5).
 * The route counts once when it is set; each of the six non-route categories
 * counts once when it carries a defined value. Nothing is ever fabricated, so
 * this is a faithful reflection of what the traveler has actually shared.
 */
function capturedCount(captured: CapturedCategories): number {
  let count = captured.route ? 1 : 0;
  for (const row of CATEGORY_ROWS) {
    if (captured[row.key] !== undefined) count += 1;
  }
  return count;
}

/** The message shown when the (UI-only) voice button is pressed — honest: voice
 *  recognition is not wired, so we never fabricate a transcript (Req 21.7). */
const VOICE_UNAVAILABLE =
  "Voice input isn't available yet — please type your answer.";

/** Inline microphone glyph for the voice button (an SVG, never an emoji). */
function MicIcon() {
  return (
    <svg
      className="concierge-mic__icon"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="8" y1="22" x2="16" y2="22" />
    </svg>
  );
}

/**
 * Props for the unified AI Travel Assistant (Req 21).
 *
 * `variant` selects how the concierge presents itself:
 *   - "home" (default, at `/`): the compact lead header plus the "Open full
 *     planner" CTA that pushes to `/plan`.
 *   - "assistant" (at `/plan`): a serif page header ("AI Travel Assistant" +
 *     "Plan your trip with TripGenie") above the two panes, and NO self-
 *     referential "Open full planner" CTA.
 * `initialQuery` (assistant only) seeds the conversation once on mount so the
 * Live_Trip_Profile pre-fills from a `?q=` query carried over from the
 * homepage.
 */
export interface ConciergeHomeProps {
  variant?: "home" | "assistant";
  initialQuery?: string;
}

/**
 * The unified AI Travel Assistant (Requirement 21): a two-column layout with a
 * conversational planner on the left and a Live_Trip_Profile on the right,
 * served at BOTH `/` (variant "home") and `/plan` (variant "assistant").
 * Interpretation reuses the existing route-intake and date-intake pipeline;
 * no live availability or confirmed bookings are invented (Req 21.7).
 */
export default function ConciergeHome({
  variant = "home",
  initialQuery,
}: ConciergeHomeProps = {}) {
  const router = useRouter();
  const sharedContext = useTripContext();
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", text: GREETING },
  ]);
  const [routeState, setRouteState] = useState<RouteState>(emptyRouteState());
  const [captured, setCaptured] = useState<CapturedCategories>({});
  const [draft, setDraft] = useState("");
  /** Running preference-controller state carried across planning turns (Req 2.4). */
  const [controllerState, setControllerState] = useState<ControllerState>({
    context: {},
    questionsAsked: 0,
  });
  /** In-flight guard so a turn's request is never fired twice (no new markup). */
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  /** The scrollable conversation container, auto-scrolled to the newest turn. */
  const conversationRef = useRef<HTMLDivElement>(null);
  /** Guards the one-shot seeding so React 18 StrictMode double-mount or any
   *  re-render never replays the seed query more than once. */
  const seededRef = useRef(false);

  // Keep the newest message in view after each turn so the user never has to
  // scroll manually (the conversation is a fixed-height scroll area).
  useEffect(() => {
    const el = conversationRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  /**
   * Real browser voice input via the Web Speech hook (Req 9.x). On a recognized
   * transcript we drop the text into the draft input (the traveler can edit then
   * send); on an honest failure we append a descriptive assistant note using the
   * existing message rendering. When the browser lacks the API the hook reports
   * `supported:false` and we keep the exact existing VOICE_UNAVAILABLE message.
   */
  const speech = useSpeechInput({
    existingText: draft,
    onResult: (result) => {
      if (result.ok) {
        const text = result.text.trim();
        if (text) {
          setDraft(text);
          inputRef.current?.focus();
        }
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", text: result.error },
        ]);
        inputRef.current?.focus();
      }
    },
  });

  // Seed the conversation once from ?q= on the assistant variant so the
  // profile pre-fills from the homepage hand-off (Req 21.10). Empty deps: run
  // at most once on mount; the ref makes it idempotent.
  useEffect(() => {
    if (variant !== "assistant") return;
    if (seededRef.current) return;
    const seed = initialQuery?.trim();
    if (!seed) return;
    seededRef.current = true;
    void submit(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const headerIllustration = illustration("location-pin");

  /**
   * Deterministic OFFLINE fallback — the original regex/keyword pipeline, kept
   * verbatim so the planner still works if `/api/ai` (Bedrock) is unreachable.
   * Returns the assistant acknowledgement to append; updates route/captured.
   * Does NOT append messages or clear the draft (the caller owns the transcript
   * so both the live and fallback paths render identically).
   */
  function applyFallback(answer: string): string {
    const next = parseRoute(answer, routeState);
    setRouteState(next);

    const lower = answer.toLowerCase();
    let capturedRoute = false;

    setCaptured((prev) => {
      const updated: CapturedCategories = { ...prev };

      if (next.origin && next.destination) {
        updated.route = { from: next.origin, to: next.destination };
        capturedRoute = true;
      }

      const days = durationFromText(answer);
      if (days) updated.dates = `${days} day${days > 1 ? "s" : ""}`;

      const food = detectFoodDietary(lower);
      if (food) updated.foodDietary = food;

      const cabin = detectFlightsClass(lower);
      if (cabin) updated.flightsClass = cabin;

      const joining = detectWhosJoining(lower);
      if (joining) updated.whosJoining = joining;

      const vibe = detectTripVibe(lower);
      if (vibe) updated.tripVibe = vibe;

      const needs = detectSpecialNeeds(lower);
      if (needs) updated.specialNeeds = needs;

      return updated;
    });

    // Mirror whatever the fallback could parse into the shared context too, so
    // navigation to booking pages still prefills (never fabricating fields).
    if (next.origin && next.destination) {
      sharedContext.patchContext({ origin: next.origin, destination: next.destination });
    }

    // Acknowledge what was just captured, reflecting the parsed route when
    // available and otherwise asking a gentle follow-up (Req 21.4).
    return capturedRoute
      ? `Great - ${next.origin} to ${next.destination}. When are you travelling?`
      : "Thanks - tell me a little more and I'll keep filling in your trip.";
  }

  /**
   * Interpret one answer through the real model turn (`POST /api/ai`), which
   * replaces the inline regex parsing (Req 2.2/2.4/4.x). The deterministic
   * preference controller owns flow server-side; here we only mirror the result
   * into the local display `captured` map AND the Shared_Trip_Context, and
   * append the controller's next question as the assistant reply.
   *
   * Resilience: on any network/route error we fall back to the original regex
   * pipeline so the UX is identical whether or not Bedrock is reachable.
   */
  async function submit(text: string) {
    const answer = text.trim();
    if (!answer || pending) return;

    // Append the user's message first, then an INSTANT local acknowledgement so
    // the chat reacts with zero delay (no network wait). The controller's next
    // question is appended afterwards when /api/ai responds.
    const ack = instantAck(answer, routeState);
    setMessages((prev) => [
      ...prev,
      { role: "user", text: answer },
      ...(ack ? [{ role: "assistant" as const, text: ack }] : []),
    ]);
    setDraft("");
    setPending(true);

    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "turn",
          state: controllerState,
          inputDelta: answer,
        }),
      });
      if (!res.ok) throw new Error(`AI turn failed: ${res.status}`);
      const data = (await res.json()) as { response: ControllerResponse };
      const response = data.response;

      // (a) advance the controller state for the next turn.
      setControllerState(response.state);
      // (b) mirror the resulting TripContext into BOTH the local display map
      //     and the shared provider — only present fields, never fabricated.
      const ctx = response.state.context;
      setCaptured((prev) => capturedFromContext(prev, ctx));
      sharedContext.setContext(ctx);
      // Keep the route summary in sync for "Open full planner".
      if (ctx.origin && ctx.destination) {
        setRouteState((prev) => ({
          ...prev,
          origin: ctx.origin as string,
          destination: ctx.destination as string,
          originConfirmed: true,
          destinationConfirmed: true,
          routeCandidate: "",
        }));
      }
      // (c) append the controller's next question / completion text.
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: response.prompt },
      ]);
      redirectIfComplete(ctx);
    } catch {
      // Offline / route failure: run the REAL deterministic controller locally
      // so the flow still advances (step counter + chips + captured all update)
      // exactly as the server would. This is what makes the planner work with no
      // network / no Bedrock. The field the controller is asking about drives a
      // field-aware extraction that rejects greetings and never fabricates.
      const askedField = uncollected(controllerState.context)[0];
      const model = syncFallbackModel(askedField);
      const r = advance(controllerState, answer, model);
      setControllerState(r.state);
      const ctx = r.state.context;
      setCaptured((prev) => capturedFromContext(prev, ctx));
      sharedContext.setContext(ctx);
      if (ctx.origin && ctx.destination) {
        setRouteState((prev) => ({ ...prev, origin: ctx.origin as string, destination: ctx.destination as string, originConfirmed: true, destinationConfirmed: true, routeCandidate: "" }));
      }
      setMessages((prev) => [...prev, { role: "assistant", text: r.prompt }]);
      redirectIfComplete(ctx);
    } finally {
      setPending(false);
    }
  }

  function redirectIfComplete(ctx: TripContext) {
    if (uncollected(ctx).length !== 0) return;
    sharedContext.setContext(ctx);
    window.setTimeout(() => router.push("/trip"), 900);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    void submit(draft);
  }

  /** Reset the whole conversation and captured profile (Req 21.6). */
  function reset() {
    setMessages([{ role: "assistant", text: GREETING }]);
    setRouteState(emptyRouteState());
    setCaptured({});
    setDraft("");
    setControllerState({ context: {}, questionsAsked: 0 });
    sharedContext.reset();
  }

  /** Append an assistant prompt for a category and focus the input (Req 21.6). */
  function changeCategory(prompt: string) {
    setMessages((prev) => [...prev, { role: "assistant", text: prompt }]);
    inputRef.current?.focus();
  }

  /**
   * Voice button (Req 9.x): drives the real Web Speech recognizer through the
   * `useSpeechInput` hook. When the browser has no speech API we stay honest and
   * keep the EXACT existing VOICE_UNAVAILABLE message rather than faking a
   * transcript; otherwise we toggle listening. Recognized transcripts and errors
   * are handled by the hook's `onResult` callback above.
   */
  function handleVoice() {
    if (!speech.supported) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: VOICE_UNAVAILABLE },
      ]);
      inputRef.current?.focus();
      return;
    }
    if (speech.status === "listening") {
      speech.stop();
    } else {
      speech.start();
    }
  }

  // Progress reflects the controller's real field completion so the counter and
  // the "profile ready" state stay in sync (route = origin + destination = 2).
  const totalFields = REQUIRED_FIELDS.length;
  const remainingFields = uncollected(controllerState.context).length;
  const progressCount = totalFields - remainingFields;
  const isComplete = remainingFields === 0;

  // Suggestion chips track the field the assistant is currently asking about,
  // so a tap always offers a valid answer to the live question (falls back to
  // the route examples at the opening turn or once every field is captured).
  const activeSuggestions = useMemo<readonly string[]>(() => {
    const nextField: RequiredField | undefined = uncollected(controllerState.context)[0];
    if (!nextField) return EXAMPLE_PROMPTS;
    if (nextField === "origin" && !controllerState.context.origin && !controllerState.context.destination) {
      return EXAMPLE_PROMPTS;
    }
    return SUGGESTIONS_BY_FIELD[nextField] ?? EXAMPLE_PROMPTS;
  }, [controllerState]);

  const lastUser =
    [...messages].reverse().find((m) => m.role === "user")?.text ?? "";
  const canProceed = Boolean(captured.route);

  function openFullPlanner() {
    const summary = planSummary(routeState, lastUser);
    router.push(`/plan?q=${encodeURIComponent(summary)}`);
  }

  return (
    <div className="concierge-shell">
      {variant === "assistant" && (
        <header className="concierge__pagehead motion-rise">
          <p className="eyebrow">AI Travel Assistant</p>
          <h1 className="concierge__pagetitle">Plan your trip with TripGenie</h1>
          <p className="lead">
            Answer a few short questions and TripGenie builds your trip as you go.
          </p>
        </header>
      )}

      <div className="concierge-editbar">
        <a className="concierge-editbar__link" href="#trip-profile">Edit captured trip details</a>
      </div>

      <section className="concierge grid-2">
        {/* LEFT — conversational planner */}
        <div className="concierge-planner card motion-rise">
          <header className="concierge-planner__header">
            <div className="concierge-planner__heading">
              <p className="eyebrow">Plan with TripGenie</p>
              <p className="lead">Pick a recommendation, or type a short answer.</p>
            </div>
            <div
              className="concierge-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={totalFields}
              aria-valuenow={progressCount}
              aria-label={`Trip details captured: ${progressCount} of ${totalFields}`}
            >
              <span className="concierge-progress__label">
                {progressCount} of {totalFields} captured
              </span>
              <span className="concierge-progress__track" aria-hidden="true">
                <span
                  className="concierge-progress__fill"
                  style={{ width: `${(progressCount / totalFields) * 100}%` }}
                />
              </span>
            </div>
          </header>

          <div
            ref={conversationRef}
            className="concierge-conversation"
            aria-live="polite"
            aria-label="Conversation with TripGenie"
          >
            {messages.map((m, i) => (
              <div
                key={i}
                className={`chat-message concierge-message concierge-message--${m.role}`}
              >
                <span className="chat-message__role">
                  {m.role === "assistant" && (
                    <span className="concierge-message__avatar" aria-hidden="true" />
                  )}
                  {m.role === "assistant" ? "TripGenie" : "You"}
                </span>
                <p className="concierge-message__text">{m.text}</p>
              </div>
            ))}
          </div>

          <div
            className="concierge-chips"
            role="group"
            aria-label="Example prompts"
          >
            {activeSuggestions.map((prompt) => (
              <button
                key={prompt}
                type="button"
                className="chat-chip"
                onClick={() => submit(prompt)}
              >
                {prompt}
              </button>
            ))}
          </div>

          <form className="concierge-composer" onSubmit={handleSubmit}>
            <label className="field concierge-composer__field">
              <span className="sr-only">Your answer</span>
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="From Delhi to Switzerland"
                aria-label="Your answer"
              />
            </label>
            <button
              type="button"
              className="concierge-mic"
              onClick={handleVoice}
              aria-label="Use voice input"
              title="Use voice input"
            >
              <MicIcon />
            </button>
            {/* Bounded in-progress indicator while a planning turn (POST /api/ai)
                is pending (Req 10.1). Reuses the EXISTING `cta` button with the
                same `disabled`/`aria-busy` pattern the planner already uses — no
                new class, token, or layout is introduced. */}
            <button
              type="submit"
              className="cta concierge-composer__submit"
              disabled={pending}
              aria-busy={pending}
            >
              {pending ? "Thinking…" : "Send"}
            </button>
          </form>
        </div>

        {/* RIGHT — Live_Trip_Profile */}
        <aside id="trip-profile" className="card concierge-profile">
          <div className="concierge-profile__header">
            <img
              className="illustration concierge-profile__art"
              src={headerIllustration.src}
              width={headerIllustration.width}
              height={headerIllustration.height}
              alt=""
              aria-hidden="true"
            />
            <h2 className="concierge-profile__title">Your new trip</h2>
            <button type="button" className="btn concierge-profile__reset" onClick={reset}>
              Reset
            </button>
          </div>

          <ul className="concierge-profile__list">
          <li className="concierge-profile__row concierge-profile__row--route">
            <span className="eyebrow concierge-profile__label">Route</span>
            {captured.route ? (
              <span className="concierge-profile__value concierge-profile__value--headline">
                {captured.route.from} → {captured.route.to}
              </span>
            ) : (
              <span className="concierge-profile__value concierge-profile__value--headline concierge-profile__value--muted">
                From? → To?
              </span>
            )}
            <button
              type="button"
              className="btn concierge-profile__change"
              onClick={() =>
                changeCategory("Where are you travelling from and to?")
              }
            >
              Change
            </button>
          </li>

          {CATEGORY_ROWS.map((row) => {
            const value = captured[row.key];
            return (
              <li key={row.key} className="concierge-profile__row">
                <span className="eyebrow concierge-profile__label">{row.label}</span>
                {value ? (
                  <span className="concierge-profile__value">{value}</span>
                ) : (
                  <span className="concierge-profile__value concierge-profile__value--muted">
                    Not shared yet
                  </span>
                )}
                <button
                  type="button"
                  className="btn concierge-profile__change"
                  onClick={() => changeCategory(row.prompt)}
                >
                  Change
                </button>
              </li>
            );
          })}
          </ul>

          <p className="concierge-profile__helper">
            Each answer is captured here. You can change any category.
          </p>

          {variant === "home" && (
            <>
              <button
                type="button"
                className="cta concierge-profile__proceed"
                onClick={openFullPlanner}
                disabled={!canProceed}
                aria-disabled={!canProceed}
              >
                Open full planner
              </button>
              {!canProceed && (
                <p className="concierge-profile__hint">
                  Share where you&apos;re travelling From and To to open the full planner.
                </p>
              )}
            </>
          )}
        </aside>
      </section>
    </div>
  );
}
