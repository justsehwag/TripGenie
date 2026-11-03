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
import { useDestinationImage } from "@/components/destination-image";
import { useReveal } from "@/lib/use-reveal";

/** A single conversation turn shown in the planner transcript. */
type ChatMessage = { role: "assistant" | "user"; text: string };

/**
 * One transcript row. Messages render VISIBLE immediately (no opacity-0
 * reveal gate) so a message can never get stuck invisible; a gentle one-time
 * entrance is supplied purely by the `concierge-message` CSS (keyframe),
 * which begins and ends fully opaque. No JS reveal state is used. Hydration-
 * safe: server and first client render produce identical markup.
 */
function ConciergeMessage({ role, text }: ChatMessage) {
  return (
    <div
      className={`chat-message concierge-message concierge-message--${role}`}
    >
      <span className="chat-message__role concierge-message__role">
        {role === "assistant" && (
          <span className="concierge-message__avatar" aria-hidden="true" />
        )}
        {role === "assistant" ? "TripGenie" : "You"}
      </span>
      <p className="concierge-message__text">{text}</p>
    </div>
  );
}

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
 * Decorative line icons for each Live_Trip_Profile category, keyed by the same
 * category key. Presentational only (aria-hidden); they add nothing to the
 * captured data and change no behaviour. Rendered inside the bento tiles.
 */
const CATEGORY_ICON: Record<string, string> = {
  route: "M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z",
  dates: "M7 2v3M17 2v3M3.5 9h17M5 5h14a1.5 1.5 0 0 1 1.5 1.5V19A1.5 1.5 0 0 1 19 20.5H5A1.5 1.5 0 0 1 3.5 19V6.5A1.5 1.5 0 0 1 5 5Z",
  flightsClass: "M21 15.5v-1.8l-8-4.9V3.5a1.5 1.5 0 0 0-3 0v5.3l-8 4.9v1.8l8-2.4v5.1l-2 1.5V21l3.5-1 3.5 1v-1.3l-2-1.5v-5.1l8 2.4Z",
  whosJoining: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 20v-1.5C3 15.5 6 14 9 14s6 1.5 6 4.5V20M15.5 14c2.6.2 5.5 1.6 5.5 4.5V20",
  foodDietary: "M6 3v8a2 2 0 0 0 2 2v8M9 3v6M18 3c-1.6 0-3 2-3 5s1.4 4 3 4v8",
  tripVibe: "M12 3l2.5 5.2 5.7.8-4.1 4 1 5.7L12 21l-5.1 2.7 1-5.7-4.1-4 5.7-.8L12 3Z",
  specialNeeds: "M12 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm-4 6h8M12 10v5l3 5M12 15l-3 5",
};

function CategoryIcon({ k }: { k: string }) {
  const d = CATEGORY_ICON[k] ?? CATEGORY_ICON.route;
  return (
    <svg className="trip-bento__icon" viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

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
 * The immersive hero's right column (Task 7.1). Fetches a REAL destination
 * photo client-side via the existing `/api/image` route (through the shared
 * `useDestinationImage` hook), framed inside a fixed-aspect `.image-frame` so
 * there is no CLS. Until a real image resolves — and if the fetch fails —
 * it renders the local `traveler-globe` illustration framed identically, so
 * the frame is NEVER a broken or empty image.
 *
 * Hydration safety: `useDestinationImage` starts with `url: null` and only
 * fetches inside `useEffect` after mount, so the server render and the first
 * client render are identical (the illustration). No time/random value is used
 * during render.
 */
function HeroImage({ query }: { query: string }) {
  const { url, alt } = useDestinationImage(query, 0);
  const fallback = illustration("traveler-globe");
  return (
    <div className="image-frame concierge-hero__frame">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="concierge-hero__photo"
          src={url}
          alt={alt || query}
          loading="eager"
          decoding="async"
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="concierge-hero__photo concierge-hero__photo--illustration"
          src={fallback.src}
          width={fallback.width}
          height={fallback.height}
          alt={fallback.alt}
        />
      )}
      <span className="concierge-hero__scrim" aria-hidden="true" />
    </div>
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
  /** Seed a destination directly from a Discover hand-off (/plan?dest=). */
  initialDestination?: string;
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
  initialDestination,
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
  /** Reveal container for the immersive home hero's staggered entrance (Task
   *  7.1). SSR-safe: the hook adds `.reveal--in` only after mount, so the
   *  server render is stable. */
  const heroRevealRef = useReveal<HTMLElement>();

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

  // Seed the conversation once on mount for the assistant variant. A
  // destination from Discover (/plan?dest=) is seeded DIRECTLY into the
  // controller + shared context so the assistant is immediately aware of the
  // picked place and asks only for the REMAINING details (never restarting,
  // never mis-reading the place as the origin). A legacy ?q= hand-off still
  // runs through submit(). Empty deps + ref make it idempotent.
  useEffect(() => {
    if (variant !== "assistant") return;
    if (seededRef.current) return;
    const dest = initialDestination?.trim();
    if (dest) {
      seededRef.current = true;
      const ctx: TripContext = { ...controllerState.context, destination: dest };
      setControllerState((prev) => ({ ...prev, context: ctx }));
      sharedContext.patchContext({ destination: dest });
      setCaptured((prev) => capturedFromContext(prev, ctx));
      setRouteState((prev) => ({ ...prev, destination: dest, destinationConfirmed: true, routeCandidate: "" }));
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: `Great choice - ${dest}! Which city are you travelling from?` },
      ]);
      return;
    }
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

    // Append ONLY the user's message. Exactly one assistant reply is appended
    // per turn (the controller's next question from /api/ai, or the offline
    // fallback). The earlier instant local acknowledgement was removed because
    // it produced a SECOND assistant bubble for every single turn.
    setMessages((prev) => [
      ...prev,
      { role: "user", text: answer },
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

  // Hero image query (Task 7.1): prefer a captured destination so the hero
  // reflects the real trip in progress, otherwise a stable editorial default.
  // This is a plain derived string (no time/random), so it is identical on the
  // server and the first client render — the actual photo loads post-mount.
  const heroImageQuery = (captured.route?.to ?? "scenic travel destination").trim();

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

      {variant === "home" && (
        <header
          ref={heroRevealRef}
          className="concierge-hero"
          aria-label="Plan your trip with TripGenie"
        >
          {/* LEFT — editorial copy + the trip-intent input (reuses the existing
              draft/submit pipeline, so validation and navigation are unchanged).
              Each element reveals in sequence via an incremental transition-delay
              that is a multiple of --anim-stagger-step. The orange Primary_Action
              is interactive immediately and is NEVER gated behind the animation. */}
          <div className="concierge-hero__content">
            <p
              className="eyebrow reveal concierge-hero__eyebrow"
              style={{ transitionDelay: "calc(var(--anim-stagger-step) * 0)" }}
            >
              <span className="ai-pulse concierge-hero__pulse" aria-hidden="true" />
              AI travel concierge
            </p>
            <h1
              className="display concierge-hero__title reveal"
              style={{ transitionDelay: "calc(var(--anim-stagger-step) * 1)" }}
            >
              Plan the whole trip in one conversation.
            </h1>
            <p
              className="lead concierge-hero__lead reveal"
              style={{ transitionDelay: "calc(var(--anim-stagger-step) * 2)" }}
            >
              Tell TripGenie where you&apos;re headed and it designs flights,
              stays and a day-by-day itinerary around how you like to travel.
            </p>
            <form
              className="concierge-hero__form reveal"
              style={{ transitionDelay: "calc(var(--anim-stagger-step) * 3)" }}
              onSubmit={handleSubmit}
            >
              <label className="field concierge-hero__field">
                <span className="sr-only">Where are you travelling from and to?</span>
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="From Delhi to Switzerland"
                  aria-label="Where are you travelling from and to?"
                />
              </label>
              <button
                type="submit"
                className="cta concierge-hero__submit"
                disabled={pending}
                aria-busy={pending}
              >
                {pending ? "Thinking\u2026" : "Start planning"}
              </button>
            </form>
          </div>

          {/* RIGHT — immersive real-imagery frame with the illustration fallback. */}
          <div
            className="concierge-hero__media reveal"
            style={{ transitionDelay: "calc(var(--anim-stagger-step) * 4)" }}
          >
            <HeroImage query={heroImageQuery} />
          </div>
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
              <ConciergeMessage key={i} role={m.role} text={m.text} />
            ))}

            {/* Honest in-progress indicator (Req 4.3, 4.5). It is rendered ONLY
                while the existing `pending` flag is true — i.e. strictly between
                firing the single `POST /api/ai` for this turn and its
                resolution (success, fallback, or error) — and disappears the
                instant the turn resolves. It is an INDETERMINATE indicator (the
                emerald `.ai-pulse` breathing dot + a "Thinking…" label); it does
                NOT fabricate discrete advancing stages, uses NO timer, and adds
                NO artificial delay. It never implies completion while the
                request is still running. */}
            {pending && (
              <div
                className="concierge-message concierge-message--assistant concierge-thinking"
                role="status"
                aria-live="polite"
              >
                <span className="chat-message__role concierge-message__role">
                  <span className="concierge-message__avatar" aria-hidden="true" />
                  TripGenie
                </span>
                <p className="concierge-thinking__row">
                  <span className="ai-pulse concierge-thinking__pulse" aria-hidden="true" />
                  <span className="concierge-thinking__label">Thinking{"\u2026"}</span>
                </p>
              </div>
            )}
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
                className="chat-chip press"
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
              {pending ? "Thinking\u2026" : "Send"}
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

          <div className="trip-bento" role="list">
            <div
              className="trip-bento__tile trip-bento__tile--route"
              role="listitem"
              data-filled={captured.route ? "true" : "false"}
            >
              <span className="trip-bento__head">
                <CategoryIcon k="route" />
                <span className="trip-bento__label">Route</span>
              </span>
              {captured.route ? (
                <span className="trip-bento__value trip-bento__value--headline">
                  {captured.route.from} <span aria-hidden="true">{"\u2192"}</span> {captured.route.to}
                </span>
              ) : (
                <span className="trip-bento__value trip-bento__value--headline trip-bento__value--muted">
                  From? <span aria-hidden="true">{"\u2192"}</span> To?
                </span>
              )}
              <button
                type="button"
                className="trip-bento__change"
                onClick={() => changeCategory("Where are you travelling from and to?")}
              >
                Change
              </button>
            </div>

            {CATEGORY_ROWS.map((row) => {
              const value = captured[row.key];
              return (
                <div
                  key={row.key}
                  className="trip-bento__tile"
                  role="listitem"
                  data-filled={value ? "true" : "false"}
                >
                  <span className="trip-bento__head">
                    <CategoryIcon k={row.key} />
                    <span className="trip-bento__label">{row.label}</span>
                  </span>
                  {value ? (
                    <span className="trip-bento__value">{value}</span>
                  ) : (
                    <span className="trip-bento__value trip-bento__value--muted">Not shared yet</span>
                  )}
                  <button
                    type="button"
                    className="trip-bento__change"
                    onClick={() => changeCategory(row.prompt)}
                  >
                    Change
                  </button>
                </div>
              );
            })}
          </div>

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
