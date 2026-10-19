import type { RouteState } from "./types";

/**
 * Route Intake parser (pure) — design section "6. Route Intake".
 * Ported from TripSaathi lib/conversation.ts (mergeTripMessage, shorthandRoute).
 * Separates parsed values from confirmation state.
 * Requirements: 5.1-5.14.
 */

const MAX_LEN = 100;

const titleCase = (v: string): string =>
  v.replace(/\b\w/g, (c) => c.toUpperCase());

const clamp = (v: string): string => titleCase(v.trim()).slice(0, MAX_LEN);

const VERB =
  /\b(?:go|travel(?:ling)?|fly(?:ing)?|visit|heading?|plan(?:ning)?|trip|holiday|vacation|want)\b/i;

export const emptyRouteState = (): RouteState => ({
  origin: "",
  destination: "",
  routeCandidate: "",
  originConfirmed: false,
  destinationConfirmed: false,
});

function shorthandRoute(text: string): RegExpMatchArray | null {
  const m = text
    .trim()
    .match(/^([a-z][a-z .'-]{1,44}?)\s+to\s+([a-z][a-z .'-]{1,44}?)(?:[,.]|$)/i);
  if (!m || VERB.test(m[1])) return null;
  return m;
}

/**
 * Parse a single route utterance into an updated RouteState.
 * Precedence: from-X-to-Y > reverse > shorthand > command-prefix > bare.
 */
export function parseRoute(input: string, state: RouteState): RouteState {
  const next: RouteState = { ...state };
  const text = input ?? "";
  const bare = text.trim();

  // 1. explicit "from X to Y"
  const route = text.match(
    /from\s+([a-z .'-]+?)\s+to\s+([a-z .'-]+?)(?:\s+for|\s+on|\s+between|[,.]|$)/i,
  );
  if (route) {
    next.origin = clamp(route[1]);
    next.destination = clamp(route[2]);
    next.routeCandidate = "";
    next.originConfirmed = true;
    next.destinationConfirmed = true;
    return next;
  }

  // 2. shorthand "X to Y" (verb-guarded)
  const short = shorthandRoute(text);
  if (short) {
    next.origin = clamp(short[1]);
    next.destination = clamp(short[2]);
    next.routeCandidate = "";
    next.originConfirmed = true;
    next.destinationConfirmed = true;
    return next;
  }

  // 3. reverse "Y from X"
  const reverse = text.match(
    /^([a-z .'-]+?)\s+from\s+([a-z .'-]+?)(?:\s+for|\s+on|[,.]|$)/i,
  );
  if (reverse) {
    const dest = reverse[1]
      .replace(/^(plan|visit|explore|go|travel(?:ling)?)\s+/i, "")
      .trim();
    next.destination = clamp(dest);
    next.origin = clamp(reverse[2]);
    next.routeCandidate = "";
    next.originConfirmed = true;
    next.destinationConfirmed = true;
    return next;
  }

  // 4. travel-command prefix → destination-only, prefix stripped
  const command = text.match(
    /^(?:go|travel(?:ling)?|trip|holiday|vacation|visit|fly|heading|plan(?:ning)?)\s+(?:a\s+trip\s+)?to\s+([a-z .'-]+?)(?:\s+from|\s+for|\s+on|[,.]|$)/i,
  );
  if (command) {
    next.destination = clamp(command[1]);
    next.destinationConfirmed = true;
    next.routeCandidate = "";
    if (next.origin) next.originConfirmed = true;
    return next;
  }

  // 5. single bare place name (no direction)
  if (/^[a-z .'-]{2,45}$/i.test(bare)) {
    if (state.destination && !state.origin) {
      next.origin = clamp(bare.replace(/^from\s+/i, ""));
      next.originConfirmed = true;
      next.routeCandidate = "";
      return next;
    }
    if (state.origin && !state.destination) {
      next.destination = clamp(bare.replace(/^to\s+/i, ""));
      next.destinationConfirmed = true;
      next.routeCandidate = "";
      return next;
    }
    next.routeCandidate = clamp(bare);
    return next;
  }

  // 6. unparseable: retain existing origin/destination unchanged
  return next;
}

/** Whether both sides are confirmed and non-empty (Req 5.11). */
export function routeConfirmed(state: RouteState): boolean {
  return Boolean(
    state.origin &&
      state.destination &&
      state.originConfirmed &&
      state.destinationConfirmed,
  );
}
