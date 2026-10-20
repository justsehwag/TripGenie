"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { parseRoute, emptyRouteState, routeConfirmed } from "@/lib/route-intake";
import { durationFromText } from "@/lib/date-intake";
import { illustration } from "@/lib/illustrations";
import type { RouteState } from "@/lib/types";

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
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", text: GREETING },
  ]);
  const [routeState, setRouteState] = useState<RouteState>(emptyRouteState());
  const [captured, setCaptured] = useState<CapturedCategories>({});
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  /** Guards the one-shot seeding so React 18 StrictMode double-mount or any
   *  re-render never replays the seed query more than once. */
  const seededRef = useRef(false);

  // Seed the conversation once from ?q= on the assistant variant so the
  // profile pre-fills from the homepage hand-off (Req 21.10). Empty deps: run
  // at most once on mount; the ref makes it idempotent.
  useEffect(() => {
    if (variant !== "assistant") return;
    if (seededRef.current) return;
    const seed = initialQuery?.trim();
    if (!seed) return;
    seededRef.current = true;
    submit(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const headerIllustration = illustration("location-pin");

  /** Interpret one answer through the existing pipeline and update state. */
  function submit(text: string) {
    const answer = text.trim();
    if (!answer) return;

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

    // Acknowledge what was just captured, reflecting the parsed route when
    // available and otherwise asking a gentle follow-up (Req 21.4).
    const ack = capturedRoute
      ? `Great — ${next.origin} to ${next.destination}. When are you travelling?`
      : "Thanks — tell me a little more and I'll keep filling in your trip.";

    setMessages((prev) => [
      ...prev,
      { role: "user", text: answer },
      { role: "assistant", text: ack },
    ]);
    setDraft("");
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit(draft);
  }

  /** Reset the whole conversation and captured profile (Req 21.6). */
  function reset() {
    setMessages([{ role: "assistant", text: GREETING }]);
    setRouteState(emptyRouteState());
    setCaptured({});
    setDraft("");
  }

  /** Append an assistant prompt for a category and focus the input (Req 21.6). */
  function changeCategory(prompt: string) {
    setMessages((prev) => [...prev, { role: "assistant", text: prompt }]);
    inputRef.current?.focus();
  }

  /**
   * Voice button (UI only, Req 21.7): speech recognition is not wired, so we
   * stay honest — append an assistant note explaining it isn't available and
   * move focus to the text input rather than faking a transcript.
   */
  function handleVoice() {
    setMessages((prev) => [
      ...prev,
      { role: "assistant", text: VOICE_UNAVAILABLE },
    ]);
    inputRef.current?.focus();
  }

  const progressCount = capturedCount(captured);

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
              aria-valuemax={TOTAL_CATEGORIES}
              aria-valuenow={progressCount}
              aria-label={`Trip details captured: ${progressCount} of ${TOTAL_CATEGORIES}`}
            >
              <span className="concierge-progress__label">
                {progressCount} of {TOTAL_CATEGORIES} captured
              </span>
              <span className="concierge-progress__track" aria-hidden="true">
                <span
                  className="concierge-progress__fill"
                  style={{ width: `${(progressCount / TOTAL_CATEGORIES) * 100}%` }}
                />
              </span>
            </div>
          </header>

          <div
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
            {EXAMPLE_PROMPTS.map((prompt) => (
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
            <button type="submit" className="cta concierge-composer__submit">
              Send
            </button>
          </form>
        </div>

        {/* RIGHT — Live_Trip_Profile */}
        <aside className="card concierge-profile">
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
